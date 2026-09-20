const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { transitionOrderStatus, DISPUTABLE_STATUSES } = require('../services/orderStateMachine');
const { holdForDispute, resumeAfterDispute, cancelAfterDispute } = require('../services/payoutService');

const router = express.Router();

router.post(
  '/',
  authenticate,
  [body('orderId').notEmpty(), body('againstId').notEmpty(), body('disputeType').notEmpty(), body('description').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });

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

      if (!DISPUTABLE_STATUSES.includes(order.status)) {
        return res.status(400).json({ error: `An order in ${order.status} status cannot be disputed` });
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

        // Atomic claim: fails with ORDER_STATE_CONFLICT if another
        // dispute (or any other status change) landed on this order
        // between the pre-check above and this transaction.
        await transitionOrderStatus(tx, orderId, order.status, 'DISPUTED');

        await holdForDispute(tx, { orderId, actorId: req.user.id });

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
      req.log.error({ err: error }, 'CREATE DISPUTE ERROR:');
      if (error.code === 'ORDER_STATE_CONFLICT') {
        return res.status(409).json({ error: 'This order changed status just now; please refresh and try again.' });
      }
      return res.status(500).json({ error: 'Could not create dispute' });
    }
  }
);

router.get('/', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
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
    req.log.error({ err: error }, 'LIST DISPUTES ERROR:');
    return res.status(500).json({ error: 'Could not load disputes' });
  }
});

router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const { resolution, status, payoutDecision } = req.body;

    if (payoutDecision != null && !['RELEASE', 'CANCEL'].includes(String(payoutDecision).toUpperCase())) {
      return res.status(400).json({ error: 'payoutDecision must be RELEASE or CANCEL' });
    }

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

      // Atomic claim: fails with ORDER_STATE_CONFLICT if the order
      // somehow left DISPUTED before this resolution landed.
      await transitionOrderStatus(tx, updated.orderId, 'DISPUTED', updated.previousOrderStatus || 'CONFIRMED');

      // A dispute freezes every payout on the order together (seller,
      // transporter, inspector — whichever exist), so any one of them
      // still ON_HOLD_DISPUTE means this resolution needs a payoutDecision;
      // resumeAfterDispute/cancelAfterDispute then apply it to all of them.
      const frozenPayout = await tx.payout.findFirst({
        where: { orderId: updated.orderId, status: 'ON_HOLD_DISPUTE' },
        select: { id: true, status: true },
      });

      if (frozenPayout) {
        if (!payoutDecision) {
          throw Object.assign(
            new Error('This dispute resolution requires payoutDecision RELEASE or CANCEL because the seller payout is frozen'),
            { status: 400, code: 'PAYOUT_DECISION_REQUIRED' }
          );
        }

        if (String(payoutDecision).toUpperCase() === 'RELEASE') {
          await resumeAfterDispute(tx, { orderId: updated.orderId, actorId: req.user.id });
        } else {
          await cancelAfterDispute(tx, { orderId: updated.orderId, actorId: req.user.id });
        }
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'DISPUTE_RESOLVED',
        resourceType: 'Dispute',
        resourceId: updated.id,
        metadata: {
          orderId: updated.orderId,
          finalStatus,
          restoredOrderStatus: updated.previousOrderStatus || 'CONFIRMED',
          payoutDecision: payoutDecision ? String(payoutDecision).toUpperCase() : null,
        },
      });

      return updated;
    });

    return res.json({ dispute: result });
  } catch (error) {
    req.log.error({ err: error }, 'RESOLVE DISPUTE ERROR:');
    if (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'INVALID_ORDER_TRANSITION' || error.code === 'PAYOUT_DECISION_REQUIRED') {
      return res.status(error.status || 409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Could not resolve dispute' });
  }
});

module.exports = router;
