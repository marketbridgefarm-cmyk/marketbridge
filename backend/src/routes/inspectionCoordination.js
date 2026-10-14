'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { recordAuditEvent } = require('../utils/audit');
const {
  assertCoordinationStage,
  viewerRoleFor,
  ensureOpenCoordination,
} = require('../services/inspectionCoordinationService');

// ============================================================================
// INSPECTION COORDINATION
// ----------------------------------------------------------------------------
// Seller <-> inspector operational handoff.
//
// Extracted from routes/inspections.js so the inspection lifecycle file stays
// focused on the request state machine. Same paths, same responses, same
// validation — pure relocation, no behavior change.
//
// The buyer NEVER sees this data. Access is enforced by viewerRoleFor in
// services/inspectionCoordinationService.js.
// ============================================================================

const router = express.Router();

async function loadCoordinationContext(req, res) {
  const request = await prisma.inspectionRequest.findUnique({
    where: { id: req.params.id },
    include: {
      listing: { select: { id: true, sellerId: true, title: true, cropType: true, location: true } },
      coordination: true,
      availability: { orderBy: [{ date: 'asc' }, { startTime: 'asc' }] },
    },
  });
  if (!request) {
    res.status(404).json({ error: 'Inspection request not found' });
    return null;
  }

  const { allowed, role } = viewerRoleFor(request, req.user);
  if (!allowed) {
    res.status(403).json({ error: 'You are not authorized to view inspection coordination' });
    return null;
  }

  try {
    assertCoordinationStage(request);
  } catch (err) {
    res.status(err.statusCode || 409).json({ error: err.message, code: err.code || 'COORDINATION_NOT_OPEN' });
    return null;
  }

  return { request, role };
}

router.get('/:id/coordination', authenticate, async (req, res) => {
  try {
    const ctx = await loadCoordinationContext(req, res);
    if (!ctx) return;

    const { request, role } = ctx;

    // Lazy-lapse: if the inspector's 3-hour handoff window has expired
    // without a handoff, close the agreement when anyone opens this page.
    if (
      request.status === 'ACCEPTED' &&
      request.inspectorId &&
      request.coordinationDueAt &&
      new Date(request.coordinationDueAt) <= new Date() &&
      !request.coordination?.inspectorSubmittedAt
    ) {
      const lapsed = await prisma.$transaction(async (tx) => {
        return lapseInspectionAgreement(tx, {
          inspectionRequestId: request.id,
          code: 'INSPECTOR_COORDINATION_EXPIRED',
          actorId: null,
          actorRole: 'SYSTEM',
        });
      }, { maxWait: 10000, timeout: 15000 });

      if (lapsed?.lapsed) {
        await noticeInspectionWaitingUnlocked(prisma, {
          inspectionRequestId: request.id,
          reason: 'INSPECTOR_COORDINATION_EXPIRED',
        }).catch(() => {});
      }

      return res.status(409).json({
        code: 'COORDINATION_WINDOW_EXPIRED',
        error: `The inspector did not share their arrival handoff within ${INSPECTOR_COORDINATION_WINDOW_HOURS} hours of accepting the price. The provisional agreement has expired.`,
      });
    }

    const coordination = request.coordination && !request.coordination.supersededAt
      ? request.coordination
      : null;

    return res.json({
      role,
      coordination,
      availability: request.availability || [],
      status: request.status,
      sellerConfirmedAt: request.sellerConfirmedAt || null,
      inspectorOnSiteConfirmedAt: request.inspectorOnSiteConfirmedAt || null,
      inspectorId: request.inspectorId || null,
      coordinationDueAt: request.coordinationDueAt || null,
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTION COORDINATION ERROR:');
    return res.status(500).json({ error: 'Could not load inspection coordination' });
  }
});

router.put(
  '/:id/coordination',
  authenticate,
  [
    body('sellerContactName').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('sellerPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('sellerAlternativePhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('sellerEmail').optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body('sellerPreferredContact').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('inspectionSite').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('meetingPoint').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('accessInstructions').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('sellerNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),

    body('inspectorContactName').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('inspectorPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('inspectorAlternativePhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('inspectorEmail').optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body('inspectorPreferredContact').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('inspectorArrivalNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('inspectorNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
      }

      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { request, role } = ctx;

      if (role === 'ADMIN') {
        return res.status(403).json({ error: 'Administrators may view coordination but not write it' });
      }

      const SELLER_FIELDS = [
        'sellerContactName', 'sellerPhone', 'sellerAlternativePhone', 'sellerEmail',
        'sellerPreferredContact', 'inspectionSite', 'meetingPoint', 'accessInstructions', 'sellerNotes',
      ];
      const INSPECTOR_FIELDS = [
        'inspectorContactName', 'inspectorPhone', 'inspectorAlternativePhone', 'inspectorEmail',
        'inspectorPreferredContact', 'inspectorArrivalNotes', 'inspectorNotes',
      ];
      const allowedFields = role === 'SELLER' ? SELLER_FIELDS : INSPECTOR_FIELDS;

      const data = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          const value = req.body[field];
          data[field] = value === '' || value === undefined ? null : value;
        }
      }

      if (role === 'SELLER') data.sellerSubmittedAt = new Date();
      else data.inspectorSubmittedAt = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const row = await ensureOpenCoordination(tx, request.id);
        return tx.inspectionCoordination.update({
          where: { id: row.id },
          data,
        });
      }, { maxWait: 10000, timeout: 15000 });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: role === 'SELLER'
          ? 'INSPECTION_COORDINATION_SELLER_SUBMITTED'
          : 'INSPECTION_COORDINATION_INSPECTOR_SUBMITTED',
        resourceType: 'InspectionCoordination',
        resourceId: updated.id,
        metadata: {
          inspectionRequestId: request.id,
          role,
          fields: Object.keys(data).filter((k) => !k.endsWith('SubmittedAt')),
        },
      });

      return res.json({ message: 'Coordination information saved', coordination: updated });
    } catch (error) {
      req.log.error({ err: error }, 'PUT INSPECTION COORDINATION ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not save inspection coordination' });
    }
  }
);

router.post(
  '/:id/coordination/availability',
  authenticate,
  [
    body('date').isISO8601().withMessage('date must be a valid date'),
    body('startTime').matches(/^\d{2}:\d{2}$/).withMessage('startTime must be HH:MM'),
    body('endTime').matches(/^\d{2}:\d{2}$/).withMessage('endTime must be HH:MM'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
      }

      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { request, role } = ctx;

      if (role !== 'SELLER' && role !== 'INSPECTOR') {
        return res.status(403).json({ error: 'Only the seller or inspector can add availability slots' });
      }

      const { date, startTime, endTime } = req.body;
      if (startTime >= endTime) {
        return res.status(400).json({ error: 'startTime must be before endTime' });
      }

      const slot = await prisma.inspectionAvailability.create({
        data: {
          inspectionRequestId: request.id,
          party: role,
          date: new Date(date),
          startTime,
          endTime,
        },
      });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'INSPECTION_AVAILABILITY_ADDED',
        resourceType: 'InspectionAvailability',
        resourceId: slot.id,
        metadata: { inspectionRequestId: request.id, party: role, date, startTime, endTime },
      });

      return res.status(201).json({ availability: slot });
    } catch (error) {
      req.log.error({ err: error }, 'POST INSPECTION AVAILABILITY ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not add availability slot' });
    }
  }
);

router.delete(
  '/:id/coordination/availability/:slotId',
  authenticate,
  async (req, res) => {
    try {
      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { request, role } = ctx;

      const slot = await prisma.inspectionAvailability.findUnique({
        where: { id: req.params.slotId },
      });
      if (!slot || slot.inspectionRequestId !== request.id) {
        return res.status(404).json({ error: 'Availability slot not found' });
      }
      if (slot.party !== role) {
        return res.status(403).json({ error: 'You can only remove your own availability slots' });
      }

      await prisma.inspectionAvailability.delete({ where: { id: slot.id } });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'INSPECTION_AVAILABILITY_REMOVED',
        resourceType: 'InspectionAvailability',
        resourceId: slot.id,
        metadata: { inspectionRequestId: request.id, party: role },
      });

      return res.json({ message: 'Availability slot removed' });
    } catch (error) {
      req.log.error({ err: error }, 'DELETE INSPECTION AVAILABILITY ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not remove availability slot' });
    }
  }
);

module.exports = router;
