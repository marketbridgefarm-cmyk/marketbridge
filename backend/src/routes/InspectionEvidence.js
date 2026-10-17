'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { buildBuyerReportEnvelope } = require('../utils/reportContract');
const { releaseWaitingInspectors } = require('../services/waitingListService');
const { computeInspectionCompletionDueAt } = require('../utils/orderTiming');
const { recordReportSubmitted } = require('../services/inspectionArrivalService');

// ============================================================================
// INSPECTION EVIDENCE + REPORT
// ----------------------------------------------------------------------------
// Photos, videos, handover notes, and the final report attached to an
// inspection request. Extracted from routes/inspections.js so the
// inspection lifecycle file stays focused on the request state machine.
//
// Same paths, same responses, same validation — pure relocation.
// ============================================================================

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
};

// ============================================================================
// ACCESS HELPERS
// ============================================================================

async function canAccessInspection(req, requestId) {
  const request = await prisma.inspectionRequest.findUnique({
    where: { id: requestId },
    include: {
      listing: { select: { sellerId: true } },
      report: true,
      order: { select: { buyerId: true } },
    },
  });
  if (!request) return { request: null, allowed: false };
  const allowed =
    req.user.roles.includes('ADMIN') ||
    request.requestedById === req.user.id ||
    request.inspectorId === req.user.id ||
    request.listing.sellerId === req.user.id ||
    request.order?.buyerId === req.user.id;
  return { request, allowed };
}

async function buyerCanSeeInspectionMedia(request, userId, userRoles) {
  const isAdmin = Array.isArray(userRoles) && userRoles.includes('ADMIN');
  if (isAdmin) return true;

  const isBuyer = request.order?.buyerId === userId;
  if (!isBuyer) return true;
  if (!request.orderId) return false;

  const paid = await prisma.payment.findFirst({
    where: { orderId: request.orderId, type: 'MARKETPLACE', status: 'PAID' },
    select: { id: true },
  });
  return Boolean(paid);
}

// ============================================================================
// LIST EVIDENCE
// ============================================================================

router.get('/:id/evidence', authenticate, async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });
    if (!access.request.report) return res.json({ evidence: [] });

    const mediaAllowed = await buyerCanSeeInspectionMedia(
      access.request,
      req.user.id,
      req.user.roles
    );

    const evidence = await prisma.inspectionEvidence.findMany({
      where: { reportId: access.request.report.id },
      select: { id: true, reportId: true, type: true, photos: true, videos: true, gpsLocation: true, notes: true, capturedAt: true, createdById: true },
      orderBy: { capturedAt: 'asc' },
    });

    const sanitized = mediaAllowed
      ? evidence
      : evidence.map((row) => ({
          ...row,
          photos: [],
          videos: [],
          mediaLocked: true,
        }));

    return res.json({ evidence: sanitized, mediaAllowed });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTION EVIDENCE ERROR:');
    return res.status(500).json({ error: 'Could not load inspection evidence' });
  }
});

// ============================================================================
// SIGN EVIDENCE MEDIA
// ============================================================================

router.get('/:id/evidence/:evidenceId/media', authenticate, [
  param('id').notEmpty(),
  param('evidenceId').notEmpty(),
], async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });

    const mediaAllowed = await buyerCanSeeInspectionMedia(
      access.request,
      req.user.id,
      req.user.roles
    );
    if (!mediaAllowed) {
      return res.status(402).json({
        code: 'MEDIA_LOCKED_UNTIL_PAYMENT',
        error: 'Inspection photos and videos become available to the buyer once the goods payment is settled.',
      });
    }

    const evidence = await prisma.inspectionEvidence.findFirst({
      where: { id: req.params.evidenceId, reportId: access.request.report?.id || '__none__' },
    });
    if (!evidence) return res.status(404).json({ error: 'Inspection evidence not found' });

    const sign = async (ref, kind, index) => {
      const metadata = await privateMediaMetadata(ref);
      const url = await signedMediaUrl({
        key: metadata.key,
        fileName: `${kind.toLowerCase()}-${evidence.id}-${index + 1}`,
        contentType: metadata.contentType || undefined,
      });
      return { index, url, key: metadata.key, contentType: metadata.contentType, size: metadata.contentLength, etag: metadata.etag, lastModified: metadata.lastModified };
    };

    const media = { photos: [], videos: [], unsupported: [] };
    for (let i = 0; i < evidence.photos.length; i += 1) {
      try { media.photos.push(await sign(evidence.photos[i], 'photo', i)); }
      catch (error) { media.unsupported.push({ kind: 'photo', index: i, reason: error.message }); }
    }
    for (let i = 0; i < evidence.videos.length; i += 1) {
      try { media.videos.push(await sign(evidence.videos[i], 'video', i)); }
      catch (error) { media.unsupported.push({ kind: 'video', index: i, reason: error.message }); }
    }

    await prisma.auditEvent.create({
      data: {
        actorId: req.user.id,
        action: 'INSPECTION_EVIDENCE_MEDIA_ACCESSED',
        resourceType: 'InspectionEvidence',
        resourceId: evidence.id,
        metadata: { inspectionRequestId: access.request.id, photoCount: media.photos.length, videoCount: media.videos.length, unsupportedCount: media.unsupported.length },
      },
    });

    return res.json({ evidenceId: evidence.id, expiresInSeconds: Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900), media });
  } catch (error) {
    req.log.error({ err: error }, 'SIGN INSPECTION EVIDENCE MEDIA ERROR:');
    return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
  }
});

// ============================================================================
// UPLOAD EVIDENCE MEDIA
// ============================================================================

router.post('/:id/evidence/media', authenticate, requireRole('INSPECTOR'), evidenceUpload.array('files', 5), async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!['IN_PROGRESS', 'COMPLETED'].includes(request.status)) {
      return res.status(409).json({ error: 'Evidence can only be added while the inspection is in progress or completed.' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'At least one file is required' });

    const { photoKeys, videoKeys } = await uploadEvidenceFiles('inspection', request.id, req.files);

    return res.status(201).json({ photoKeys, videoKeys });
  } catch (error) {
    req.log.error({ err: error }, 'UPLOAD INSPECTION EVIDENCE MEDIA ERROR:');
    return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
  }
});

// ============================================================================
// CREATE EVIDENCE RECORD
// ============================================================================

router.post('/:id/evidence', authenticate, requireRole('INSPECTOR'), [
  param('id').notEmpty(),
  body('photos').optional().isArray().withMessage('photos must be an array'),
  body('videos').optional().isArray().withMessage('videos must be an array'),
  body('gpsLocation').optional({ nullable: true }).isString(),
  body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('capturedAt').optional({ nullable: true }).isISO8601().withMessage('capturedAt must be a valid ISO date'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { report: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!['IN_PROGRESS', 'COMPLETED'].includes(request.status)) {
      return res.status(409).json({ error: 'Evidence can only be added while the inspection is in progress or completed.' });
    }
    if (!request.report) return res.status(400).json({ error: 'Submit the inspection report before adding supplemental evidence' });
    const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
    const videos = Array.isArray(req.body.videos) ? req.body.videos : [];
    const gpsLocation = req.body.gpsLocation || null;
    const notes = req.body.notes || null;
    if (!photos.length && !videos.length && !gpsLocation && !notes) return res.status(400).json({ error: 'Evidence must contain a photo, video, GPS location, or notes' });
    const evidence = await prisma.$transaction(async (tx) => {
      const created = await tx.inspectionEvidence.create({
        data: { reportId: request.report.id, type: 'ADDITIONAL', photos, videos, gpsLocation, notes, capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(), createdById: req.user.id },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_EVIDENCE_ADDED', resourceType: 'InspectionEvidence', resourceId: created.id, metadata: { inspectionRequestId: request.id, reportId: request.report.id, type: created.type } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    return res.status(201).json({ evidence });
  } catch (error) {
    req.log.error({ err: error }, 'ADD INSPECTION EVIDENCE ERROR:');
    return res.status(500).json({ error: 'Could not add inspection evidence' });
  }
});

// ============================================================================
// SUBMIT INSPECTION REPORT
// ============================================================================

router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [
    body('quantity').isFloat({ gt: 0 }).withMessage('Verified quantity must be greater than zero'),
    body('grade').optional({ nullable: true }).isString(),
    body('moisture').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('moisture must be zero or greater'),
    body('visibleDefects').optional({ nullable: true }).isString(),
    body('damageNotes').optional({ nullable: true }).isString(),
    body('packagingNotes').optional({ nullable: true }).isString(),
    body('assessmentSummary').optional({ nullable: true }).isString().trim().isLength({ max: 3000 }),
    body('qualityFlags').optional().isArray().withMessage('qualityFlags must be an array'),
    body('gpsLocation').optional({ nullable: true }).isString(),
    body('photos').optional().isArray().withMessage('photos must be an array'),
    body('videos').optional().isArray().withMessage('videos must be an array'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: errors.array()[0]?.msg || 'Validation failed',
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
        include: { report: true, listing: { select: { quantity: true, unit: true, category: true } } },
      });

      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can submit this report' });
      if (request.status !== 'IN_PROGRESS') return res.status(400).json({ error: `Inspection must be IN_PROGRESS before submitting a report. Current status: ${request.status}` });
      if (!request.sellerConfirmedAt) return res.status(409).json({ error: 'Seller confirmation is required before submitting an inspection report.' });
      if (!request.inspectorOnSiteConfirmedAt) {
        return res.status(409).json({
          code: 'INSPECTOR_ARRIVAL_NOT_CONFIRMED',
          error: 'Inspector arrival must be confirmed by the seller before a report can be submitted.',
        });
      }
      if (request.report) return res.status(409).json({ error: 'An inspection report has already been submitted' });

      const reportObligations = request.orderId
        ? await prisma.paymentObligation.findMany({ where: { orderId: request.orderId, inspectionRequestId: request.id, type: 'INSPECTOR' }, select: { status: true } })
        : [];
      const reportPaid = reportObligations.length
        ? reportObligations.every((o) => o.status === 'PAID')
        : (await prisma.payment.findFirst({ where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'PAID' }, select: { id: true } })) != null;
      if (!reportPaid) return res.status(402).json({ code: 'INSPECTION_PAYMENT_REQUIRED', error: 'The inspection fee must be fully paid before the report can be submitted.' });

      const orderForReport = await prisma.order.findUnique({
        where: { id: request.orderId },
        select: { status: true },
      });
      if (orderForReport && ['DISPUTED', 'CANCELLED'].includes(orderForReport.status)) {
        return res.status(409).json({
          error: `This order is ${orderForReport.status.toLowerCase()}, so a report cannot be submitted until that is resolved.`,
        });
      }

      const {
        quantity, grade, moisture, visibleDefects, damageNotes, packagingNotes, assessmentSummary, qualityFlags, photos, videos, gpsLocation,
      } = req.body;

      const report = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'a report cannot be submitted until that is resolved');

        const createdReport = await tx.inspectionReport.create({
          data: {
            requestId: request.id,
            quantity: Number(quantity),
            grade: grade || null,
            moisture: moisture !== undefined && moisture !== null && moisture !== '' ? Number(moisture) : null,
            visibleDefects: visibleDefects || null,
            damageNotes: damageNotes || null,
            packagingNotes: packagingNotes || null,
            assessmentSummary: assessmentSummary || null,
            qualityFlags: Array.isArray(qualityFlags) ? qualityFlags.map((v) => String(v).trim()).filter(Boolean).slice(0, 20) : [],
            quantityVariancePercent: (() => {
              const listingQuantity = Number(request.listing?.quantity || 0);
              return listingQuantity > 0 ? ((Number(quantity) - listingQuantity) / listingQuantity) * 100 : null;
            })(),
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
          },
        });

        await tx.inspectionEvidence.create({
          data: {
            reportId: createdReport.id,
            type: 'REPORT',
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
            notes: [visibleDefects, damageNotes, packagingNotes].filter(Boolean).join('\n') || null,
            capturedAt: createdReport.inspectedAt,
            createdById: req.user.id,
          },
        });

        const completed = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'IN_PROGRESS',
          },
          data: { status: 'COMPLETED', completedAt: new Date(), completionDueAt: null },
        });

        if (completed.count !== 1) {
          throw new Error('INSPECTION_STATUS_CHANGED');
        }

        // Reliability: report turnaround, from the start of the visit.
        await recordReportSubmitted(tx, {
          inspectorId: req.user.id,
          from: request.startedAt || request.inspectorOnSiteConfirmedAt,
          to: new Date(),
        });

        const relatedOrders = await tx.order.findMany({
          where: { id: request.orderId },
          select: { id: true },
        });
        for (const relatedOrder of relatedOrders) {
          await syncOrderPaymentObligations(tx, relatedOrder.id);
          await recordOrderEvent(tx, {
            orderId: relatedOrder.id,
            actorId: req.user.id,
            type: 'INSPECTION_COMPLETED',
            metadata: { inspectionRequestId: request.id, reportId: createdReport.id },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REPORT_SUBMITTED',
          resourceType: 'InspectionReport',
          resourceId: createdReport.id,
          metadata: { inspectionRequestId: request.id, quantity: createdReport.quantity },
        });

        return createdReport;
      }, {
        maxWait: 10000,
        timeout: 15000,
      });

      await releaseWaitingInspectors(prisma, {
        inspectionRequestId: request.id,
        actorId: req.user.id,
        reason: 'INSPECTION_COMPLETED',
      });

      return res.status(201).json({ report, reportEnvelope: buildBuyerReportEnvelope(report, 'INSPECTION') });
    } catch (error) {
      if (error.message === 'INSPECTION_STATUS_CHANGED') {
        return res.status(409).json({ error: 'Inspection status changed before the report could be completed' });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      req.log.error({ err: error }, 'CREATE INSPECTION REPORT ERROR:');
      return res.status(500).json({
        error: error.message || 'Could not submit inspection report',
        requestId: req.requestId,
      });
    }
  }
);

// ============================================================================
// REPORT ADDENDUM
// ============================================================================

router.post('/:id/report/addenda', authenticate, requireRole('INSPECTOR'), [
  body('reason').isString().trim().isLength({ min: 3, max: 500 }),
  body('notes').isString().trim().isLength({ min: 3, max: 3000 }),
  body('photos').optional().isArray(),
  body('videos').optional().isArray(),
  body('gpsLocation').optional({ nullable: true }).isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed' });
    const request = await prisma.inspectionRequest.findUnique({
      where: { id: req.params.id },
      include: { report: true },
    });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add a report addendum' });
    if (request.status !== 'COMPLETED' || !request.report) return res.status(409).json({ error: 'A report addendum is available only after the original report is completed' });

    const addendum = await prisma.$transaction(async (tx) => {
      const created = await tx.inspectionReportAddendum.create({
        data: {
          reportId: request.report.id,
          createdById: req.user.id,
          reason: req.body.reason,
          notes: req.body.notes,
          photos: Array.isArray(req.body.photos) ? req.body.photos : [],
          videos: Array.isArray(req.body.videos) ? req.body.videos : [],
          gpsLocation: req.body.gpsLocation || null,
        },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_REPORT_ADDENDUM_CREATED', resourceType: 'InspectionReportAddendum', resourceId: created.id, metadata: { inspectionRequestId: request.id, reportId: request.report.id } });
      if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: req.user.id, type: 'INSPECTION_REPORT_ADDENDUM_ADDED', metadata: { inspectionRequestId: request.id, reportId: request.report.id, addendumId: created.id } });
      return created;
    });
    return res.status(201).json({ message: 'Report addendum recorded. The original report remains unchanged.', addendum });
  } catch (error) {
    req.log.error({ err: error }, 'CREATE INSPECTION REPORT ADDENDUM ERROR');
    return res.status(500).json({ error: 'Could not create inspection report addendum' });
  }
});

module.exports = router;
