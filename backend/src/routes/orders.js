const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { recordAuditEvent } = require('../utils/audit');
const { isAdmin } = require('../utils/authorization');
const { computeOrderWorkflow } = require('../services/orderWorkflowService');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { idempotency } = require('../middleware/idempotency');
const { computePaymentDueAt } = require('../utils/orderTiming');
const { cancelOrderInTransaction } = require('../services/orderCancellationService');
const { transitionOrderStatus } = require('../services/orderStateMachine');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];
const TRANSPORT_IN_MOTION_STATUSES = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];

const userSelect = { id: true, name: true, phone: true, location: true, rating: true, verificationStatus: true };

const transportInclude = {
  truckOwner: { select: { id: true, name: true, phone: true, rating: true, verificationStatus: true } },
  truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
  quotes: {
    include: {
      truckOwner: { select: { id: true, name: true, phone: true, rating: true, verificationStatus: true } },
      truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
      _count: { select: { childQuotes: true } },
    },
    orderBy: { amount: 'asc' },
  },
};

// LIGHTWEIGHT include for the Orders list page (GET /)
const orderListInclude = {
  listing: {
    select: {
      id: true,
      cropType: true,
      title: true,
      photos: { take: 1 },
    }
  },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: {
    select: {
      id: true,
      status: true,
      method: true,
    }
  },
  payments: {
    select: { id: true, type: true, status: true, amount: true, method: true }
  },
  _count: {
    select: { events: true, disputes: true, messages: true }
  }
};

// HEAVY include for the Order Detail page (GET /:id)
const orderDetailInclude = {
  listing: {
    include: {
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        include: {
          report: true,
          inspector: { select: { id: true, name: true, phone: true } },
          payments: { select: { id: true, type: true, status: true, amount: true, method: true, reference: true } },
          quotes: {
            where: { status: { not: 'REJECTED' } },
            select: {
              id: true, inspectorId: true, amount: true, status: true, message: true,
              parentQuoteId: true, counterAmount: true, counteredBy: true, expiresAt: true, createdAt: true, updatedAt: true,
              inspector: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
              _count: { select: { childQuotes: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  },
  inspectionRequests: {
    where: { status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'desc' },
    include: {
      report: true,
      inspector: { select: { id: true, name: true, phone: true } },
      payments: { select: { id: true, type: true, status: true, amount: true, method: true, reference: true } },
      quotes: {
        where: { status: { not: 'REJECTED' } },
        select: {
          id: true, inspectorId: true, amount: true, status: true, message: true, parentQuoteId: true, counterAmount: true, counteredBy: true, expiresAt: true, createdAt: true, updatedAt: true,
          inspector: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
          _count: { select: { childQuotes: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
  agreedOffer: true,
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: { include: transportInclude },
  payments: {
    include: {
      ledgerEntries: true,
    },
  },
  paymentObligations: {
    include: {
      payment: { select: { id: true, status: true, amount: true, method: true, reference: true } },
      payer: { select: { id: true, name: true } },
      beneficiary: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    take: 50, // Reduced from 200 to save bandwidth
    include: { actor: { select: { id: true, name: true } } },
  },
  disputes: true,
  ratings: true,
  messages: { orderBy: { createdAt: 'asc' }, take: 50 }, // Added take: 50
};

// Direct BUY NOW is intentionally disabled for both marketplaces.
router.post('/buy-now', authenticate, idempotency('orders.buy-now'), async (req, res) => {
  return res.status(410).json({
    code: 'NEGOTIATION_REQUIRED',
    error: 'Direct purchase is not available. Submit a bid first; the seller must select a buyer and complete the negotiation before payment.',
  });
});

// GET /api/orders — Lightweight list for the Orders/Dashboard page
router.get('/', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.roles?.includes('ADMIN');
    const where = isAdmin ? {} : { OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }] };
    
    // Pagination to prevent fetching thousands of orders at once
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: orderListInclude,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.order.count({ where }),
    ]);

    return res.json({ orders, count: orders.length, total, page, limit });
  } catch (error) {
    req.log.error({ err: error }, 'GET ORDERS ERROR:');
    return res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /api/orders/:id — Full detail for the single Order page
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: orderDetailInclude,
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const assignedInspector = Boolean(
      order.inspectionRequests?.some(
        (request) => request.inspectorId === req.user.id
      )
    );

    const allowed = req.user.roles?.includes('ADMIN') ||
      order.buyerId === req.user.id ||
      order.sellerId === req.user.id ||
      order.transportJob?.truckOwnerId === req.user.id ||
      assignedInspector;

    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this order' });

    const payouts = await prisma.payout.findMany({
      where: { orderId: order.id },
      select: {
        id: true, payeeRole: true, payeeId: true, paymentId: true, status: true,
        releaseAt: true, releasedAt: true, paidOutAt: true, amount: true, currency: true, payoutReference: true,
      },
    });

    const payoutViews = payouts.map((payout) => ({
      id: payout.id, payeeRole: payout.payeeRole, status: payout.status,
      releaseAt: payout.releaseAt, releasedAt: payout.releasedAt, paidOutAt: payout.paidOutAt,
      amount: payout.amount, currency: payout.currency, payoutReference: payout.payoutReference,
    }));

    const viewerIsAdmin = Boolean(req.user.roles?.includes('ADMIN'));
    const viewerIsBuyer = order.buyerId === req.user.id;
    const payoutPaymentIds = payouts.map((payout) => payout.paymentId).filter(Boolean);
    const refundPaymentFilters = [
      { orderId: order.id },
      ...(order.transportJob?.id ? [{ transportJobId: order.transportJob.id }] : []),
      ...(payoutPaymentIds.length ? [{ id: { in: payoutPaymentIds } }] : []),
    ];

    const refundRows = await prisma.paymentRefund.findMany({
      where: { payment: { OR: refundPaymentFilters } },
      select: {
        id: true, paymentId: true, amount: true, currency: true, status: true,
        reason: true, failureReason: true, createdAt: true, completedAt: true,
        payment: { select: { type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const roleByPaymentId = new Map(payouts.map((payout) => [payout.paymentId, payout.payeeRole]));
    const roleByPaymentType = { MARKETPLACE: 'SELLER', TRANSPORT: 'TRANSPORTER', INSPECTOR: 'INSPECTOR' };

    const refundViews = refundRows.map((refund) => ({
      id: refund.id, payeeRole: roleByPaymentId.get(refund.paymentId) || roleByPaymentType[refund.payment?.type] || null,
      status: refund.status, amount: refund.amount, currency: refund.currency,
      requestedAt: refund.createdAt, completedAt: refund.completedAt,
      reason: viewerIsAdmin || viewerIsBuyer ? refund.reason : null,
      failureReason: viewerIsAdmin ? refund.failureReason : null,
    }));

    return res.json({
      order: { ...order, payouts: payoutViews, refunds: refundViews },
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET ORDER ERROR:');
    return res.status(500).json({ error: 'Failed to load order' });
  }
});

// GET /api/orders/:id/workflow
router.get('/:id/workflow', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: orderDetailInclude,
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const assignedInspector = Boolean(
      order.inspectionRequests?.some(
        (request) => request.inspectorId === req.user.id
      )
    );

    const allowed = req.user.roles?.includes('ADMIN') ||
      order.buyerId === req.user.id ||
      order.sellerId === req.user.id ||
      order.transportJob?.truckOwnerId === req.user.id ||
      assignedInspector;

    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this order' });

    const workflow = computeOrderWorkflow(order, req.user.id, req.user.roles || []);

    return res.json({ workflow });
  } catch (error) {
    req.log.error({ err: error }, 'GET ORDER WORKFLOW ERROR:');
    return res.status(500).json({ error: 'Failed to compute order workflow' });
  }
});

// PATCH /api/orders/:id/buyer-decision
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

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: req.params.id },
          select: {
            id: true, buyerId: true, sellerId: true, listingId: true, status: true,
            buyerDecision: true, finalPrice: true, quantity: true,
            listing: { select: { id: true, category: true } },
            payments: { select: { id: true, amount: true, status: true } },
            transportJob: { select: { id: true, status: true } },
            inspectionRequests: {
              where: { status: { not: 'CANCELLED' } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, status: true, report: { select: { id: true } } },
            },
          },
        });

        if (!current) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (current.buyerId !== req.user.id) {
          throw Object.assign(new Error('Only the buyer can make the purchase decision'), { status: 403 });
        }
        if (!['AGRICULTURAL', 'PRODUCT'].includes(current.listing?.category)) {
          throw Object.assign(new Error('Buyer decision is only available for Agricultural and Products Marketplace orders'), { status: 400 });
        }
        if (current.status === 'DISPUTED') {
          throw Object.assign(new Error('This order is under dispute. Buyer decisions are paused until the dispute is resolved.'), { status: 409, code: 'ORDER_DISPUTED' });
        }
        if (['CANCELLED', 'COMPLETED'].includes(current.status)) {
          throw Object.assign(new Error(`Order is already ${current.status.toLowerCase()}`), { status: 409 });
        }
        if (current.buyerDecision) {
          throw Object.assign(new Error(`Buyer decision has already been recorded as ${current.buyerDecision}`), { status: 409, buyerDecision: current.buyerDecision });
        }

        const currentInspection = current.inspectionRequests[0] || null;
        if (!currentInspection) {
          throw Object.assign(new Error('Request and complete the inspection before the buyer can decide to buy or cancel.'), { status: 409, code: 'INSPECTION_REQUIRED_FOR_BUYER_DECISION' });
        }
        if (currentInspection.status !== 'COMPLETED' || !currentInspection.report) {
          throw Object.assign(new Error('The inspection report must be completed and published before the buyer can decide.'), {
            status: 409, code: 'INSPECTION_REPORT_REQUIRED_FOR_BUYER_DECISION',
            inspectionRequestId: currentInspection.id, inspectionStatus: currentInspection.status,
          });
        }

        if (decision === 'CANCEL') {
          const reason = req.body.reason || 'Buyer declined the transaction after inspection';

          await tx.order.update({
            where: { id: current.id },
            data: { buyerDecision: 'CANCEL', buyerDecisionAt: new Date() },
          });

          try {
            await recordOrderEvent(tx, {
              orderId: current.id, actorId: req.user.id,
              type: 'BUYER_DECISION_MADE', metadata: { decision: 'CANCEL', reason },
            });
          } catch (eventError) {
            req.log.error({ err: eventError, orderId: current.id }, 'BUYER DECISION EVENT SIDE EFFECT FAILED');
          }

          await cancelOrderInTransaction(tx, {
            order: current, actorId: req.user.id, reason, cancelledByRole: 'BUYER',
          });

          return tx.order.findUnique({
            where: { id: current.id },
            select: { id: true, buyerDecision: true, buyerDecisionAt: true, paymentDueAt: true, status: true },
          });
        }

        const claimed = await tx.order.updateMany({
          where: { id: current.id, buyerDecision: null, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
          data: { buyerDecision: 'BUY', buyerDecisionAt: new Date(), paymentDueAt: computePaymentDueAt() },
        });

        if (claimed.count !== 1) {
          throw Object.assign(new Error('The buyer decision was already recorded or the order changed. Refresh the order and try again.'), { status: 409, code: 'BUYER_DECISION_CONFLICT' });
        }

        return tx.order.findUnique({
          where: { id: current.id },
          select: { id: true, buyerDecision: true, buyerDecisionAt: true, paymentDueAt: true, status: true },
        });
      }, { maxWait: 10000, timeout: 15000 });

      if (decision === 'BUY') {
        try {
          await recordOrderEvent(prisma, {
            orderId: updated.id, actorId: req.user.id,
            type: 'BUYER_DECISION_MADE', metadata: { decision: 'BUY' },
          });
        } catch (eventError) {
          req.log.error({ err: eventError, orderId: updated.id }, 'BUYER DECISION EVENT POST-COMMIT FAILED');
        }
      }

      return res.json({
        message: decision === 'BUY'
          ? 'Buyer chose to buy. Seller payment and the next transaction steps are now available.'
          : 'Buyer cancelled the transaction after inspection.',
        decision, order: updated,
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

// PATCH /api/orders/:id/confirm-receipt
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

    const marketplacePaid = order.payments.some(p => p.type === 'MARKETPLACE' && p.status === 'PAID');
    if (!marketplacePaid) {
      return res.status(402).json({ error: 'Marketplace payment must be PAID before receipt can be confirmed' });
    }

    if (order.transportJob.method === 'HIRE_TRANSPORTER') {
      const transportPaid = order.payments.some(p => p.type === 'TRANSPORT' && p.status === 'PAID');
      if (!transportPaid) {
        return res.status(402).json({ error: 'Transport payment must be PAID before receipt can be confirmed' });
      }
    }

    await prisma.$transaction(async tx => {
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
        orderId: current.id, actorId: req.user.id,
        type: 'RECEIPT_CONFIRMED', fromStatus: current.status, toStatus: 'COMPLETED',
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id, action: 'ORDER_RECEIPT_CONFIRMED',
        resourceType: 'Order', resourceId: current.id,
        metadata: { fromStatus: current.status, toStatus: 'COMPLETED' },
      });

      return true;
    }, { maxWait: 10000, timeout: 20000 });

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: orderDetailInclude, // Use the heavy include for the final response
    });

    return res.json({ message: 'Receipt confirmed. Order completed.', order: updatedOrder });
  } catch (error) {
    req.log.error({ err: error }, 'CONFIRM RECEIPT ERROR:');
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.message.includes('confirm receipt') || error.message.includes('already been completed') || error.message.includes('UNKNOWN')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to confirm receipt' });
  }
});

// PATCH /api/orders/:id/cancel
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
        return res.status(400).json({ error: `Order is already ${order.status.toLowerCase()} and cannot be cancelled` });
      }

      if (order.transportJob && TRANSPORT_IN_MOTION_STATUSES.includes(order.transportJob.status)) {
        return res.status(400).json({ error: 'Goods are already in transit or delivered for this order. Raise a dispute instead of cancelling.' });
      }

      if (userIsBuyer && !userIsAdmin && order.status !== 'PENDING_PAYMENT') {
        return res.status(400).json({ error: 'You can only cancel an order before it has been paid for. Raise a dispute for orders already in progress.' });
      }

      if (userIsSeller && !userIsAdmin && !['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)) {
        return res.status(400).json({ error: 'This order has moved past the point a seller can cancel directly. An admin can cancel it, or raise a dispute.' });
      }

      const reason = req.body?.reason || null;
      const cancelledByRole = userIsAdmin ? 'ADMIN' : userIsBuyer ? 'BUYER' : 'SELLER';

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: order.id },
          include: { transportJob: true, payments: true },
        });

        await cancelOrderInTransaction(tx, {
          order: current, actorId: req.user.id, reason, cancelledByRole,
        });

        return tx.order.findUnique({ where: { id: current.id }, include: orderDetailInclude });
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Order cancelled.', order: updated });
    } catch (error) {
      req.log.error({ err: error }, 'CANCEL ORDER ERROR:');
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Failed to cancel order',
      });
    }
  }
);

module.exports = router;
