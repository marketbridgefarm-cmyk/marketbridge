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
const {
  noticeWaitingUnlocked,
  notifyInspectionBiddersServiceCancelled,
  notifyTransportBiddersServiceCancelled,
} = require('../services/waitingListService');
const { getInspectionPriceSuggestion, marketSnapshotData } = require('../services/marketPriceService');

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

const userSelect = { id: true, name: true, phone: true, location: true, rating: true, verificationStatus: true };

const transportInclude = {
  loadingReport: { include: { submittedBy: { select: { id: true, name: true } } } },
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

// ============================================================================
// LIGHTWEIGHT include for the Orders list page (GET /)
// ============================================================================
const orderListInclude = {
  listing: {
    select: {
      id: true,
      cropType: true,
      title: true,
      photos: true,
    },
  },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: {
    select: {
      id: true,
      status: true,
      method: true,
    },
  },
  payments: {
    select: { id: true, type: true, status: true, amount: true, method: true },
  },
  _count: {
    select: { events: true, disputes: true, messages: true },
  },
};

// ============================================================================
// HEAVY include for the Order Detail page (GET /:id)
// ============================================================================
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
  priceReviews: { include: { proposedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: { include: { ...transportInclude, loadingReport: true } },
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
    take: 50,
    include: { actor: { select: { id: true, name: true } } },
  },
  disputes: true,
  ratings: true,
  messages: { orderBy: { createdAt: 'asc' }, take: 50 },
  // Recovery requests — the read model uses this to suppress a duplicate
  // recovery action while one is already awaiting admin review.
  recoveryRequests: {
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
    take: 1,
    select: { id: true, type: true },
  },
};

// ============================================================================
// POST /api/orders/buy-now — intentionally disabled
// ============================================================================
router.post('/buy-now', authenticate, idempotency('orders.buy-now'), async (req, res) => {
  return res.status(410).json({
    code: 'NEGOTIATION_REQUIRED',
    error: 'Direct purchase is not available. Submit a bid first; the seller must select a buyer and complete the negotiation before payment.',
  });
});

// ============================================================================
// GET /api/orders — lightweight list with pagination
// ============================================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const adminView = req.user.roles?.includes('ADMIN');
    const where = adminView ? {} : { OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }] };

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
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

// ============================================================================
// GET /api/orders/:id — full order detail
// ============================================================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: orderDetailInclude,
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const assignedInspector = Boolean(
      order.inspectionRequests?.some((request) => request.inspectorId === req.user.id)
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
        id: true,
        payeeRole: true,
        paymentId: true,
        status: true,
        releaseAt: true,
        releasedAt: true,
        paidOutAt: true,
        amount: true,
        currency: true,
        payoutReference: true,
      },
    });

    const payoutViews = payouts.map((payout) => ({
      id: payout.id,
      payeeRole: payout.payeeRole,
      status: payout.status,
      releaseAt: payout.releaseAt,
      releasedAt: payout.releasedAt,
      paidOutAt: payout.paidOutAt,
      amount: payout.amount,
      currency: payout.currency,
      payoutReference: payout.payoutReference,
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
        id: true,
        paymentId: true,
        amount: true,
        currency: true,
        status: true,
        reason: true,
        failureReason: true,
        createdAt: true,
        completedAt: true,
        payment: { select: { type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const roleByPaymentId = new Map(payouts.map((payout) => [payout.paymentId, payout.payeeRole]));
    const roleByPaymentType = { MARKETPLACE: 'SELLER', TRANSPORT: 'TRANSPORTER', INSPECTOR: 'INSPECTOR' };

    const refundViews = refundRows.map((refund) => ({
      id: refund.id,
      payeeRole: roleByPaymentId.get(refund.paymentId) || roleByPaymentType[refund.payment?.type] || null,
      status: refund.status,
      amount: refund.amount,
      currency: refund.currency,
      requestedAt: refund.createdAt,
      completedAt: refund.completedAt,
      reason: viewerIsAdmin || viewerIsBuyer ? refund.reason : null,
      failureReason: viewerIsAdmin ? refund.failureReason : null,
    }));

    const priceReviewSuggestion = await getInspectionPriceSuggestion(prisma, order).catch((error) => {
      req.log.warn({ err: error, orderId: order.id }, 'PRICE REVIEW SUGGESTION FAILED');
      return null;
    });

    return res.json({
      order: {
        ...order,
        priceReviewSuggestion,
        payouts: payoutViews,
        refunds: refundViews,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET ORDER ERROR:');
    return res.status(500).json({ error: 'Failed to load order' });
  }
});

// ============================================================================
// GET /api/orders/:id/workflow
// ============================================================================
router.get('/:id/workflow', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: orderDetailInclude,
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const assignedInspector = Boolean(
      order.inspectionRequests?.some((request) => request.inspectorId === req.user.id)
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

// ============================================================================
// PRICE REVIEW
// ============================================================================
const PRICE_REVIEW_REASONS = new Set([
  'MARKET_PRICE_RISE', 'MARKET_PRICE_FALL', 'QUALITY_OR_QUANTITY_CHANGE',
  'FRESHNESS_OR_DAMAGE', 'OTHER_INSPECTION_FINDING',
]);

router.post('/:id/price-reviews', authenticate, idempotency('orders.price-review-create'), [
  param('id').isUUID(),
  body('proposedPrice').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('reasonCode').optional({ nullable: true }).isIn([...PRICE_REVIEW_REASONS]),
], validate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: {
      listing: { select: { id: true, category: true, title: true, cropType: true, unit: true, quantity: true, askingPrice: true, location: true, region: true, minAcceptablePrice: true } },
      inspectionRequests: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 1, include: { report: true } },
      payments: { where: { type: 'MARKETPLACE', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true, status: true } },
      priceReviews: { where: { status: 'PENDING' }, select: { id: true } },
    }});
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (![order.buyerId, order.sellerId].includes(req.user.id)) return res.status(403).json({ error: 'Only the buyer or seller can request a price review' });
    if (!['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category)) return res.status(400).json({ error: 'Price review is only available for goods orders' });
    if (['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status) || order.payments.length || order.buyerDecision === 'BUY') return res.status(409).json({ error: 'Price review is unavailable after cancellation, dispute, completion, price confirmation, or once goods payment has started' });
    const inspection = order.inspectionRequests[0];
    if (!inspection || inspection.status !== 'COMPLETED' || !inspection.report) return res.status(409).json({ error: 'A completed inspection report is required before price review' });
    if (order.priceReviews.length) return res.status(409).json({ error: 'A price review is already awaiting a response' });
    if (order.buyerDecision === 'CANCEL') return res.status(409).json({ error: 'This order has already been cancelled after inspection' });

    const suggestion = await getInspectionPriceSuggestion(prisma, order);
    const amount = req.body.proposedPrice == null ? Number(suggestion?.suggestedPrice) : Number(req.body.proposedPrice);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A valid proposed price is required. The platform could not calculate a price suggestion from the available market/inspection data.' });
    const minimumTotal = order.listing?.minAcceptablePrice == null ? null : Number(order.listing.minAcceptablePrice) * Number(order.quantity || 0);
    if (Number.isFinite(minimumTotal) && minimumTotal > 0 && amount < minimumTotal) return res.status(409).json({ error: "The proposed price is below the seller's minimum acceptable price" });
    const reasonCode = req.body.reasonCode || suggestion?.suggestedReasonCode || 'OTHER_INSPECTION_FINDING';
    if (!PRICE_REVIEW_REASONS.has(reasonCode)) return res.status(400).json({ error: 'A valid price-review reason is required' });
    const snapshot = marketSnapshotData(suggestion?.marketReference, suggestion?.inspectedQuantity || order.quantity);
    const review = await prisma.$transaction(async tx => {
      const current = await tx.order.findUnique({ where: { id: order.id }, select: { finalPrice: true, buyerDecision: true, status: true } });
      if (!current || ['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(current.status)) throw Object.assign(new Error('Order is no longer available for price review'), { status: 409 });
      const open = await tx.priceReview.findFirst({ where: { orderId: order.id, status: 'PENDING' }, select: { id: true } });
      if (open) throw Object.assign(new Error('A price review is already awaiting a response'), { status: 409 });
      if (Number(current.finalPrice) === amount) throw Object.assign(new Error('The proposed price must differ from the current agreed price'), { status: 400 });
      return tx.priceReview.create({ data: { orderId: order.id, proposedById: req.user.id, proposedPrice: amount, reasonCode, ...snapshot, originalUnitPrice: suggestion?.originalUnitPrice ?? null, inspectedQuantity: suggestion?.inspectedQuantity ?? null, quantityAdjustedPrice: suggestion?.quantityAdjustedPrice ?? null, suggestedPrice: suggestion?.suggestedPrice ?? null, adjustmentAmount: suggestion?.adjustmentAmount ?? null, adjustmentPercent: suggestion?.adjustmentPercent ?? null, calculationVersion: suggestion?.calculationVersion ?? null }, include: { proposedBy: { select: { id: true, name: true } } } });
    });
    await recordOrderEvent(prisma, { orderId: order.id, actorId: req.user.id, type: 'PRICE_REVIEW_PROPOSED', metadata: { priceReviewId: review.id, proposedPrice: amount, reasonCode: review.reasonCode } }).catch(err => req.log.error({err}, 'PRICE REVIEW EVENT FAILED'));
    return res.status(201).json({ message: 'Price review proposal submitted; the other party must respond.', priceReview: review, suggestion });
  } catch (error) {
    req.log.error({ err: error }, 'CREATE PRICE REVIEW ERROR');
    return res.status(error.status || (error.code === 'P2002' ? 409 : 500)).json({ error: error.message || (error.code === 'P2002' ? 'A price review is already awaiting a response' : 'Could not submit price review') });
  }
});

router.patch('/:id/price-reviews/:reviewId/respond', authenticate, idempotency('orders.price-review-respond'), [
  param('id').isUUID(), param('reviewId').isUUID(),
  body('action').isIn(['ACCEPT', 'COUNTER', 'REJECT']),
  body('proposedPrice').optional().isFloat({ gt: 0 }),
  body('reasonCode').optional().isIn([...PRICE_REVIEW_REASONS]),
], validate, async (req, res) => {
  try {
    const result = await prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: req.params.id }, select: { id: true, buyerId: true, sellerId: true, finalPrice: true, originalFinalPrice: true, quantity: true, buyerDecision: true, status: true, paymentDueAt: true, listing: { select: { id: true, category: true, title: true, cropType: true, unit: true, quantity: true, askingPrice: true, location: true, region: true, minAcceptablePrice: true } }, inspectionRequests: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 1, include: { report: true } }, payments: { where: { type: 'MARKETPLACE', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true, status: true } } } });
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (![order.buyerId, order.sellerId].includes(req.user.id)) throw Object.assign(new Error('Only the buyer or seller can respond'), { status: 403 });
      if (['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status) || order.payments.length || order.buyerDecision === 'BUY') throw Object.assign(new Error('Price review is closed for this order once goods payment has started or the order is no longer active'), { status: 409 });
      const review = await tx.priceReview.findUnique({ where: { id: req.params.reviewId }, include: { proposedBy: { select: { id: true, name: true } } } });
      if (!review || review.orderId !== order.id) throw Object.assign(new Error('Price review not found'), { status: 404 });
      if (review.status !== 'PENDING') throw Object.assign(new Error('This proposal is no longer awaiting a response'), { status: 409 });
      if (review.proposedById === req.user.id) throw Object.assign(new Error('The proposer cannot respond to their own proposal'), { status: 403 });
      if (req.body.action === 'COUNTER') {
        const claimed = await tx.priceReview.updateMany({ where: { id: review.id, status: 'PENDING' }, data: { status: 'COUNTERED' } });
        if (claimed.count !== 1) throw Object.assign(new Error('This proposal was already answered. Refresh and try again.'), { status: 409 });
        if (!req.body.proposedPrice || !req.body.reasonCode) throw Object.assign(new Error('Counter price and reason are required'), { status: 400 });
        if (Number(req.body.proposedPrice) === Number(review.proposedPrice)) throw Object.assign(new Error('Counter price must differ from the current proposal'), { status: 400 });
        const minimumTotal = order.listing?.minAcceptablePrice == null ? null : Number(order.listing.minAcceptablePrice) * Number(order.quantity || 0);
        if (Number.isFinite(minimumTotal) && minimumTotal > 0 && Number(req.body.proposedPrice) < minimumTotal) throw Object.assign(new Error('The counter price is below the seller\'s minimum acceptable price'), { status: 409 });
        const suggestion = await getInspectionPriceSuggestion(tx, order);
        const counterSnapshot = marketSnapshotData(suggestion?.marketReference, suggestion?.inspectedQuantity || order.quantity);
        const child = await tx.priceReview.create({ data: { orderId: order.id, proposedById: req.user.id, proposedPrice: Number(req.body.proposedPrice), reasonCode: req.body.reasonCode, parentId: review.id, ...counterSnapshot, originalUnitPrice: suggestion?.originalUnitPrice ?? null, inspectedQuantity: suggestion?.inspectedQuantity ?? null, quantityAdjustedPrice: suggestion?.quantityAdjustedPrice ?? null, suggestedPrice: suggestion?.suggestedPrice ?? null, adjustmentAmount: Number(req.body.proposedPrice) - Number(order.finalPrice), adjustmentPercent: Number(order.finalPrice) > 0 ? ((Number(req.body.proposedPrice) - Number(order.finalPrice)) / Number(order.finalPrice)) * 100 : null, calculationVersion: suggestion?.calculationVersion ?? null }, include: { proposedBy: { select: { id: true, name: true } } } });
        return { action: 'COUNTER', priceReview: child };
      }
      if (req.body.action === 'REJECT') {
        const claimed = await tx.priceReview.updateMany({ where: { id: review.id, status: 'PENDING' }, data: { status: 'REJECTED' } });
        if (claimed.count !== 1) throw Object.assign(new Error('This proposal was already answered. Refresh and try again.'), { status: 409 });
        return { action: 'REJECT', priceReview: { ...review, status: 'REJECTED' } };
      }
      const now = new Date();
      const claimed = await tx.priceReview.updateMany({ where: { id: review.id, status: 'PENDING' }, data: { status: 'ACCEPTED' } });
      if (claimed.count !== 1) throw Object.assign(new Error('This proposal was already answered. Refresh and try again.'), { status: 409 });
      await tx.order.update({ where: { id: order.id }, data: { finalPrice: review.proposedPrice, buyerDecision: 'BUY', buyerDecisionAt: now, buyerReviewedReportAt: now, paymentDueAt: computePaymentDueAt() } });
      return { action: 'ACCEPT', priceReview: { ...review, status: 'ACCEPTED' }, agreedPrice: review.proposedPrice };
    }, { maxWait: 10000, timeout: 15000 });
    await recordOrderEvent(prisma, { orderId: req.params.id, actorId: req.user.id, type: `PRICE_REVIEW_${result.action}`, metadata: { priceReviewId: result.priceReview.id, proposedPrice: result.agreedPrice ?? result.priceReview.proposedPrice } }).catch(err => req.log.error({err}, 'PRICE REVIEW RESPONSE EVENT FAILED'));
    return res.json({ message: result.action === 'ACCEPT' ? 'Revised price accepted by both parties. Goods payment is now available.' : result.action === 'COUNTER' ? 'Counter-proposal submitted; awaiting the other party.' : 'Price review proposal rejected.', ...result });
  } catch (error) {
    req.log.error({ err: error }, 'RESPOND PRICE REVIEW ERROR');
    return res.status(error.status || 500).json({ error: error.message || 'Could not respond to price review' });
  }
});

// ============================================================================
// PATCH /api/orders/:id/buyer-decision
// ============================================================================

// Captures the still-PENDING waiting bidders across inspection and transport
// scopes before an order is cancelled. cancelOrderInTransaction moves every
// PENDING quote to REJECTED inside its own transaction, so this snapshot must
// be taken before that runs and used to notify the bidders after commit.
async function capturePendingBidders(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      listingId: true,
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        select: {
          id: true,
          quotes: {
            where: { status: 'PENDING', childQuotes: { none: {} } },
            select: { id: true, inspectorId: true },
          },
        },
      },
      transportJob: {
        select: {
          id: true,
          status: true,
          quotes: {
            where: { status: 'PENDING', childQuotes: { none: {} } },
            select: { id: true, truckOwnerId: true },
          },
        },
      },
    },
  }).catch(() => null);
  return order;
}

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
          const pendingReview = await tx.priceReview.findFirst({ where: { orderId: current.id, status: 'PENDING' }, select: { id: true } });
          if (pendingReview) throw Object.assign(new Error('Respond to the pending price review before proceeding to payment.'), { status: 409, code: 'PRICE_REVIEW_PENDING' });
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

        if (decision === 'BUY') {
          const transportJob = current.transportJob;
          if (!transportJob || transportJob.status !== 'ACCEPTED') {
            throw Object.assign(new Error(
              'Select and agree a transporter before making the final BUY decision.'
            ), { status: 409, code: 'TRANSPORT_SELECTION_REQUIRED_FOR_BUY' });
          }
          const confirmed = await tx.transportJob.findUnique({
            where: { id: transportJob.id },
            select: { status: true, sellerPickupConfirmedAt: true },
          });
          if (!confirmed?.sellerPickupConfirmedAt) {
            throw Object.assign(new Error(
              'The seller must confirm that the selected transporter is prepared before the final BUY decision and seller payment can proceed.'
            ), { status: 409, code: 'SELLER_TRANSPORT_PREPARATION_CONFIRMATION_REQUIRED' });
          }
        }

        if (decision === 'CANCEL') {
          // CANCEL closes this order but NOT the listing's negotiation: the
          // cancel transaction withdraws the buyer's agreed offer and calls
          // promoteNextWaitingBuyer, so the next PENDING offer is
          // automatically selected. This is how the model expresses
          // "return to selection" at the order level — an Order cannot be
          // reassigned to a different buyer, so a new order is created from
          // the next promoted offer instead.
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
            paymentDueAt: computePaymentDueAt(),
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
        // Order cancelled after inspection: the seller may select another
        // waiting bidder. Offers waiting list is listing-scoped; inspection
        // and transport waiting bidders were captured before the cancel
        // transaction ran and are notified here.
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

    return res.json({ message: 'Receipt confirmed. Order completed.', order: updatedOrder });
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
          error: 'You can only cancel an order before it has been paid for. Raise a dispute for orders already in progress.',
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

      // Inspection and transport waiting lists: captured before the cancel
      // transaction ran, notified after, since the cancel transaction moves
      // every PENDING quote to REJECTED inside itself.
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
