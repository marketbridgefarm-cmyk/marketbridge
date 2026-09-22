const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { transitionOrderStatus, DISPUTABLE_STATUSES } = require('../services/orderStateMachine');
const { holdForDispute, resumeAfterDispute } = require('../services/payoutService');
const { cancelOrderInTransaction } = require('../services/orderCancellationService');

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
        include: {
          transportJob: true,
          inspectionRequests: {
            where: { status: { not: 'CANCELLED' } },
            select: { inspectorId: true },
          },
        },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      const truckOwnerId = order.transportJob?.truckOwnerId;
      const inspectorIds = (order.inspectionRequests || []).map((request) => request.inspectorId);
      const participants = [...new Set([order.buyerId, order.sellerId, truckOwnerId, ...inspectorIds].filter(Boolean))];

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
      }, { maxWait: 10000, timeout: 15000 });

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
        raisedBy: { select: { id: true, name: true, roles: true } },
        against: { select: { id: true, name: true, roles: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const participantRole = (user, order) => {
      if (!user) return null;
      if (user.id === order?.buyerId) return 'BUYER';
      if (user.id === order?.sellerId) return 'SELLER';
      if (Array.isArray(user.roles) && user.roles.includes('INSPECTOR')) return 'INSPECTOR';
      if (Array.isArray(user.roles) && user.roles.includes('TRUCK_OWNER')) return 'TRUCK_OWNER';
      return Array.isArray(user.roles) ? user.roles[0] || null : null;
    };

    return res.json({
      disputes: disputes.map((dispute) => ({
        ...dispute,
        raisedByRole: participantRole(dispute.raisedBy, dispute.order),
        againstRole: participantRole(dispute.against, dispute.order),
      })),
    });
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
      const dispute = await tx.dispute.findUnique({
        where: { id: req.params.id },
      });
      if (!dispute) throw Object.assign(new Error('Dispute not found'), { status: 404 });

      const currentOrder = await tx.order.findUnique({
        where: { id: dispute.orderId },
        include: {
          transportJob: true,
          payments: true,
        },
      });
      if (!currentOrder) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (currentOrder.status !== 'DISPUTED') {
        throw Object.assign(new Error(`Order is ${currentOrder.status}; the open dispute can no longer be resolved here`), { status: 409, code: 'ORDER_STATE_CONFLICT' });
      }

      const frozenPayout = await tx.payout.findFirst({
        where: { orderId: dispute.orderId, status: 'ON_HOLD_DISPUTE' },
        select: { id: true },
      });
      const decision = payoutDecision ? String(payoutDecision).toUpperCase() : null;

      if (frozenPayout && !decision) {
        throw Object.assign(
          new Error('This dispute resolution requires payoutDecision RELEASE or CANCEL because order payouts are frozen'),
          { status: 400, code: 'PAYOUT_DECISION_REQUIRED' }
        );
      }

      const updated = await tx.dispute.update({
        where: { id: dispute.id },
        data: { resolution, status: finalStatus },
      });

      let refundIds = [];
      let restoredOrderStatus = null;

      if (decision === 'CANCEL') {
        // CANCEL is an order-level economic decision, not merely a payout
        // decision. Previously we cancelled payouts/refunds but restored the
        // order to its old status, which allowed transport, inspection and
        // payment proceedings to continue after the buyer had been refunded.
        // A dispute resolved by cancellation now performs the same complete
        // unwind as a normal order cancellation and leaves the order terminal.
        const cancelled = await cancelOrderInTransaction(tx, {
          order: currentOrder,
          actorId: req.user.id,
          reason: 'Dispute resolved: order cancelled and buyer refund requested',
          cancelledByRole: 'ADMIN',
        });
        const refunds = await tx.paymentRefund.findMany({
          where: { payment: { orderId: dispute.orderId } },
          select: { id: true },
        });
        refundIds = refunds.map((refund) => refund.id);
        restoredOrderStatus = cancelled.status;
      } else {
        // RELEASE (or a dispute with no payout to freeze) resumes the exact
        // pre-dispute order state. The order was frozen while the dispute was
        // open, so no payment/transport/inspection action can sneak through.
        if (decision === 'RELEASE') {
          await resumeAfterDispute(tx, { orderId: dispute.orderId, actorId: req.user.id });
        }
        restoredOrderStatus = dispute.previousOrderStatus || 'CONFIRMED';
        await transitionOrderStatus(tx, dispute.orderId, 'DISPUTED', restoredOrderStatus);
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'DISPUTE_RESOLVED',
        resourceType: 'Dispute',
        resourceId: updated.id,
        metadata: {
          orderId: updated.orderId,
          finalStatus,
          restoredOrderStatus,
          payoutDecision: decision,
          refundIds,
          raisedAgainstId: dispute.againstId,
        },
      });

      return updated;
    }, { maxWait: 10000, timeout: 20000 });

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
