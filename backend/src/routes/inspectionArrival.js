'use strict';

// ============================================================================
// INSPECTION ARRIVAL, REPORT ACCEPTANCE AND RELIABILITY ROUTES
// ============================================================================
// Mounted at /api/inspections (see src/index.js).
//
//   GET  /:id/arrival            what the caller may see (seller also gets the handshake code)
//   POST /:id/arrival/check-in   inspector: GPS + photo (+ optional 4-digit code), multipart
//   GET  /:id/arrival/photo      signed link to the check-in photo (seller, inspector, admin)
//   POST /:id/arrival/confirm    seller: "Yes, they're here"
//   POST /:id/arrival/dispute    seller: closed-reason dispute -> admin queue
//   POST /:id/report/accept      buyer: accept the report (releases the inspector fee)
//   GET  /reliability/me         inspector: own reliability summary
// ============================================================================

const express = require('express');
const { body, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const arrival = require('../services/inspectionArrivalService');
const logic = require('../services/inspectionArrivalLogic');

const router = express.Router();

function sendError(req, res, error, label) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  req.log.error({ err: error }, label);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ── View ────────────────────────────────────────────────────────────────────

router.get('/reliability/me', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  try {
    const map = await arrival.reliabilityFor(prisma, [req.user.id]);
    return res.json({ reliability: map.get(req.user.id) });
  } catch (error) {
    return sendError(req, res, error, 'INSPECTOR RELIABILITY ERROR');
  }
});

router.get('/:id/arrival', authenticate, async (req, res) => {
  try {
    const view = await arrival.getArrivalView(prisma, { requestId: req.params.id, user: req.user });
    return res.json(view);
  } catch (error) {
    return sendError(req, res, error, 'ARRIVAL VIEW ERROR');
  }
});

// ── Inspector check-in ──────────────────────────────────────────────────────

router.post(
  '/:id/arrival/check-in',
  authenticate,
  requireRole('INSPECTOR'),
  evidenceUpload.array('files', 1),
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
        select: { id: true, inspectorId: true },
      });
      if (!request) return res.status(404).json({ error: 'Inspection request not found' });
      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({ error: 'Only the assigned inspector can check in' });
      }
      const files = (req.files || []).filter((f) => String(f.mimetype).startsWith('image/'));
      if (!files.length) {
        return res.status(400).json({ error: 'Take a photo of the goods or the site to check in.', code: 'PHOTO_REQUIRED' });
      }
      if (!logic.validCoordinate(req.body.latitude, req.body.longitude)) {
        return res.status(400).json({ error: 'A valid GPS location is required to check in. Turn on location and try again.', code: 'GPS_REQUIRED' });
      }

      // Upload only after the cheap checks pass so rejected requests leave nothing behind.
      const { photoKeys } = await uploadEvidenceFiles('inspection-arrival', request.id, files);

      const result = await arrival.checkIn(prisma, {
        requestId: request.id,
        user: req.user,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        accuracyMeters: req.body.accuracy,
        photoKeys,
        code: req.body.code,
      });

      if (!result.ok) {
        return res.status(400).json({
          error: `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left. You can also check in without a code and the seller will be asked to confirm.`,
          code: result.code,
          attemptsLeft: result.attemptsLeft,
        });
      }

      return res.status(201).json({
        message: result.confirmed
          ? 'Arrival confirmed with the handshake code. The inspection fee can now be paid.'
          : 'Checked in. The seller has been asked to confirm; if they do not answer in time your arrival is confirmed automatically.',
        confirmed: result.confirmed,
        status: result.arrival.status,
        disputeWindowEndsAt: result.arrival.disputeWindowEndsAt,
      });
    } catch (error) {
      return sendError(req, res, error, 'ARRIVAL CHECK-IN ERROR');
    }
  }
);

// ── Check-in photo (signed, short-lived) ────────────────────────────────────

router.get('/:id/arrival/photo', authenticate, async (req, res) => {
  try {
    const view = await arrival.getArrivalView(prisma, { requestId: req.params.id, user: req.user });
    // The buyer and requester do not need the site photo; the seller, inspector and admin do.
    const isAdmin = (req.user.roles || []).includes('ADMIN');
    const record = await prisma.inspectionArrival.findUnique({
      where: { inspectionRequestId: req.params.id },
      include: { inspectionRequest: { select: { inspectorId: true, order: { select: { sellerId: true } } } } },
    });
    if (!record || record.inspectorId !== record.inspectionRequest.inspectorId || !view.arrival) {
      return res.status(404).json({ error: 'No check-in photo' });
    }
    const allowed = isAdmin
      || record.inspectionRequest.order?.sellerId === req.user.id
      || record.inspectorId === req.user.id;
    if (!allowed) return res.status(403).json({ error: 'You do not have access to this photo' });

    const photos = [];
    for (let i = 0; i < record.photoKeys.length; i += 1) {
      const metadata = await privateMediaMetadata(record.photoKeys[i]);
      photos.push({
        index: i,
        url: await signedMediaUrl({ key: metadata.key, fileName: `arrival-${record.id}-${i + 1}`, contentType: metadata.contentType || undefined }),
      });
    }
    await recordAuditEvent(prisma, {
      actorId: req.user.id,
      action: 'INSPECTION_ARRIVAL_PHOTO_ACCESSED',
      resourceType: 'InspectionArrival',
      resourceId: record.id,
      metadata: { count: photos.length },
    });
    return res.json({ photos });
  } catch (error) {
    if (error.statusCode) return sendError(req, res, error);
    req.log.error({ err: error }, 'ARRIVAL PHOTO ERROR');
    return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
  }
});

// ── Seller response ─────────────────────────────────────────────────────────

router.post('/:id/arrival/confirm', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    await arrival.sellerConfirm(prisma, { requestId: req.params.id, user: req.user });
    return res.json({ message: 'Thanks. The inspector is confirmed on site and the inspection fee can now be paid.' });
  } catch (error) {
    return sendError(req, res, error, 'ARRIVAL CONFIRM ERROR');
  }
});

router.post(
  '/:id/arrival/dispute',
  authenticate,
  requireRole('SELLER'),
  [body('reason').isIn(arrival.DISPUTE_REASONS).withMessage('Choose one of the listed reasons.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, code: 'INVALID_REASON' });
    try {
      await arrival.sellerDispute(prisma, { requestId: req.params.id, user: req.user, reason: req.body.reason });
      return res.json({ message: 'Dispute recorded. MarketBridge will review the inspector\'s GPS location and photo.' });
    } catch (error) {
      return sendError(req, res, error, 'ARRIVAL DISPUTE ERROR');
    }
  }
);

// ── Report acceptance ───────────────────────────────────────────────────────

router.post('/:id/report/accept', authenticate, async (req, res) => {
  try {
    const result = await arrival.acceptReport(prisma, { requestId: req.params.id, user: req.user });
    return res.json({ message: 'Report accepted. The inspector\'s fee has been released.', ...result });
  } catch (error) {
    return sendError(req, res, error, 'REPORT ACCEPT ERROR');
  }
});

module.exports = router;
