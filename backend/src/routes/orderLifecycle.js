'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { recordAuditEvent } = require('../utils/audit');
const { isAdmin } = require('../utils/authorization');
const { recordOrderEvent } = require('../services/orderEventService');
const { cancelOrderInTransaction } = require('../services/orderCancellationService');
const { transitionOrderStatus } = require('../services/orderStateMachine');
const {
  noticeWaitingUnlocked,
  notifyInspectionBiddersServiceCancelled,
  notifyTransportBiddersServiceCancelled,
} = require('../services/waitingListService');

const { orderDetailInclude } = require('../services/orderIncludes');
const {
  applySealedBidVisibility,
  capturePendingBidders,
} = require('../services/orderHelpers');

// ============================================================================
// ORDER LIFECYCLE
// ============================================================================
//
// Extracted from routes/orders.js. Three routes handle the transition and
// termination of an order:
//
//   PATCH /api/orders/:id/buyer-decision   — BUY or CANCEL after inspection
//   PATCH /api/orders/:id/confirm-receipt  — buyer acknowledges delivery
//   PATCH /api/orders/:id/cancel           — cancel an order
//
// Same paths, same behavior, same responses. Pure relocation.
// ============================================================================

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

// Once an order is COMPLETED or already CANCELLED there is nothing left to
// cancel.
const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];

// Once the truck has actually picked up, is moving, or has delivered the
// goods, a plain cancel is the wrong tool — that needs the dispute/refund
// workflow so both sides have a record of why goods that physically moved
// are being unwound.
const TRANSPORT_IN_MOTION_STATUSES = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];

// ============================================================================
// PATCH /api/orders/:id/buyer-decision
// ============================================================================

router.patch(
  '/:id/buyer-decision',
  authenticate,
  idempotency('orders.buyer-decision'),
  [
    param('id').isUUID(),
    body('decision').isIn(['BUY', 'CANCEL']),
    body('reason').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res) => {
    try {
      const decision = req.body.decision;

      // Snapshot the still-PENDING waiting bidders before a CANCEL runs.
      const preCancel = decision === 'CANCEL'
        ? await capturePendingBidders(req.params.id)
        : null;

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: req.params.id },
          select: {
            id: true,
            buyerId: true,
            sellerId: true,
            listingId: true,
            status: true,
            buyerDecision: true,
            finalPrice: true,
            quantity: true,
            listing: { select: { id: true, category: true } },
            payments: { select: { id: true, amount: true, status: true } },
            transportJob: { select: { id: true, status: true } },
            inspectionRequests: {
              where: { status: { not: 'CANCELLED' } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                status: true,
                report: { select: { id: true } },
              },
            },
          },
        });

        if (!current) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (current.buyerId !== req.user.id) {
          throw Object.assign(new Error('Only the buyer can make the purchase decision'), { status: 403 });
        }
        if (!['AGRICULTURAL', 'PRODUCT'].includes(current.listing?.category)) {
          throw Object.assign(
            new Error('Buyer decision is only available for Agricultural and Products Marketplace orders'),
            { status: 400 }
          );
        }
        if (current.status === 'DISPUTED') {
          throw Object.assign(
            new Error('This order is under dispute. Buyer decisions are paused until the dispute is resolved.'),
            { status: 409, code: 'ORDER_DISPUTED' }
          );
        }
        if (['CANCELLED', 'COMPLETED'].includes(current.status)) {
          throw Object.assign(new Error(`Order is already ${current.status.toLowerCase()}`), { status: 409 });
        }
        if (!current.buyerDecision && current.buyerDecisionDueAt && current.buyerDecisionDueAt <= new Date()) {
          throw Object.assign(new Error('The buyer decision window has expired. The order will be closed by the workflow maintenance cycle.'), { status: 409, code: 'BUYER_DECISION_WINDOW_EXPIRED' });
        }
        if (decision === 'BUY') {
          const pendingReview = await tx.priceReview.findFirst({ where: { orderId: current.id, status: 'PENDING' }, select: { id: true, reasonCode: true } });
          if (pendingReview) {
            if (pendingReview.reasonCode === 'BUYER_WANTS_CANCELLATION') {
              throw Object.assign(new Error('You have an open cancellation request. Wait for the seller to respond, or withdraw it first.'), { status: 409, code: 'CANCELLATION_REQUEST_PENDING' });
            }
            throw Object.assign(new Error('Respond to the pending price review before proceeding to payment.'), { status: 409, code: 'PRICE_REVIEW_PENDING' });
          }
          // FIXED: The buyer must have gone through a formally accepted
          // price review before payment can unlock. This forces bilateral
          // price confirmation after the inspection report.
          const acceptedReview = await tx.priceReview.findFirst({
            where: { orderId: current.id, status: 'ACCEPTED', reasonCode: { not: 'BUYER_WANTS_CANCELLATION' } },
            select: { id: true },
          });
          if (!acceptedReview) {
            throw Object.assign(new Error(
              'The price must be formally confirmed by both parties after the inspection report. Use "Confirm at agreed price" or "Propose a different price" to open the price review.'
            ), { status: 409, code: 'PRICE_CONFIRMATION_REQUIRED' });
          }
        }

        if (current.buyerDecision) {
          throw Object.assign(
            new Error(`Buyer decision has already been recorded as ${current.buyerDecision}`),
            { status: 409, buyerDecision: current.buyerDecision }
          );
        }

        const currentInspection = current.inspectionRequests[0] || null;
        if (!currentInspection) {
          throw Object.assign(new Error(
            'Request and complete the inspection before the buyer can decide to buy or cancel.'
          ), { status: 409, code: 'INSPECTION_REQUIRED_FOR_BUYER_DECISION' });
        }
        if (currentInspection.status !== 'COMPLETED' || !currentInspection.report) {
          throw Object.assign(new Error(
            'The inspection report must be completed and published before the buyer can decide.'
          ), {
            status: 409,
            code: 'INSPECTION_REPORT_REQUIRED_FOR_BUYER_DECISION',
            inspectionRequestId: currentInspection.id,
            inspectionStatus: currentInspection.status,
          });
        }

        // FIXED: The BUY decision no longer requires a transporter to already
        // be selected. Transport bidding opens *after* the BUY decision, so
        // requiring a transporter here would be circular.
        if (decision === 'BUY') {
          // No transport gate. The buyer commits first, then arranges transport.
        }

        if (decision === 'CANCEL') {
          const reason = req.body.reason || 'Buyer declined the transaction after inspection';

          await tx.order.update({
            where: { id: current.id },
            data: { buyerDecision: 'CANCEL', buyerDecisionAt: new Date(), buyerDecisionDueAt: null },
          });

          try {
            await recordOrderEvent(tx, {
              orderId: current.id,
              actorId: req.user.id,
              type: 'BUYER_DECISION_MADE',
              metadata: { decision: 'CANCEL', reason },
            });
          } catch (eventError) {
            req.log.error({ err: eventError, orderId: current.id }, 'BUYER DECISION EVENT SIDE EFFECT FAILED');
          }

          await cancelOrderInTransaction(tx, {
            order: current,
            actorId: req.user.id,
            reason,
            cancelledByRole: 'BUYER',
          });

          return tx.order.findUnique({
            where: { id: current.id },
            select: { id: true, buyerDecision: true, buyerDecisionAt: true, paymentDueAt: true, status: true },
          });
        }

        const now = new Date();
        const claimed = await tx.order.updateMany({
          where: {
            id: current.id,
            buyerDecision: null,
            status: { notIn: ['CANCELLED', 'COMPLETED'] },
          },
          data: {
            buyerDecision: 'BUY',
            buyerDecisionAt: now,
            buyerReviewedReportAt: now,
            buyerDecisionDueAt: null,
            // FIXED: paymentDueAt is intentionally NOT set here. The goods
            // payment obligation and its due date are created later, when the
            // transporter submits the loading-preparation report and the
            // buyer approves it. See routes/transport.js.
          },
        });

        if (claimed.count !== 1) {
          throw Object.assign(
            new Error('The buyer decision was already recorded or the order changed. Refresh the order and try again.'),
            { status: 409, code: 'BUYER_DECISION_CONFLICT' }
          );
        }

        return tx.order.findUnique({
          where: { id: current.id },
          select: { id: true, buyerDecision: true, buyerDecisionAt: true, paymentDueAt: true, status: true },
        });
      }, { maxWait: 10000, timeout: 15000 });

      if (decision === 'BUY') {
        try {
          await recordOrderEvent(prisma, {
            orderId: updated.id,
            actorId: req.user.id,
            type: 'BUYER_DECISION_MADE',
            metadata: { decision: 'BUY' },
          });
        } catch (eventError) {
          req.log.error({ err: eventError, orderId: updated.id }, 'BUYER DECISION EVENT POST-COMMIT FAILED');
        }
      }

      if (decision === 'CANCEL' && updated?.status === 'CANCELLED') {
        const cancelled = await prisma.order.findUnique({
          where: { id: updated.id },
          select: { listingId: true },
        }).catch(() => null);
        if (cancelled?.listingId) {
          await noticeWaitingUnlocked(prisma, {
            listingId: cancelled.listingId,
            reason: 'ORDER_CANCELLED',
          });
        }

        if (preCancel) {
          for (const r of preCancel.inspectionRequests || []) {
            if (r.quotes?.length) {
              await notifyInspectionBiddersServiceCancelled(prisma, {
                inspectionRequestId: r.id,
                bids: r.quotes,
                reason: 'ORDER_CANCELLED',
              });
            }
          }
          if (preCancel.transportJob?.id && preCancel.transportJob.quotes?.length) {
            await notifyTransportBiddersServiceCancelled(prisma, {
              transportJobId: preCancel.transportJob.id,
              bids: preCancel.transportJob.quotes,
              reason: 'ORDER_CANCELLED',
            });
          }
        }
      }

      return res.json({
        message: decision === 'BUY'
          ? 'Buyer chose to buy. Seller payment and the next transaction steps are now available.'
          : 'Buyer cancelled the transaction after inspection.',
        decision,
        order: updated,
      });
    } catch (error) {
      req.log.error({ err: error }, 'BUYER DECISION ERROR');
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Could not record buyer decision',
        ...(error.code ? { code: error.code } : {}),
        ...(error.inspectionRequestId ? { inspectionRequestId: error.inspectionRequestId } : {}),
        ...(error.inspectionStatus ? { inspectionStatus: error.inspectionStatus } : {}),
        ...(error.buyerDecision ? { buyerDecision: error.buyerDecision } : {}),
      });
    }
  }
);

// ============================================================================
// PATCH /api/orders/:id/confirm-receipt
// ============================================================================

router.patch('/:id/confirm-receipt', authenticate, idempotency('orders.confirm-receipt'), async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { transportJob: true, payments: true },
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerId !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm receipt' });
    if (order.status === 'COMPLETED') return res.status(400).json({ error: 'Order has already been completed' });
    if (!order.transportJob) return res.status(400).json({ error: 'No transport record exists for this order' });
    if (order.transportJob.status !== 'DELIVERED') {
      return res.status(400).json({ error: `Receipt cannot be confirmed while transport status is ${order.transportJob.status}` });
    }

    const marketplacePaid = order.payments.some((p) => p.type === 'MARKETPLACE' && p.status === 'PAID');
    if (!marketplacePaid) {
      return res.status(402).json({ error: 'Marketplace payment must be PAID before receipt can be confirmed' });
    }

    if (order.transportJob.method === 'HIRE_TRANSPORTER') {
      const transportPaid = order.payments.some((p) => p.type === 'TRANSPORT' && p.status === 'PAID');
      if (!transportPaid) {
        return res.status(402).json({ error: 'Transport payment must be PAID before receipt can be confirmed' });
      }
    }

    await prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { id: order.id },
        include: { transportJob: true, payments: true },
      });

      if (!current || current.buyerId !== req.user.id) throw new Error('Only the buyer can confirm receipt');
      if (current.status === 'COMPLETED') throw new Error('Order has already been completed');
      if (!current.transportJob || current.transportJob.status !== 'DELIVERED') {
        throw new Error(`Receipt cannot be confirmed while transport status is ${current.transportJob?.status || 'UNKNOWN'}`);
      }

      await transitionOrderStatus(tx, current.id, current.status, 'COMPLETED');

      await recordOrderEvent(tx, {
        orderId: current.id,
        actorId: req.user.id,
        type: 'RECEIPT_CONFIRMED',
        fromStatus: current.status,
        toStatus: 'COMPLETED',
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'ORDER_RECEIPT_CONFIRMED',
        resourceType: 'Order',
        resourceId: current.id,
        metadata: { fromStatus: current.status, toStatus: 'COMPLETED' },
      });

      return true;
    }, { maxWait: 10000, timeout: 20000 });

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: orderDetailInclude,
    });

    // FIXED: apply the same sealed-bid visibility to the post-receipt response.
    const visibleOrder = await applySealedBidVisibility(updatedOrder, req.user.id, req.user.roles || []);

    return res.json({ message: 'Receipt confirmed. Order completed.', order: visibleOrder });
  } catch (error) {
    req.log.error({ err: error }, 'CONFIRM RECEIPT ERROR:');
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error.message.includes('confirm receipt') || error.message.includes('already been completed') || error.message.includes('UNKNOWN')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to confirm receipt' });
  }
});

// ============================================================================
// PATCH /api/orders/:id/cancel
// ============================================================================

router.patch(
  '/:id/cancel',
  authenticate,
  [
    param('id').isUUID(),
    body('reason').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { transportJob: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      const userIsAdmin = isAdmin(req.user);
      const userIsBuyer = order.buyerId === req.user.id;
      const userIsSeller = order.sellerId === req.user.id;

      if (!userIsAdmin && !userIsBuyer && !userIsSeller) {
        return res.status(403).json({ error: 'Not authorized to cancel this order' });
      }

      if (NON_CANCELLABLE_STATUSES.includes(order.status)) {
        return res.status(400).json({
          error: `Order is already ${order.status.toLowerCase()} and cannot be cancelled`,
        });
      }

      if (order.transportJob && TRANSPORT_IN_MOTION_STATUSES.includes(order.transportJob.status)) {
        return res.status(400).json({
          error: 'Goods are already in transit or delivered for this order. Raise a dispute instead of cancelling.',
        });
      }

      if (userIsBuyer && !userIsAdmin && order.status !== 'PENDING_PAYMENT') {
        return res.status(400).json({
          error: 'You can only cancel an order before it has been paid for. Use "Request cancellation" after inspection, or raise a dispute for orders already in progress.',
        });
      }

      if (userIsSeller && !userIsAdmin && !['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)) {
        return res.status(400).json({
          error: 'This order has moved past the point a seller can cancel directly. An admin can cancel it, or raise a dispute.',
        });
      }

      const reason = req.body?.reason || null;
      const cancelledByRole = userIsAdmin ? 'ADMIN' : userIsBuyer ? 'BUYER' : 'SELLER';

      const preCancel = await capturePendingBidders(order.id);

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: order.id },
          include: { transportJob: true, payments: true },
        });

        await cancelOrderInTransaction(tx, {
          order: current,
          actorId: req.user.id,
          reason,
          cancelledByRole,
        });

        return tx.order.findUnique({ where: { id: current.id }, include: orderDetailInclude });
      }, { maxWait: 10000, timeout: 15000 });

      if (updated?.listingId) {
        await noticeWaitingUnlocked(prisma, {
          listingId: updated.listingId,
          reason: 'ORDER_CANCELLED',
        });
      }

      if (preCancel) {
        for (const r of preCancel.inspectionRequests || []) {
          if (r.quotes?.length) {
            await notifyInspectionBiddersServiceCancelled(prisma, {
              inspectionRequestId: r.id,
              bids: r.quotes,
              reason: 'ORDER_CANCELLED',
            });
          }
        }
        if (preCancel.transportJob?.id && preCancel.transportJob.quotes?.length) {
          await notifyTransportBiddersServiceCancelled(prisma, {
            transportJobId: preCancel.transportJob.id,
            bids: preCancel.transportJob.quotes,
            reason: 'ORDER_CANCELLED',
          });
        }
      }

      // FIXED: same sealed-bid visibility on the cancel response.
      const visibleOrder = await applySealedBidVisibility(updated, req.user.id, req.user.roles || []);

      return res.json({ message: 'Order cancelled.', order: visibleOrder });
    } catch (error) {
      req.log.error({ err: error }, 'CANCEL ORDER ERROR:');
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Failed to cancel order',
      });
    }
  }
);

module.exports = router;
