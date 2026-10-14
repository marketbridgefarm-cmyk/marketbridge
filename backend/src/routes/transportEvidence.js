'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { recordAuditEvent } = require('../utils/audit');
const { isOrderParticipant, isAdmin } = require('../utils/authorization');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');

// ============================================================================
// TRANSPORT EVIDENCE
// ----------------------------------------------------------------------------
// Photos, videos, and handover notes attached to a transport job.
//
// Extracted from routes/transport.js so the transport lifecycle file stays
// focused on the job state machine. Same paths, same responses, same
// validation — pure relocation, no behavior change.
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

router.post(
  '/:id/evidence/media',
  authenticate,
  [param('id').isUUID()],
  validate,
  evidenceUpload.array('files', 5),
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' &&
          (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized to add transport evidence' });
      }

      if (job.status === 'CANCELLED') {
        return res.status(400).json({ error: 'Cannot add evidence to a cancelled transport job' });
      }

      if (!req.files?.length) {
        return res.status(400).json({ error: 'At least one file is required' });
      }

      const { photoKeys, videoKeys } = await uploadEvidenceFiles('transport', job.id, req.files);

      return res.status(201).json({ photoKeys, videoKeys });
    } catch (error) {
      req.log.error({ err: error }, 'UPLOAD TRANSPORT EVIDENCE MEDIA ERROR:');
      return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
    }
  }
);

router.post(
  '/:id/evidence',
  authenticate,
  [
    param('id').isUUID(),
    body('type').isIn(['PICKUP', 'DELIVERY', 'INCIDENT']),
    body('photos').optional().isArray(),
    body('videos').optional().isArray(),
    body('gpsLocation').optional().isString().trim(),
    body('notes').optional().isString().trim(),
    body('capturedAt').optional().isISO8601(),
  ],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' &&
          (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized to add transport evidence' });
      }

      if (job.status === 'CANCELLED') {
        return res.status(400).json({ error: 'Cannot add evidence to a cancelled transport job' });
      }

      const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
      const videos = Array.isArray(req.body.videos) ? req.body.videos.filter(Boolean) : [];
      const notes = req.body.notes?.trim() || null;
      const gpsLocation = req.body.gpsLocation?.trim() || null;

      if (!photos.length && !videos.length && !notes && !gpsLocation) {
        return res.status(400).json({
          error: 'At least one evidence item (photo, video, GPS or notes) is required',
        });
      }

      const evidence = await prisma.$transaction(async (tx) => {
        const created = await tx.transportEvidence.create({
          data: {
            transportJobId: job.id,
            type: req.body.type,
            photos, videos, gpsLocation, notes,
            capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(),
            createdById: req.user.id,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_EVIDENCE_ADDED',
          resourceType: 'TransportEvidence',
          resourceId: created.id,
          metadata: {
            transportJobId: job.id, orderId: job.orderId, type: created.type,
            photoCount: photos.length, videoCount: videos.length, hasGps: Boolean(gpsLocation),
          },
        });

        return created;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ evidence });
    } catch (error) {
      req.log.error({ err: error }, 'ADD TRANSPORT EVIDENCE ERROR:');
      return res.status(500).json({ error: 'Could not add transport evidence' });
    }
  }
);

router.get(
  '/:id/evidence',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isParticipant = isOrderParticipant(req.user.id, job.order);
      if (!isParticipant && !isAdmin(req) && job.truckOwnerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const evidence = await prisma.transportEvidence.findMany({
        where: { transportJobId: job.id },
        orderBy: { capturedAt: 'asc' },
      });

      return res.json({ evidence });
    } catch (error) {
      req.log.error({ err: error }, 'LIST TRANSPORT EVIDENCE ERROR:');
      return res.status(500).json({ error: 'Could not load transport evidence' });
    }
  }
);

router.get(
  '/:id/evidence/:evidenceId/media',
  authenticate,
  [param('id').isUUID(), param('evidenceId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });
      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isParticipant = isOrderParticipant(req.user.id, job.order);
      if (!isParticipant && !isAdmin(req) && job.truckOwnerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const evidence = await prisma.transportEvidence.findFirst({
        where: { id: req.params.evidenceId, transportJobId: job.id },
      });
      if (!evidence) return res.status(404).json({ error: 'Transport evidence not found' });

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
          action: 'TRANSPORT_EVIDENCE_MEDIA_ACCESSED',
          resourceType: 'TransportEvidence',
          resourceId: evidence.id,
          metadata: { transportJobId: job.id, orderId: job.orderId, photoCount: media.photos.length, videoCount: media.videos.length, unsupportedCount: media.unsupported.length },
        },
      });

      return res.json({ evidenceId: evidence.id, expiresInSeconds: Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900), media });
    } catch (error) {
      req.log.error({ err: error }, 'SIGN TRANSPORT EVIDENCE MEDIA ERROR:');
      return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
    }
  }
);

module.exports = router;
