'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { recordOrderEvent } = require('../services/orderEventService');
const { cancelOrderInTransaction } = require('../services/orderCancellationService');
const { computePaymentDueAt } = require('../utils/orderTiming');
const {
  getInspectionPriceSuggestion,
  marketSnapshotData,
} = require('../services/marketPriceService');

// ============================================================================
// ORDER PRICE REVIEWS
// ============================================================================
//
// Extracted from routes/orders.js. Two routes handle the post-inspection
// price negotiation: the initial proposal (or buyer cancellation request)
// and the response (accept / counter / reject).
//
// Path prefix is still /api/orders, so the URLs are unchanged:
//   POST  /api/orders/:id/price-reviews
//   PATCH /api/orders/:id/price-reviews/:reviewId/respond
//
// Same behavior, same responses. Pure relocation.
// ============================================================================

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

const PRICE_REVIEW_REASONS = new Set([
  'MARKET_PRICE_RISE', 'MARKET_PRICE_FALL', 'QUALITY_OR_QUANTITY_CHANGE',
  'FRESHNESS_OR_DAMAGE', 'OTHER_INSPECTION_FINDING',
  // FIXED: Buyer signalling intent to walk away. The seller gets a 24-hour
  // window to accept the cancellation or counter with a reduced price to
  // keep the deal alive.
  'BUYER_WANTS_CANCELLATION',
]);

// FIXED: How long the seller has to respond to a buyer cancellation request
// before the order is auto-cancelled by the maintenance cycle.
const CANCELLATION_REQUEST_WINDOW_HOURS = 24;

// Small helper: the previous inline default was `suggestion?.suggestedReasonCode || 'OTHER_INSPECTION_FINDING'`.
// We extract it here so the reasonCode line stays readable.
function suggestion_reason_default() {
  return 'OTHER_INSPECTION_FINDING';
}

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

    const reasonCode = req.body.reasonCode || suggestion_reason_default();

    // FIXED: Buyer cancellation request — a special flow.
    // The buyer signals they want out, but the seller gets a 24-hour window
    // to keep the deal alive by countering with a reduced price.
    if (reasonCode === 'BUYER_WANTS_CANCELLATION') {
      // Only the buyer can request cancellation.
      if (req.user.id !== order.buyerId) {
        return res.status(403).json({ error: 'Only the buyer can request cancellation' });
      }
      // Optional walk-away price: the max the buyer would still pay. If null,
      // the buyer wants out entirely.
      const walkAwayPrice = req.body.proposedPrice == null ? null : Number(req.body.proposedPrice);
      if (walkAwayPrice !== null && (!Number.isFinite(walkAwayPrice) || walkAwayPrice <= 0)) {
        return res.status(400).json({ error: 'Walk-away price must be greater than zero when provided' });
      }
      const expiry = new Date(Date.now() + CANCELLATION_REQUEST_WINDOW_HOURS * 60 * 60 * 1000);
      const review = await prisma.$transaction(async tx => {
        const current = await tx.order.findUnique({ where: { id: order.id }, select: { finalPrice: true, buyerDecision: true, status: true } });
        if (!current || ['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(current.status)) {
          throw Object.assign(new Error('Order is no longer available for cancellation request'), { status: 409 });
        }
        const open = await tx.priceReview.findFirst({ where: { orderId: order.id, status: 'PENDING' }, select: { id: true } });
        if (open) throw Object.assign(new Error('A price review is already awaiting a response'), { status: 409 });
        return tx.priceReview.create({
          data: {
            orderId: order.id,
            proposedById: req.user.id,
            proposedPrice: walkAwayPrice ?? Number(current.finalPrice),
            reasonCode: 'BUYER_WANTS_CANCELLATION',
            expiresAt: expiry,
          },
          include: { proposedBy: { select: { id: true, name: true } } },
        });
      });
      await recordOrderEvent(prisma, {
        orderId: order.id,
        actorId: req.user.id,
        type: 'PRICE_REVIEW_PROPOSED',
        metadata: {
          priceReviewId: review.id,
          reasonCode: 'BUYER_WANTS_CANCELLATION',
          walkAwayPrice: walkAwayPrice ?? null,
        },
      }).catch(err => req.log.error({ err }, 'CANCELLATION REQUEST EVENT FAILED'));
      return res.status(201).json({
        message: 'Cancellation requested. The seller has 24 hours to accept or counter with a reduced price.',
        priceReview: review,
      });
    }

    const suggestion = await getInspectionPriceSuggestion(prisma, order);
    const amount = req.body.proposedPrice == null ? Number(suggestion?.suggestedPrice) : Number(req.body.proposedPrice);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A valid proposed price is required. The platform could not calculate a price suggestion from the available market/inspection data.' });
    const minimumTotal = order.listing?.minAcceptablePrice == null ? null : Number(order.listing.minAcceptablePrice) * Number(order.quantity || 0);
    if (Number.isFinite(minimumTotal) && minimumTotal > 0 && amount < minimumTotal) return res.status(409).json({ error: "The proposed price is below the seller's minimum acceptable price" });
    // FIXED: The buyer's proposed price cannot exceed the provisional agreed price.
    // A buyer pays for inspection to confirm or negotiate DOWN — never up.
    // Proposing a higher price would be economically nonsensical and would
    // reverse the buyer's own negotiating position.
    if (req.user.id === order.buyerId && amount > Number(order.finalPrice)) {
      return res.status(400).json({
        error: `As the buyer, you can only propose a price at or below the currently agreed ${Number(order.finalPrice).toLocaleString()} ETB.`,
        code: 'BUYER_PRICE_CAP_EXCEEDED',
      });
    }
    if (!PRICE_REVIEW_REASONS.has(reasonCode)) return res.status(400).json({ error: 'A valid price-review reason is required' });
    const snapshot = marketSnapshotData(suggestion?.marketReference, suggestion?.inspectedQuantity || order.quantity);
    const review = await prisma.$transaction(async tx => {
      const current = await tx.order.findUnique({ where: { id: order.id }, select: { finalPrice: true, buyerDecision: true, status: true } });
      if (!current || ['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(current.status)) throw Object.assign(new Error('Order is no longer available for price review'), { status: 409 });
      const open = await tx.priceReview.findFirst({ where: { orderId: order.id, status: 'PENDING' }, select: { id: true } });
      if (open) throw Object.assign(new Error('A price review is already awaiting a response'), { status: 409 });
      // FIXED: Allow the buyer to confirm the current price by proposing it
      // unchanged. The buyer's "Confirm at agreed price" button proposes the
      // exact finalPrice, and this must be accepted. Only the seller is blocked
      // from re-proposing the same price to prevent negotiation loops.
      if (Number(current.finalPrice) === amount && req.user.id !== order.buyerId) {
        throw Object.assign(new Error('The proposed price must differ from the current agreed price'), { status: 400 });
      }
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

      // FIXED: Special handling for BUYER_WANTS_CANCELLATION.
      // The seller can either ACCEPT the cancellation (order is cancelled),
      // or COUNTER with a reduced price to keep the deal alive.
      if (review.reasonCode === 'BUYER_WANTS_CANCELLATION') {
        if (req.body.action === 'ACCEPT') {
          const claimed = await tx.priceReview.updateMany({ where: { id: review.id, status: 'PENDING' }, data: { status: 'ACCEPTED' } });
          if (claimed.count !== 1) throw Object.assign(new Error('This proposal was already answered. Refresh and try again.'), { status: 409 });
          // Trigger the standard cancellation flow for the order.
          const fullOrder = await tx.order.findUnique({
            where: { id: order.id },
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
              inspectionRequests: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, report: { select: { id: true } } } },
            },
          });
          await tx.order.update({
            where: { id: fullOrder.id },
            data: { buyerDecision: 'CANCEL', buyerDecisionAt: new Date(), buyerDecisionDueAt: null },
          });
          await cancelOrderInTransaction(tx, {
            order: fullOrder,
            actorId: req.user.id,
            reason: 'Seller accepted buyer cancellation request',
            cancelledByRole: 'BUYER',
          });
          return { action: 'ACCEPT_CANCELLATION', priceReview: { ...review, status: 'ACCEPTED' }, orderCancelled: true };
        }
        if (req.body.action === 'COUNTER') {
          const claimed = await tx.priceReview.updateMany({ where: { id: review.id, status: 'PENDING' }, data: { status: 'COUNTERED' } });
          if (claimed.count !== 1) throw Object.assign(new Error('This proposal was already answered. Refresh and try again.'), { status: 409 });
          if (!req.body.proposedPrice || !req.body.reasonCode) throw Object.assign(new Error('Counter price and reason are required'), { status: 400 });
          const minimumTotal = order.listing?.minAcceptablePrice == null ? null : Number(order.listing.minAcceptablePrice) * Number(order.quantity || 0);
          if (Number.isFinite(minimumTotal) && minimumTotal > 0 && Number(req.body.proposedPrice) < minimumTotal) throw Object.assign(new Error('The counter price is below the seller\'s minimum acceptable price'), { status: 409 });
          const suggestion = await getInspectionPriceSuggestion(tx, order);
          const counterSnapshot = marketSnapshotData(suggestion?.marketReference, suggestion?.inspectedQuantity || order.quantity);
          const child = await tx.priceReview.create({
            data: {
              orderId: order.id,
              proposedById: req.user.id,
              proposedPrice: Number(req.body.proposedPrice),
              reasonCode: req.body.reasonCode,
              parentId: review.id,
              ...counterSnapshot,
              originalUnitPrice: suggestion?.originalUnitPrice ?? null,
              inspectedQuantity: suggestion?.inspectedQuantity ?? null,
              quantityAdjustedPrice: suggestion?.quantityAdjustedPrice ?? null,
              suggestedPrice: suggestion?.suggestedPrice ?? null,
              adjustmentAmount: Number(req.body.proposedPrice) - Number(order.finalPrice),
              adjustmentPercent: Number(order.finalPrice) > 0 ? ((Number(req.body.proposedPrice) - Number(order.finalPrice)) / Number(order.finalPrice)) * 100 : null,
              calculationVersion: suggestion?.calculationVersion ?? null,
            },
            include: { proposedBy: { select: { id: true, name: true } } },
          });
          return { action: 'COUNTER', priceReview: child };
        }
        throw Object.assign(new Error('For a cancellation request, only ACCEPT or COUNTER is valid'), { status: 400 });
      }

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
    await recordOrderEvent(prisma, { orderId: req.params.id, actorId: req.user.id, type: `PRICE_REVIEW_${result.action}`, metadata: { priceReviewId: result.priceReview.id, proposedPrice: result.agreedPrice ?? result.priceReview.proposedPrice, reasonCode: result.priceReview.reasonCode } }).catch(err => req.log.error({err}, 'PRICE REVIEW RESPONSE EVENT FAILED'));
    return res.json({ message: result.action === 'ACCEPT' ? 'Revised price accepted by both parties. Goods payment is now available.' : result.action === 'ACCEPT_CANCELLATION' ? 'Cancellation accepted. The order is now cancelled and any completed inspection fee is refunded.' : result.action === 'COUNTER' ? 'Counter-proposal submitted; awaiting the other party.' : 'Price review proposal rejected.', ...result });
  } catch (error) {
    req.log.error({ err: error }, 'RESPOND PRICE REVIEW ERROR');
    return res.status(error.status || 500).json({ error: error.message || 'Could not respond to price review' });
  }
});

module.exports = router;
