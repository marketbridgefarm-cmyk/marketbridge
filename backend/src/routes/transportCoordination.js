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
} = require('../services/transportCoordinationService');

// ============================================================================
// TRANSPORT COORDINATION
// ----------------------------------------------------------------------------
// Seller <-> transporter operational handoff.
//
// Extracted from routes/transport.js so that the transport lifecycle file
// stays focused on the job state machine. Same paths, same responses, same
// validation — pure relocation, no behavior change.
//
// The buyer NEVER sees this data. Access is enforced by viewerRoleFor in
// services/transportCoordinationService.js.
// ============================================================================

const router = express.Router();

async function loadCoordinationContext(req, res) {
  const job = await prisma.transportJob.findUnique({
    where: { id: req.params.id },
    include: {
      order: { select: { id: true, sellerId: true, buyerId: true, status: true } },
      coordination: true,
      availability: { orderBy: [{ date: 'asc' }, { startTime: 'asc' }] },
    },
  });

  if (!job) {
    res.status(404).json({ error: 'Transport job not found' });
    return null;
  }

  const { allowed, role } = viewerRoleFor(job, req.user);
  if (!allowed) {
    res.status(403).json({ error: 'You are not authorized to view transport coordination' });
    return null;
  }

  try {
    assertCoordinationStage(job);
  } catch (err) {
    res.status(err.statusCode || 409).json({ error: err.message, code: err.code || 'COORDINATION_NOT_OPEN' });
    return null;
  }

  return { job, role };
}

router.get('/:id/coordination', authenticate, async (req, res) => {
  try {
    const ctx = await loadCoordinationContext(req, res);
    if (!ctx) return;

    const { job, role } = ctx;
    const coordination = job.coordination && !job.coordination.supersededAt ? job.coordination : null;

    return res.json({ role, coordination, availability: job.availability || [] });
  } catch (error) {
    req.log.error({ err: error }, 'GET TRANSPORT COORDINATION ERROR:');
    return res.status(500).json({ error: 'Could not load transport coordination' });
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
    body('pickupSite').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('meetingPoint').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('accessInstructions').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('sellerPrepNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('sellerSitePhotos').optional().isArray(),
    body('sellerPrepPhotos').optional().isArray(),
    body('driverContactName').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('driverPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverAlternativePhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverEmail').optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body('driverPreferredContact').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverArrivalEta').optional({ nullable: true }).isISO8601(),
    body('driverArrivalNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('driverEquipment').optional().isArray(),
    body('driverNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
      }

      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { job, role } = ctx;

      if (role === 'ADMIN') {
        return res.status(403).json({ error: 'Administrators may view coordination but not write it' });
      }

      const SELLER_FIELDS = [
        'sellerContactName', 'sellerPhone', 'sellerAlternativePhone', 'sellerEmail',
        'sellerPreferredContact', 'pickupSite', 'meetingPoint', 'accessInstructions',
        'sellerPrepNotes', 'sellerSitePhotos', 'sellerPrepPhotos',
      ];
      const DRIVER_FIELDS = [
        'driverContactName', 'driverPhone', 'driverAlternativePhone', 'driverEmail',
        'driverPreferredContact', 'driverArrivalEta', 'driverArrivalNotes',
        'driverEquipment', 'driverNotes',
      ];
      const allowedFields = role === 'SELLER' ? SELLER_FIELDS : DRIVER_FIELDS;

      const data = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          const value = req.body[field];
          if (Array.isArray(value)) {
            data[field] = value.filter((v) => typeof v === 'string' && v.trim()).slice(0, 20);
          } else if (field === 'driverArrivalEta') {
            data[field] = value ? new Date(value) : null;
          } else {
            data[field] = value === '' || value === undefined ? null : value;
          }
        }
      }

      if (role === 'SELLER') data.sellerSubmittedAt = new Date();
      else data.driverSubmittedAt = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const row = await ensureOpenCoordination(tx, job.id);
        return tx.transportCoordination.update({ where: { id: row.id }, data });
      }, { maxWait: 10000, timeout: 15000 });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: role === 'SELLER'
          ? 'TRANSPORT_COORDINATION_SELLER_SUBMITTED'
          : 'TRANSPORT_COORDINATION_DRIVER_SUBMITTED',
        resourceType: 'TransportCoordination',
        resourceId: updated.id,
        metadata: {
          transportJobId: job.id,
          orderId: job.orderId,
          role,
          fields: Object.keys(data).filter((k) => !k.endsWith('SubmittedAt')),
        },
      });

      return res.json({ message: 'Coordination information saved', coordination: updated });
    } catch (error) {
      req.log.error({ err: error }, 'PUT TRANSPORT COORDINATION ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not save transport coordination' });
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
      const { job, role } = ctx;

      if (role !== 'SELLER' && role !== 'TRANSPORTER') {
        return res.status(403).json({ error: 'Only the seller or transporter can add availability slots' });
      }

      const { date, startTime, endTime } = req.body;
      if (startTime >= endTime) {
        return res.status(400).json({ error: 'startTime must be before endTime' });
      }

      const slot = await prisma.transportAvailability.create({
        data: { transportJobId: job.id, party: role, date: new Date(date), startTime, endTime },
      });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'TRANSPORT_AVAILABILITY_ADDED',
        resourceType: 'TransportAvailability',
        resourceId: slot.id,
        metadata: { transportJobId: job.id, party: role, date, startTime, endTime },
      });

      return res.status(201).json({ availability: slot });
    } catch (error) {
      req.log.error({ err: error }, 'POST TRANSPORT AVAILABILITY ERROR:');
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
      const { job, role } = ctx;

      const slot = await prisma.transportAvailability.findUnique({ where: { id: req.params.slotId } });
      if (!slot || slot.transportJobId !== job.id) {
        return res.status(404).json({ error: 'Availability slot not found' });
      }
      if (slot.party !== role) {
        return res.status(403).json({ error: 'You can only remove your own availability slots' });
      }

      await prisma.transportAvailability.delete({ where: { id: slot.id } });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'TRANSPORT_AVAILABILITY_REMOVED',
        resourceType: 'TransportAvailability',
        resourceId: slot.id,
        metadata: { transportJobId: job.id, party: role },
      });

      return res.json({ message: 'Availability slot removed' });
    } catch (error) {
      req.log.error({ err: error }, 'DELETE TRANSPORT AVAILABILITY ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not remove availability slot' });
    }
  }
);

module.exports = router;
