'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { computeOrderWorkflow } = require('../services/orderWorkflowService');
const { idempotency } = require('../middleware/idempotency');
const { getInspectionPriceSuggestion } = require('../services/marketPriceService');

const {
  orderListInclude,
  orderDetailInclude,
} = require('../services/orderIncludes');

const {
  applySealedBidVisibility,
} = require('../services/orderHelpers');

// ============================================================================
// ORDERS — read-only endpoints
// ============================================================================
//
// This file now serves only the read-side of the orders API plus the
// disabled /buy-now shim. Every other route has been extracted:
//
//   • Price reviews          → routes/orderPriceReviews.js
//   • Buyer decision         → routes/orderLifecycle.js
//   • Receipt confirmation   → routes/orderLifecycle.js
//   • Cancel order           → routes/orderLifecycle.js
//
// Same behavior, same responses. Pure reorganisation.
// ============================================================================

const router = express.Router();

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

    // FIXED: strip sealed-bid details before the order leaves the server.
    // Admins and arranging parties still get the full quote list; the assigned
    // transporter gets their own bids only; the non-arranging buyer/seller
    // gets an aggregate summary; everyone else gets nothing.
    const visibleOrder = await applySealedBidVisibility(order, req.user.id, req.user.roles || []);

    return res.json({
      order: {
        ...visibleOrder,
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

module.exports = router;
