const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const { computeInspectionWorkflowDueAt, computePaymentDueAt } = require('../utils/orderTiming');
const {
  AMOUNT_LIMITS,
  validAmount,
  noContactInfo,
} = require('../utils/contactGuard');
const {
  assertCoordinationStage,
  viewerRoleFor,
  closeCoordination,
  ensureOpenCoordination,
} = require('../services/inspectionCoordinationService');

const router = express.Router();

function validationError(res) {
  const errors = validationResult(res.req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
  }
  return null;
}

function isPositiveNumber(value) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number > 0;
}

function quoteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// ============================================================================
// FIXED: quoteTurn
// ----------------------------------------------------------------------------
// Whose turn it is to respond to the current leaf quote.
//
//   PENDING    → REQUESTER must respond (select / reject / counter a raw bid)
//   SELECTED   → either party may act (requester picked this inspector; the
//                price negotiation is now open in BOTH directions until
//                someone accepts)
//   COUNTERED  → whichever side did NOT make the most recent counter
//
// Returns null when there is no turn restriction (both sides may act).
// ============================================================================
function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'SELECTED') return null;
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function isQuoteExpired(quote) {
  return Boolean(quote.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
}

function quoteExpiry(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// ============================================================================
// CREATE INSPECTION REQUEST
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),
  [
    body('orderId').isUUID().withMessage('orderId is required'),
    body('listingId').optional().isUUID(),
    body('mode')
      .isIn(['SELLER_REQUESTED', 'BUYER_REQUESTED', 'JOINT'])
      .withMessage('Invalid inspection mode'),
    body('feePayer')
      .optional()
      .isIn(['BUYER', 'SELLER', 'SPLIT'])
      .withMessage('feePayer must be BUYER, SELLER or SPLIT'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
      }

      const { orderId, listingId, mode } = req.body;
      const requestedFeePayer = req.body.feePayer || (mode === 'SELLER_REQUESTED' ? 'SELLER' : mode === 'JOINT' ? 'SPLIT' : 'BUYER');
      if (mode === 'SELLER_REQUESTED' && requestedFeePayer !== 'SELLER') return res.status(400).json({ error: 'Seller-requested inspections are seller-paid' });
      if (mode === 'BUYER_REQUESTED' && requestedFeePayer !== 'BUYER') return res.status(400).json({ error: 'Buyer-requested inspections are buyer-paid' });

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { listing: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.buyerId !== req.user.id && order.sellerId !== req.user.id && !req.user.roles.includes('ADMIN')) {
        return res.status(403).json({ error: 'Only the buyer or seller of the order can request inspection' });
      }

      if (req.user.roles.includes('INSPECTOR') && (order.buyerId === req.user.id || order.sellerId === req.user.id || order.listing?.createdByInspectorId === req.user.id)) {
        return res.status(403).json({ error: 'An inspector cannot request or perform an inspection on their own transaction or listing' });
      }

      if (['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status)) {
        return res.status(409).json({ error: `Inspection cannot be requested for an order that is ${order.status.toLowerCase()}` });
      }

      if (!['AGRICULTURAL', 'PRODUCT'].includes(order.listing.category)) {
        return res.status(400).json({ error: 'Inspections are only available for agricultural and product listings' });
      }
      if (!order.listing.inspectionRequired && order.listing.category === 'PRODUCT') {
        // Product inspections are opt-in. The buyer or seller may still request
        // one explicitly from the order page; the listing flag controls whether
        // the workflow is mandatory.
      }

      const resolvedListingId = order.listingId;

      if (req.body?.inspectorId || req.body?.fee) {
        return res.status(400).json({
          code: 'COMPETITIVE_INSPECTION_REQUIRED',
          error: 'Choose an inspector from the submitted competitive quotes. Direct inspector selection is not available.',
        });
      }

      const request = await prisma.$transaction(async (tx) => {
        const existingActive = await tx.inspectionRequest.findFirst({
          where: { orderId: order.id, status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, inspectorId: true, fee: true, createdAt: true },
        });

        if (existingActive) {
          const error = new Error('An inspection already exists for this order. Continue with the existing inspection.');
          error.statusCode = 409;
          error.existingInspection = existingActive;
          throw error;
        }

        const created = await tx.inspectionRequest.create({
          data: {
            orderId: order.id,
            listingId: resolvedListingId,
            requestedById: req.user.id,
            mode,
            location: order.listing.location || null,
            inspectorId: null,
            status: 'REQUESTED',
            workflowDueAt: computeInspectionWorkflowDueAt(),
            fee: null,
            feePayer: requestedFeePayer,
            buyerFeeAmount: null,
            sellerFeeAmount: null,
          },
          include: {
            listing: {
              select: {
                id: true, cropType: true, title: true, quantity: true, unit: true,
                location: true, category: true,
              },
            },
            inspector: {
              select: { id: true, name: true, rating: true, location: true },
            },
          },
        });

        if (order.id && order.status === 'PENDING_PAYMENT') {
          await tx.order.update({ where: { id: order.id }, data: { paymentDueAt: computeInspectionWorkflowDueAt() } });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REQUEST_CREATED',
          resourceType: 'InspectionRequest',
          resourceId: created.id,
          metadata: { orderId: order.id, listingId: resolvedListingId, mode, competitiveSelection: true },
        });

        return created;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ request });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
          code: 'ACTIVE_INSPECTION_EXISTS',
          existingInspection: error.existingInspection || null,
        });
      }

      req.log.error({ err: error }, 'CREATE INSPECTION REQUEST ERROR:');
      return res.status(500).json({ error: 'Could not create inspection request' });
    }
  }
);

// ============================================================================
// CANCEL INSPECTION REQUEST
// ============================================================================

router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!request.order) return res.status(409).json({ error: 'This inspection is not attached to an order' });
    if (request.order.buyerId !== req.user.id && request.order.sellerId !== req.user.id && !req.user.roles.includes('ADMIN')) return res.status(403).json({ error: 'Only an order participant can cancel this inspection request' });
    if (request.status === 'CANCELLED') return res.json({ message: 'Inspection request is already cancelled', request });
    if (['COMPLETED', 'IN_PROGRESS'].includes(request.status)) return res.status(409).json({ error: `An inspection cannot be cancelled while it is ${request.status.toLowerCase()}` });

    const activePayment = await prisma.payment.findFirst({ where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true, status: true } });
    if (activePayment) return res.status(409).json({ error: 'This inspection cannot be cancelled after inspection payment has started or completed' });

    const cancelled = await prisma.$transaction(async (tx) => {
      await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be cancelled until the order dispute is resolved');
      const fresh = await tx.inspectionRequest.findUnique({ where: { id: request.id } });
      if (!fresh) throw Object.assign(new Error('Inspection request not found'), { statusCode: 404 });
      if (['COMPLETED', 'IN_PROGRESS'].includes(fresh.status)) throw Object.assign(new Error(`An inspection cannot be cancelled while it is ${fresh.status.toLowerCase()}`), { statusCode: 409 });
      const updated = await tx.inspectionRequest.update({ where: { id: fresh.id }, data: { inspectorId: null, fee: null, status: 'CANCELLED' } });
      await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } }, data: { status: 'EXPIRED' } });
      await closeCoordination(tx, fresh.id, 'INSPECTION_CANCELLED');
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_REQUEST_CANCELLED', resourceType: 'InspectionRequest', resourceId: fresh.id, metadata: { orderId: fresh.orderId } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });
    return res.json({ message: 'Inspection request cancelled. You can open a new inspection request for this order.', request: cancelled });
  } catch (error) {
    req.log.error({ err: error }, 'CANCEL INSPECTION REQUEST ERROR:');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not cancel inspection request' });
  }
});

// ============================================================================
// REOPEN INSPECTION BIDDING
// ============================================================================

router.patch('/:id/reopen-bidding', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!['REQUESTED', 'ACCEPTED', 'STALLED'].includes(request.status)) return res.status(409).json({ error: `Inspection bidding cannot be reopened while the request is ${request.status.toLowerCase()}` });

    const activePayment = await prisma.payment.findFirst({ where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true, status: true } });
    if (activePayment) return res.status(409).json({ error: 'Bidding cannot be reopened after inspection payment has started or completed' });

    const reopened = await prisma.$transaction(async (tx) => {
      await lockOrderAndAssertNotClosed(tx, request.orderId, 'inspection bidding cannot be reopened until the order dispute is resolved');
      const fresh = await tx.inspectionRequest.findUnique({ where: { id: request.id } });
      if (!fresh) throw Object.assign(new Error('Inspection request not found'), { statusCode: 404 });
      if (!['REQUESTED', 'ACCEPTED', 'STALLED'].includes(fresh.status)) throw Object.assign(new Error(`Inspection bidding cannot be reopened while the request is ${fresh.status.toLowerCase()}`), { statusCode: 409 });
      await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
      const updated = await tx.inspectionRequest.update({ where: { id: fresh.id }, data: { inspectorId: null, fee: null, buyerFeeAmount: null, sellerFeeAmount: null, sellerConfirmedAt: null, startDueAt: null, completionDueAt: null, startedAt: null, status: 'REQUESTED' } });
      await closeCoordination(tx, fresh.id, 'ADMIN_REOPENED_BIDDING');
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_BIDDING_REOPENED', resourceType: 'InspectionRequest', resourceId: fresh.id, metadata: { orderId: fresh.orderId } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });
    return res.json({ message: 'Inspection bidding reopened. Previous bids were expired.', request: reopened });
  } catch (error) {
    req.log.error({ err: error }, 'REOPEN INSPECTION BIDDING ERROR:');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not reopen inspection bidding' });
  }
});

// ============================================================================
// FIND INSPECTORS
// ============================================================================

router.get('/inspectors', authenticate, async (req, res) => {
  try {
    const { location } = req.query;

    const inspectors = await prisma.user.findMany({
      where: {
        roles: { has: 'INSPECTOR' },
        ...(location ? { location: { contains: location, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        name: true,
        rating: true,
        location: true,
        verificationStatus: true,
      },
      orderBy: [{ rating: 'desc' }, { name: 'asc' }],
    });

    return res.json({ inspectors });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTORS ERROR:');
    return res.status(500).json({ error: 'Could not load inspectors' });
  }
});

// ============================================================================
// AVAILABLE INSPECTION REQUESTS
// ============================================================================

router.get(
  '/available',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const { location } = req.query;

      const requests = await prisma.inspectionRequest.findMany({
        where: {
          status: 'REQUESTED',
          inspectorId: null,
          ...(location ? { location: { contains: location, mode: 'insensitive' } } : {}),
        },
        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              title: true,
              quantity: true,
              unit: true,
              location: true,
              category: true,
            },
          },
          requestedBy: {
            select: { id: true, name: true, rating: true },
          },
          quotes: {
            where: {
              status: { in: ['PENDING', 'COUNTERED', 'ACCEPTED', 'REJECTED'] },
              inspectorId: req.user.id,
            },
            select: {
              id: true,
              inspectorId: true,
              amount: true,
              status: true,
              message: true,
              parentQuoteId: true,
              counterAmount: true,
              counteredBy: true,
              expiresAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ requests });
    } catch (error) {
      req.log.error({ err: error }, 'AVAILABLE INSPECTIONS ERROR:');
      return res.status(500).json({ error: 'Could not load available inspections' });
    }
  }
);

// ============================================================================
// INSPECTOR SUBMITS QUOTE
// ============================================================================

router.post(
  '/:id/quote',
  authenticate,
  requireRole('INSPECTOR'),
  [
    param('id').notEmpty(),
    body('amount').custom(validAmount(AMOUNT_LIMITS.inspection)),
    body('message')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Quote message is too long')
      .custom(noContactInfo),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: errors.array()[0]?.msg || 'Validation failed',
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
      });

      if (!request) {
        return res.status(404).json({ error: 'Inspection request not found' });
      }

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({ error: 'This inspection is no longer accepting quotes' });
      }

      const quoteOrder = request.orderId ? await prisma.order.findUnique({ where: { id: request.orderId }, select: { buyerId: true, sellerId: true, listing: { select: { createdByInspectorId: true } } } }) : null;
      if (req.user.id === quoteOrder?.buyerId || req.user.id === quoteOrder?.sellerId || req.user.id === quoteOrder?.listing?.createdByInspectorId) {
        return res.status(403).json({ error: 'You cannot inspect or quote on your own transaction or listing' });
      }

      if (request.requestedById === req.user.id) {
        return res.status(403).json({ error: 'You cannot quote on your own inspection request' });
      }

      const existing = await prisma.inspectionQuote.findFirst({
        where: {
          inspectionRequestId: request.id,
          inspectorId: req.user.id,
          status: { in: ['PENDING', 'COUNTERED'] },
          childQuotes: { none: {} },
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'You already have an active quote or negotiation for this inspection',
        });
      }

      const quote = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'an inspection quote cannot be submitted until the order dispute is resolved');

        const created = await tx.inspectionQuote.create({
          data: {
            inspectionRequestId: request.id,
            inspectorId: req.user.id,
            amount: Number(req.body.amount),
            message: req.body.message || null,
            status: 'PENDING',
            expiresAt: quoteExpiry(),
          },
          include: {
            inspector: {
              select: {
                id: true,
                name: true,
                rating: true,
                location: true,
                verificationStatus: true,
              },
            },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_SUBMITTED',
          resourceType: 'InspectionQuote',
          resourceId: created.id,
          metadata: { inspectionRequestId: request.id, amount: created.amount },
        });

        return created;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ quote });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not submit inspection quote' });
    }
  }
);

// ============================================================================
// VIEW QUOTES FOR AN INSPECTION
// ============================================================================

router.get(
  '/:id/quotes',
  authenticate,
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
        select: { id: true, requestedById: true },
      });

      if (!request) {
        return res.status(404).json({ error: 'Inspection request not found' });
      }

      if (request.requestedById !== req.user.id && !req.user.roles.includes('ADMIN')) {
        return res.status(403).json({ error: 'Only the inspection requester can view quotes' });
      }

      const quotes = await prisma.inspectionQuote.findMany({
        where: { inspectionRequestId: request.id },
        include: {
          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
              verificationStatus: true,
            },
          },
        },
        orderBy: [{ status: 'asc' }, { amount: 'asc' }, { createdAt: 'asc' }],
      });

      return res.json({ quotes });
    } catch (error) {
      req.log.error({ err: error }, 'GET INSPECTION QUOTES ERROR:');
      return res.status(500).json({ error: 'Could not load inspection quotes' });
    }
  }
);

// ============================================================================
// SHARED LOOKUP: request + leaf quote, with the caller's role
// ============================================================================

async function loadQuoteForNegotiation(req, res) {
  const request = await prisma.inspectionRequest.findUnique({
    where: { id: req.params.id },
    include: { order: { select: { id: true, status: true } } },
  });

  if (!request) {
    res.status(404).json({ error: 'Inspection request not found' });
    return null;
  }

  if (['DISPUTED', 'CANCELLED'].includes(request.order?.status)) {
    res.status(409).json({
      code: 'ORDER_DISPUTED',
      error: `This order is ${request.order.status.toLowerCase()}. Inspection quote proceedings are paused until it is resolved.`,
    });
    return null;
  }

  const quote = await prisma.inspectionQuote.findUnique({
    where: { id: req.params.quoteId },
  });

  if (!quote || quote.inspectionRequestId !== request.id) {
    res.status(404).json({ error: 'Inspection quote not found' });
    return null;
  }

  const isRequester = request.requestedById === req.user.id;
  const isProvider = quote.inspectorId === req.user.id;

  if (!isRequester && !isProvider) {
    res.status(403).json({ error: 'Not authorized for this inspection quote negotiation' });
    return null;
  }

  return { request, quote, actorRole: isRequester ? 'REQUESTER' : 'PROVIDER' };
}

// ============================================================================
// SELECT INSPECTION BID FOR DEAL NEGOTIATION
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/select',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;
      if (actorRole !== 'REQUESTER') return res.status(403).json({ error: 'Only the requester can select an inspection bid' });
      if (request.status !== 'REQUESTED') return res.status(400).json({ error: 'This inspection is no longer accepting bids' });
      if (quote.status !== 'PENDING') return res.status(400).json({ error: `Only a pending bid can be selected (current: ${quote.status})` });
      if (isQuoteExpired(quote)) return res.status(409).json({ error: 'This quote has expired' });

      const selected = await prisma.$transaction(async (tx) => {
        const fresh = await tx.inspectionQuote.findUnique({ where: { id: quote.id } });
        if (!fresh || fresh.status !== 'PENDING') throw quoteError('This bid is no longer available', 409);
        if (isQuoteExpired(fresh)) throw quoteError('This bid has expired', 409);
        await tx.inspectionQuote.updateMany({
          where: { inspectionRequestId: request.id, id: { not: fresh.id }, status: 'SELECTED' },
          data: { status: 'PENDING' },
        });
        return tx.inspectionQuote.update({ where: { id: fresh.id }, data: { status: 'SELECTED' } });
      }, { maxWait: 10000, timeout: 15000 });
      return res.json({ message: 'Inspector bid selected for price negotiation', quote: selected });
    } catch (error) {
      req.log.error({ err: error }, 'SELECT INSPECTION QUOTE ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not select inspection bid' });
    }
  }
);

// ============================================================================
// ACCEPT INSPECTION QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/accept',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({ error: 'This inspection is no longer accepting quotes' });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: 'This quote is no longer available' });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      const turn = quoteTurn(quote);
      if (turn !== null && turn !== actorRole) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const finalAmount = quote.status === 'COUNTERED' ? quote.counterAmount ?? quote.amount : quote.amount;

      const result = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'an inspection quote cannot be accepted until the order dispute is resolved');

        const claim = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            status: 'REQUESTED',
            inspectorId: null,
          },
          data: {
            inspectorId: quote.inspectorId,
            fee: finalAmount,
            feePayer: request.feePayer,
            buyerFeeAmount: request.feePayer === 'SELLER' ? null : request.feePayer === 'SPLIT' ? Math.round(finalAmount * 50) / 100 : finalAmount,
            sellerFeeAmount: request.feePayer === 'BUYER' ? null : request.feePayer === 'SPLIT' ? Math.round((finalAmount - Math.round(finalAmount * 50) / 100) * 100) / 100 : finalAmount,
            status: 'ACCEPTED',
            startDueAt: null,
            completionDueAt: null,
            startedAt: null,
            completedAt: null,
            sellerConfirmedAt: null,
            sellerMessage: null,
            sellerMessageAt: null,
          },
        });

        if (claim.count !== 1) {
          throw new Error('INSPECTION_ALREADY_CLAIMED');
        }

        const acceptedQuote = await tx.inspectionQuote.update({
          where: { id: quote.id },
          data: {
            status: 'ACCEPTED',
            amount: finalAmount,
          },
          include: {
            inspector: {
              select: { id: true, name: true, rating: true, location: true },
            },
          },
        });

        // Open the coordination sheet at the moment the agreement is locked.
        // Coordination routes require ACCEPTED or later; creating the row here
        // means GET /coordination returns an empty (not 404) sheet the instant
        // both parties can start filling it in.
        await ensureOpenCoordination(tx, request.id);

        const relatedOrders = await tx.order.findMany({
          where: { id: request.orderId },
          select: { id: true, status: true },
        });
        for (const relatedOrder of relatedOrders) {
          await syncOrderPaymentObligations(tx, relatedOrder.id);
          await recordOrderEvent(tx, {
            orderId: relatedOrder.id,
            actorId: req.user.id,
            type: 'INSPECTION_ACCEPTED',
            metadata: {
              inspectionRequestId: request.id,
              inspectorId: acceptedQuote.inspectorId,
              amount: String(finalAmount),
            },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_ACCEPTED',
          resourceType: 'InspectionQuote',
          resourceId: acceptedQuote.id,
          metadata: { inspectionRequestId: request.id, inspectorId: acceptedQuote.inspectorId, acceptedBy: actorRole, amount: finalAmount },
        });

        return acceptedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Inspection quote accepted', quote: result });
    } catch (error) {
      if (error.message === 'INSPECTION_ALREADY_CLAIMED') {
        return res.status(409).json({ error: 'This inspection was already assigned to another inspector' });
      }

      req.log.error({ err: error }, 'ACCEPT INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not accept inspection quote' });
    }
  }
);

// ============================================================================
// COUNTER INSPECTION QUOTE
// ----------------------------------------------------------------------------
// Schema enforces ONE quote row per inspector per inspection. The old code
// tried to INSERT a brand-new counter row for the same inspector, which
// Prisma rejected with P2002 and rolled back the transaction.
//
// Fix: update the SAME row in place, storing the negotiation state in
// (amount, counterAmount, counteredBy, status). No new row, no constraint
// violation, and the negotiation loop works in both directions.
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/counter',
  authenticate,
  [
    param('id').notEmpty(),
    param('quoteId').notEmpty(),
    body('counterAmount').custom(validAmount(AMOUNT_LIMITS.inspection)),
    body('message').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }).custom(noContactInfo),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });

      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({ error: 'This inspection is no longer accepting quotes' });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: `Quote cannot be countered because it is ${quote.status}` });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      const outerTurn = quoteTurn(quote);
      if (outerTurn !== null && outerTurn !== actorRole) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const counterAmount = Number(req.body.counterAmount);

      const counterQuote = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'an inspection quote cannot be countered until the order dispute is resolved');

        const freshQuote = await tx.inspectionQuote.findUnique({ where: { id: quote.id } });
        if (!freshQuote) throw quoteError('Inspection quote not found', 404);
        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError(`Quote cannot be countered because it is ${freshQuote.status}`, 409);
        }

        const freshTurn = quoteTurn(freshQuote);
        if (freshTurn !== null && freshTurn !== actorRole) {
          throw quoteError('It is the other party\u2019s turn to respond to this negotiation', 409);
        }

        const updated = await tx.inspectionQuote.update({
          where: { id: freshQuote.id },
          data: {
            status: 'COUNTERED',
            counterAmount,
            counteredBy: actorRole,
            message: req.body.message || freshQuote.message,
            expiresAt: quoteExpiry(12),
          },
          include: {
            inspector: { select: { id: true, name: true, rating: true, location: true } },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_COUNTERED',
          resourceType: 'InspectionQuote',
          resourceId: updated.id,
          metadata: {
            inspectionRequestId: request.id,
            counteredBy: actorRole,
            previousAmount: String(freshQuote.counterAmount ?? freshQuote.amount),
            counterAmount: String(counterAmount),
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({
        message: actorRole === 'REQUESTER'
          ? 'Counter-offer sent. The inspector must respond next.'
          : 'Counter-offer sent. The requester must respond next.',
        quote: counterQuote,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      req.log.error({ err: error }, 'COUNTER INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not counter inspection quote' });
    }
  }
);

// ============================================================================
// RELEASE PROVISIONAL INSPECTION AGREEMENT
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/withdraw',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      if (quote.status !== 'ACCEPTED') {
        return res.status(400).json({ error: `Only a provisionally accepted quote can be released (current: ${quote.status})` });
      }

      const result = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection agreement cannot be released until the order dispute is resolved');

        const activePayment = await tx.payment.findFirst({
          where: {
            inspectionRequestId: request.id,
            type: 'INSPECTOR',
            status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
          },
          select: { id: true, status: true },
        });
        if (activePayment) {
          throw quoteError('This inspector cannot be released after inspection payment has started or completed', 409);
        }

        const freshRequest = await tx.inspectionRequest.findUnique({ where: { id: request.id } });
        if (!freshRequest || freshRequest.status !== 'ACCEPTED' || freshRequest.inspectorId !== quote.inspectorId) {
          throw quoteError('This provisional inspection agreement is no longer active', 409);
        }

        const updatedQuote = await tx.inspectionQuote.update({
          where: { id: quote.id },
          data: { status: 'WITHDRAWN' },
        });

        await tx.inspectionRequest.update({
          where: { id: request.id },
          data: { inspectorId: null, fee: null, buyerFeeAmount: null, sellerFeeAmount: null, sellerConfirmedAt: null, startDueAt: null, completionDueAt: null, startedAt: null, status: 'REQUESTED' },
        });

        // Close coordination so the next inspector does not inherit the
        // previous inspector's phone number, availability, or notes.
        await closeCoordination(tx, request.id, 'INSPECTOR_WITHDREW');

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_WITHDRAWN',
          resourceType: 'InspectionQuote',
          resourceId: updatedQuote.id,
          metadata: { inspectionRequestId: request.id, inspectorId: quote.inspectorId, releasedBy: actorRole },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Provisional inspector agreement released. Other inspector bids are available again.', quote: result });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      req.log.error({ err: error }, 'WITHDRAW INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not release inspection agreement' });
    }
  }
);

// ============================================================================
// REJECT INSPECTION QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/reject',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, actorRole } = loaded;

      if (!['PENDING', 'SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: `Quote cannot be rejected because it is ${quote.status}` });
      }

      const turn = quoteTurn(quote);
      if (turn !== null && turn !== actorRole) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, loaded.request.orderId, 'an inspection quote cannot be rejected until the order dispute is resolved');

        const rejected = await tx.inspectionQuote.update({
          where: { id: quote.id },
          data: { status: 'REJECTED' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_REJECTED',
          resourceType: 'InspectionQuote',
          resourceId: rejected.id,
          metadata: { inspectionRequestId: rejected.inspectionRequestId, rejectedBy: actorRole },
        });

        return rejected;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Quote rejected', quote: updated });
    } catch (error) {
      req.log.error({ err: error }, 'REJECT INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not reject inspection quote' });
    }
  }
);

// ============================================================================
// INSPECTION ASSIGNMENT (legacy — disabled)
// ============================================================================

router.patch('/:id/accept', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  return res.status(410).json({
    error: 'Direct inspection acceptance is no longer supported. Submit a competitive quote; the requester selects and negotiates the winning bid.',
  });
});

// ============================================================================
// Seller review queue: the seller must confirm before the inspector can start.
router.get('/seller-pending', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const requests = await prisma.inspectionRequest.findMany({
      where: { listing: { sellerId: req.user.id }, status: { in: ['ACCEPTED', 'IN_PROGRESS', 'STALLED', 'COMPLETED'] } },
      include: {
        listing: { select: { id: true, title: true, cropType: true, location: true } },
        requestedBy: { select: { id: true, name: true } },
        inspector: { select: { id: true, name: true } },
        quotes: { where: { status: { not: 'REJECTED' } }, select: { id: true, inspectorId: true, amount: true, status: true, message: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return res.json({ requests });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION QUEUE ERROR');
    return res.status(500).json({ error: 'Could not load inspections awaiting seller review' });
  }
});

router.post('/:id/seller-confirm', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({
      where: { id: req.params.id }, include: { listing: true },
    });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.listing.sellerId !== req.user.id) return res.status(403).json({ error: 'Only the listing seller can confirm this inspection' });
    if (request.status !== 'ACCEPTED' || !request.inspectorId) return res.status(409).json({ error: 'Only a provisionally agreed inspection can be confirmed' });
    const updated = await prisma.inspectionRequest.updateMany({
      where: { id: request.id, status: 'ACCEPTED', inspectorId: request.inspectorId, sellerConfirmedAt: null },
      data: { sellerConfirmedAt: new Date(), startDueAt: computeInspectionStartDueAt(), sellerMessage: typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 500) : null, sellerMessageAt: req.body?.message ? new Date() : null },
    });
    if (!updated.count) return res.status(409).json({ error: 'Inspection was already confirmed or its status changed' });
    await prisma.$transaction(async (tx) => {
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_SELLER_CONFIRMED', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { inspectorId: request.inspectorId, message: req.body?.message || null } });
      if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: req.user.id, type: 'INSPECTION_ACCEPTED', metadata: { inspectionRequestId: request.id, sellerConfirmed: true, message: req.body?.message || null } });
    });
    return res.json({ message: 'Inspection confirmed. The inspector may now start work.', sellerConfirmedAt: new Date().toISOString() });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION CONFIRM ERROR');
    return res.status(500).json({ error: 'Could not confirm inspection' });
  }
});

router.post('/:id/seller-message', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 500) return res.status(400).json({ error: 'Message must contain 1–500 characters' });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { listing: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.listing.sellerId !== req.user.id) return res.status(403).json({ error: 'Only the listing seller can send inspection instructions' });
    const updated = await prisma.inspectionRequest.update({ where: { id: request.id }, data: { sellerMessage: message, sellerMessageAt: new Date() } });
    await prisma.$transaction(async (tx) => {
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_SELLER_MESSAGE', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { message } });
    });
    return res.json({ message: 'Seller instructions saved to the inspection record. This does not confirm the inspection.', sellerMessage: updated.sellerMessage, sellerMessageAt: updated.sellerMessageAt });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION MESSAGE ERROR');
    return res.status(500).json({ error: 'Could not save seller instructions' });
  }
});

// ============================================================================
// INSPECTOR STARTS INSPECTION
// ============================================================================

router.post(
  '/:id/start',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
      });

      if (!request) {
        return res.status(404).json({ error: 'Inspection request not found' });
      }

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({ error: 'Only the assigned inspector can start this inspection' });
      }

      if (request.status !== 'ACCEPTED') {
        return res.status(400).json({ error: `Only an accepted inspection can be started. Current status: ${request.status}` });
      }
      if (!request.sellerConfirmedAt) {
        return res.status(409).json({ error: 'The seller must confirm the selected inspector and agreed fee before work can start.' });
      }

      const startPayments = await prisma.payment.findMany({
        where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'PAID' },
        select: { id: true, createdById: true, amount: true },
      });
      const startObligations = request.orderId
        ? await prisma.paymentObligation.findMany({ where: { orderId: request.orderId, inspectionRequestId: request.id, type: 'INSPECTOR' }, select: { id: true, payerId: true, amount: true, status: true } })
        : [];
      const paymentComplete = startObligations.length
        ? startObligations.every((o) => o.status === 'PAID')
        : startPayments.some((p) => Number(p.amount) === Number(request.fee));
      if (!paymentComplete) {
        return res.status(402).json({ code: 'INSPECTION_PAYMENT_REQUIRED', error: 'The agreed inspection fee must be fully paid before the inspector can start.' });
      }

      const orderForStart = await prisma.order.findUnique({
        where: { id: request.orderId },
        select: { status: true },
      });
      if (orderForStart && ['DISPUTED', 'CANCELLED'].includes(orderForStart.status)) {
        return res.status(409).json({
          error: `This order is ${orderForStart.status.toLowerCase()}, so the inspection cannot be started until that is resolved.`,
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be started until that is resolved');

        const updatedCount = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'ACCEPTED',
            sellerConfirmedAt: { not: null },
          },
          data: { status: 'IN_PROGRESS', startedAt: new Date(), completionDueAt: computeInspectionCompletionDueAt() },
        });

        if (updatedCount.count !== 1) {
          return false;
        }

        const relatedOrders = await tx.order.findMany({
          where: { id: request.orderId },
          select: { id: true },
        });
        for (const relatedOrder of relatedOrders) {
          await recordOrderEvent(tx, {
            orderId: relatedOrder.id,
            actorId: req.user.id,
            type: 'INSPECTION_STARTED',
            metadata: { inspectionRequestId: request.id },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_STARTED',
          resourceType: 'InspectionRequest',
          resourceId: request.id,
        });

        return true;
      }, { maxWait: 10000, timeout: 15000 });

      if (!result) {
        return res.status(409).json({ error: 'This inspection was already started or its status changed' });
      }

      const updated = await prisma.inspectionRequest.findUnique({
        where: { id: request.id },
        include: {
          listing: {
            select: {
              id: true, cropType: true, title: true, quantity: true, unit: true,
              location: true, category: true,
            },
          },
          requestedBy: { select: { id: true, name: true } },
          inspector: { select: { id: true, name: true, rating: true, location: true } },
          report: true,
        },
      });

      return res.json({
        message: 'Inspection started',
        paymentDue: updated.fee != null && Number(updated.fee) > 0,
        paymentTrigger: 'INSPECTION_STARTED',
        request: updated,
      });
    } catch (error) {
      req.log.error({ err: error }, 'START INSPECTION ERROR:');

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not start inspection' });
    }
  }
);

// ============================================================================
// INSPECTOR VIEWS THEIR JOBS
// ============================================================================

router.get(
  '/mine',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const requests = await prisma.inspectionRequest.findMany({
        where: { inspectorId: req.user.id },
        include: {
          listing: {
            select: {
              id: true, cropType: true, title: true, quantity: true, unit: true,
              location: true, category: true,
              orders: { select: { id: true, status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
            },
          },
          requestedBy: { select: { id: true, name: true, rating: true } },
          report: true,
          payments: { select: { id: true, type: true, status: true, amount: true } },
          quotes: {
            where: { status: { not: 'REJECTED' } },
            select: {
              id: true, inspectorId: true, amount: true, status: true, message: true,
              parentQuoteId: true, counterAmount: true, counteredBy: true, expiresAt: true, createdAt: true, updatedAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ requests });
    } catch (error) {
      req.log.error({ err: error }, 'MY INSPECTIONS ERROR:');
      return res.status(500).json({ error: 'Could not load your inspections' });
    }
  }
);

// ============================================================================
// INSPECTION EVIDENCE ACCESS
// ============================================================================

async function canAccessInspection(req, requestId) {
  const request = await prisma.inspectionRequest.findUnique({
    where: { id: requestId },
    include: { listing: { select: { sellerId: true } }, report: true },
  });
  if (!request) return { request: null, allowed: false };
  const allowed = req.user.roles.includes('ADMIN') ||
    request.requestedById === req.user.id ||
    request.inspectorId === req.user.id ||
    request.listing.sellerId === req.user.id;
  return { request, allowed };
}

router.get('/:id/evidence', authenticate, async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });
    if (!access.request.report) return res.json({ evidence: [] });
    const evidence = await prisma.inspectionEvidence.findMany({
      where: { reportId: access.request.report.id },
      select: { id: true, reportId: true, type: true, photos: true, videos: true, gpsLocation: true, notes: true, capturedAt: true, createdById: true },
      orderBy: { capturedAt: 'asc' },
    });
    return res.json({ evidence });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTION EVIDENCE ERROR:');
    return res.status(500).json({ error: 'Could not load inspection evidence' });
  }
});

router.get('/:id/evidence/:evidenceId/media', authenticate, [
  param('id').notEmpty(),
  param('evidenceId').notEmpty(),
], async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });

    const evidence = await prisma.inspectionEvidence.findFirst({
      where: { id: req.params.evidenceId, reportId: access.request.report?.id || '__none__' },
    });
    if (!evidence) return res.status(404).json({ error: 'Inspection evidence not found' });

    const sign = async (ref, kind, index) => {
      const metadata = await privateMediaMetadata(ref);
      const url = await signedMediaUrl({
        key: metadata.key,
        fileName: `${kind.toLowerCase()}-${evidence.id}-${index + 1}`,
        contentType: metadata.contentType || undefined,
      });
      return { index, url, key: metadata.key, contentType: metadata.contentType, size: metadata.contentLength, etag: metadata.etag, lastModified: metadata.lastModified };
    };

    const media = { photos: [], videos: [], unsupported: [] };
    for (let i = 0; i < evidence.photos.length; i += 1) {
      try { media.photos.push(await sign(evidence.photos[i], 'photo', i)); }
      catch (error) { media.unsupported.push({ kind: 'photo', index: i, reason: error.message }); }
    }
    for (let i = 0; i < evidence.videos.length; i += 1) {
      try { media.videos.push(await sign(evidence.videos[i], 'video', i)); }
      catch (error) { media.unsupported.push({ kind: 'video', index: i, reason: error.message }); }
    }

    await prisma.auditEvent.create({
      data: {
        actorId: req.user.id,
        action: 'INSPECTION_EVIDENCE_MEDIA_ACCESSED',
        resourceType: 'InspectionEvidence',
        resourceId: evidence.id,
        metadata: { inspectionRequestId: access.request.id, photoCount: media.photos.length, videoCount: media.videos.length, unsupportedCount: media.unsupported.length },
      },
    });

    return res.json({ evidenceId: evidence.id, expiresInSeconds: Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900), media });
  } catch (error) {
    req.log.error({ err: error }, 'SIGN INSPECTION EVIDENCE MEDIA ERROR:');
    return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
  }
});

// ============================================================================
// UPLOAD INSPECTION EVIDENCE MEDIA
// ============================================================================

router.post('/:id/evidence/media', authenticate, requireRole('INSPECTOR'), evidenceUpload.array('files', 5), async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!req.files?.length) return res.status(400).json({ error: 'At least one file is required' });

    const { photoKeys, videoKeys } = await uploadEvidenceFiles('inspection', request.id, req.files);

    return res.status(201).json({ photoKeys, videoKeys });
  } catch (error) {
    req.log.error({ err: error }, 'UPLOAD INSPECTION EVIDENCE MEDIA ERROR:');
    return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
  }
});

router.post('/:id/evidence', authenticate, requireRole('INSPECTOR'), [
  param('id').notEmpty(),
  body('photos').optional().isArray().withMessage('photos must be an array'),
  body('videos').optional().isArray().withMessage('videos must be an array'),
  body('gpsLocation').optional({ nullable: true }).isString(),
  body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('capturedAt').optional({ nullable: true }).isISO8601().withMessage('capturedAt must be a valid ISO date'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { report: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!request.report) return res.status(400).json({ error: 'Submit the inspection report before adding supplemental evidence' });
    const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
    const videos = Array.isArray(req.body.videos) ? req.body.videos : [];
    const gpsLocation = req.body.gpsLocation || null;
    const notes = req.body.notes || null;
    if (!photos.length && !videos.length && !gpsLocation && !notes) return res.status(400).json({ error: 'Evidence must contain a photo, video, GPS location, or notes' });
    const evidence = await prisma.$transaction(async (tx) => {
      const created = await tx.inspectionEvidence.create({
        data: { reportId: request.report.id, type: 'ADDITIONAL', photos, videos, gpsLocation, notes, capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(), createdById: req.user.id },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_EVIDENCE_ADDED', resourceType: 'InspectionEvidence', resourceId: created.id, metadata: { inspectionRequestId: request.id, reportId: request.report.id, type: created.type } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    return res.status(201).json({ evidence });
  } catch (error) {
    req.log.error({ err: error }, 'ADD INSPECTION EVIDENCE ERROR:');
    return res.status(500).json({ error: 'Could not add inspection evidence' });
  }
});

// ============================================================================
// SUBMIT INSPECTION REPORT
// ============================================================================

router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [
    body('quantity').isFloat({ gt: 0 }).withMessage('Verified quantity must be greater than zero'),
    body('grade').optional({ nullable: true }).isString(),
    body('moisture').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('moisture must be zero or greater'),
    body('visibleDefects').optional({ nullable: true }).isString(),
    body('damageNotes').optional({ nullable: true }).isString(),
    body('packagingNotes').optional({ nullable: true }).isString(),
    body('assessmentSummary').optional({ nullable: true }).isString().trim().isLength({ max: 3000 }),
    body('qualityFlags').optional().isArray().withMessage('qualityFlags must be an array'),
    body('gpsLocation').optional({ nullable: true }).isString(),
    body('photos').optional().isArray().withMessage('photos must be an array'),
    body('videos').optional().isArray().withMessage('videos must be an array'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: errors.array()[0]?.msg || 'Validation failed',
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
        include: { report: true, listing: { select: { quantity: true, unit: true, category: true } } },
      });

      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can submit this report' });
      if (request.status !== 'IN_PROGRESS') return res.status(400).json({ error: `Inspection must be IN_PROGRESS before submitting a report. Current status: ${request.status}` });
      if (!request.sellerConfirmedAt) return res.status(409).json({ error: 'Seller confirmation is required before submitting an inspection report.' });
      if (request.report) return res.status(409).json({ error: 'An inspection report has already been submitted' });

      const reportObligations = request.orderId
        ? await prisma.paymentObligation.findMany({ where: { orderId: request.orderId, inspectionRequestId: request.id, type: 'INSPECTOR' }, select: { status: true } })
        : [];
      const reportPaid = reportObligations.length
        ? reportObligations.every((o) => o.status === 'PAID')
        : (await prisma.payment.findFirst({ where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'PAID' }, select: { id: true } })) != null;
      if (!reportPaid) return res.status(402).json({ code: 'INSPECTION_PAYMENT_REQUIRED', error: 'The inspection fee must be fully paid before the report can be submitted.' });

      const orderForReport = await prisma.order.findUnique({
        where: { id: request.orderId },
        select: { status: true },
      });
      if (orderForReport && ['DISPUTED', 'CANCELLED'].includes(orderForReport.status)) {
        return res.status(409).json({
          error: `This order is ${orderForReport.status.toLowerCase()}, so a report cannot be submitted until that is resolved.`,
        });
      }

      const {
        quantity, grade, moisture, visibleDefects, damageNotes, packagingNotes, assessmentSummary, qualityFlags, photos, videos, gpsLocation,
      } = req.body;

      const report = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'a report cannot be submitted until that is resolved');

        const createdReport = await tx.inspectionReport.create({
          data: {
            requestId: request.id,
            quantity: Number(quantity),
            grade: grade || null,
            moisture: moisture !== undefined && moisture !== null && moisture !== '' ? Number(moisture) : null,
            visibleDefects: visibleDefects || null,
            damageNotes: damageNotes || null,
            packagingNotes: packagingNotes || null,
            assessmentSummary: assessmentSummary || null,
            qualityFlags: Array.isArray(qualityFlags) ? qualityFlags.map((v) => String(v).trim()).filter(Boolean).slice(0, 20) : [],
            quantityVariancePercent: (() => {
              const listingQuantity = Number(request.listing?.quantity || 0);
              return listingQuantity > 0 ? ((Number(quantity) - listingQuantity) / listingQuantity) * 100 : null;
            })(),
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
          },
        });

        await tx.inspectionEvidence.create({
          data: {
            reportId: createdReport.id,
            type: 'REPORT',
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
            notes: [visibleDefects, damageNotes, packagingNotes].filter(Boolean).join('\n') || null,
            capturedAt: createdReport.inspectedAt,
            createdById: req.user.id,
          },
        });

        const completed = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'IN_PROGRESS',
          },
          data: { status: 'COMPLETED', completedAt: new Date(), completionDueAt: null },
        });

        if (completed.count !== 1) {
          throw new Error('INSPECTION_STATUS_CHANGED');
        }

        if (request.orderId) {
          await tx.order.updateMany({
            where: { id: request.orderId, status: 'PENDING_PAYMENT', buyerDecision: null },
            data: { paymentDueAt: computePaymentDueAt() },
          });
        }

        const relatedOrders = await tx.order.findMany({
          where: { id: request.orderId },
          select: { id: true },
        });
        for (const relatedOrder of relatedOrders) {
          await syncOrderPaymentObligations(tx, relatedOrder.id);
          await recordOrderEvent(tx, {
            orderId: relatedOrder.id,
            actorId: req.user.id,
            type: 'INSPECTION_COMPLETED',
            metadata: { inspectionRequestId: request.id, reportId: createdReport.id },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REPORT_SUBMITTED',
          resourceType: 'InspectionReport',
          resourceId: createdReport.id,
          metadata: { inspectionRequestId: request.id, quantity: createdReport.quantity },
        });

        return createdReport;
      }, {
        maxWait: 10000,
        timeout: 15000,
      });

      return res.status(201).json({ report });
    } catch (error) {
      if (error.message === 'INSPECTION_STATUS_CHANGED') {
        return res.status(409).json({ error: 'Inspection status changed before the report could be completed' });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      req.log.error({ err: error }, 'CREATE INSPECTION REPORT ERROR:');
      return res.status(500).json({
        error: error.message || 'Could not submit inspection report',
        requestId: req.requestId,
      });
    }
  }
);

// ============================================================================
// REPORT ADDENDUM — immutable correction trail
// ============================================================================
// The original report is never edited after COMPLETED. If a factual correction
// is required, the assigned inspector appends an auditable addendum instead.
router.post('/:id/report/addenda', authenticate, requireRole('INSPECTOR'), [
  body('reason').isString().trim().isLength({ min: 3, max: 500 }),
  body('notes').isString().trim().isLength({ min: 3, max: 3000 }),
  body('photos').optional().isArray(),
  body('videos').optional().isArray(),
  body('gpsLocation').optional({ nullable: true }).isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed' });
    const request = await prisma.inspectionRequest.findUnique({
      where: { id: req.params.id },
      include: { report: true },
    });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add a report addendum' });
    if (request.status !== 'COMPLETED' || !request.report) return res.status(409).json({ error: 'A report addendum is available only after the original report is completed' });

    const addendum = await prisma.$transaction(async (tx) => {
      const created = await tx.inspectionReportAddendum.create({
        data: {
          reportId: request.report.id,
          createdById: req.user.id,
          reason: req.body.reason,
          notes: req.body.notes,
          photos: Array.isArray(req.body.photos) ? req.body.photos : [],
          videos: Array.isArray(req.body.videos) ? req.body.videos : [],
          gpsLocation: req.body.gpsLocation || null,
        },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_REPORT_ADDENDUM_CREATED', resourceType: 'InspectionReportAddendum', resourceId: created.id, metadata: { inspectionRequestId: request.id, reportId: request.report.id } });
      if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: req.user.id, type: 'INSPECTION_REPORT_ADDENDUM_ADDED', metadata: { inspectionRequestId: request.id, reportId: request.report.id, addendumId: created.id } });
      return created;
    });
    return res.status(201).json({ message: 'Report addendum recorded. The original report remains unchanged.', addendum });
  } catch (error) {
    req.log.error({ err: error }, 'CREATE INSPECTION REPORT ADDENDUM ERROR');
    return res.status(500).json({ error: 'Could not create inspection report addendum' });
  }
});

// ============================================================================
// INSPECTION COORDINATION (seller <-> inspector only)
// ============================================================================
//
// Operational handoff for the physical site visit. Contact data lives here,
// NOT on InspectionRequest, so no buyer-facing endpoint can leak it.
//
// Access rule (enforced below, mirrored in the service):
//   • Seller of the listing and the assigned inspector only.
//   • Inspection request must be ACCEPTED or later.
//   • Buyer is intentionally excluded, even if the buyer pays the fee.
//   • Admin override for support, always audited.

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

// GET /inspections/:id/coordination
router.get('/:id/coordination', authenticate, async (req, res) => {
  try {
    const ctx = await loadCoordinationContext(req, res);
    if (!ctx) return;

    const { request, role } = ctx;
    const coordination = request.coordination && !request.coordination.supersededAt
      ? request.coordination
      : null;

    return res.json({
      role,
      coordination,
      availability: request.availability || [],
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTION COORDINATION ERROR:');
    return res.status(500).json({ error: 'Could not load inspection coordination' });
  }
});

// PUT /inspections/:id/coordination
// Writes only the calling party's own field prefix.
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

      // Whitelist: never let the caller write the other side's fields.
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

// POST /inspections/:id/coordination/availability
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

// DELETE /inspections/:id/coordination/availability/:slotId
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
