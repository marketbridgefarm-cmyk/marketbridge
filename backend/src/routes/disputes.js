const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');

const router = express.Router();

router.post(
  '/',
  authenticate,
  [body('orderId').notEmpty(), body('againstId').notEmpty(), body('disputeType').notEmpty(), body('description').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { orderId, againstId, disputeType, description, evidence } = req.body;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { transportJob: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      const truckOwnerId = order.transportJob?.truckOwnerId;
      const participants = [order.buyerId, order.sellerId, truckOwnerId].filter(Boolean);

      if (!participants.includes(req.user.id)) {
        return res.status(403).json({ error: 'You are not a participant on this order' });
      }

      if (againstId === req.user.id) {
        return res.status(400).json({ error: 'You cannot raise a dispute against yourself' });
      }

      if (!participants.includes(againstId)) {
        return res.status(400).json({ error: 'againstId must be another participant on this order' });
      }

      if (order.status === 'DISPUTED') {
        return res.status(409).json({ error: 'This order already has an open dispute' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const dispute = await tx.dispute.create({
          data: {
            orderId,
            raisedById: req.user.id,
            againstId,
            disputeType,
            description,
            evidence: evidence || [],
            previousOrderStatus: order.status,
          },
        });

        await tx.order.update({
          where: { id: orderId },
          data: { status: 'DISPUTED' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'DISPUTE_RAISED',
          resourceType: 'Dispute',
          resourceId: dispute.id,
          metadata: {
            orderId,
            againstId,
            disputeType,
            previousOrderStatus: order.status,
          },
        });

        return dispute;
      });

      return res.status(201).json({ dispute: result });
    } catch (error) {
      console.error('CREATE DISPUTE ERROR:', error);
      return res.status(500).json({ error: 'Could not create dispute' });
    }
  }
);

router.get('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const disputes = await prisma.dispute.findMany({
      include: {
        order: true,
        raisedBy: { select: { id: true, name: true } },
        against: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ disputes });
  } catch (error) {
    console.error('LIST DISPUTES ERROR:', error);
    return res.status(500).json({ error: 'Could not load disputes' });
  }
});

router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { resolution, status } = req.body;

    const dispute = await prisma.dispute.findUnique({ where: { id: req.params.id } });
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    if (dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW') {
      return res.status(409).json({ error: `Dispute is already ${dispute.status}` });
    }

    const finalStatus = status || 'RESOLVED';

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.dispute.update({
        where: { id: req.params.id },
        data: { resolution, status: finalStatus },
      });

      await tx.order.update({
        where: { id: updated.orderId },
        data: { status: updated.previousOrderStatus || 'CONFIRMED' },
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'DISPUTE_RESOLVED',
        resourceType: 'Dispute',
        resourceId: updated.id,
        metadata: {
          orderId: updated.orderId,
          finalStatus,
          restoredOrderStatus: updated.previousOrderStatus || 'CONFIRMED',
        },
      });

      return updated;
    });

    return res.json({ dispute: result });
  } catch (error) {
    console.error('RESOLVE DISPUTE ERROR:', error);
    return res.status(500).json({ error: 'Could not resolve dispute' });
  }
});

module.exports = router;
