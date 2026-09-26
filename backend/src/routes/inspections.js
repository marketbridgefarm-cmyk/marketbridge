const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');

const router = express.Router();

function validationError(res) {
  const errors = validationResult(res.req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
  }
  return null;
}

// ============================================================================
// QUOTE NEGOTIATION HELPERS
// Mirrors the buyer <-> seller Offer negotiation chain: a counter creates a
// new child quote row rather than mutating the previous one.
// ============================================================================

function isPositiveNumber(value) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number > 0;
}

function quoteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Whose turn it is to respond to the current leaf quote.
// PENDING (no counter yet) was created by the inspector, so the requester
// must respond. COUNTERED flips based on who made the most recent counter.
function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'SELECTED') return 'REQUESTER';
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
// Seller or buyer requests an inspection.
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
    body('inspectorId').optional({ nullable: true }).isString(),
    body('fee')
      .if(body('inspectorId').notEmpty())
      .isFloat({ gt: 0 })
      .withMessage('A fee is required when pre-selecting an inspector'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
      }

      const {
        orderId,
        listingId,
        mode,
        inspectorId,
        fee,
      } = req.body;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { listing: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.buyerId !== req.user.id && order.sellerId !== req.user.id && !req.user.roles.includes('ADMIN')) {
        return res.status(403).json({ error: 'Only the buyer or seller of the order can request inspection' });
      }

      if (['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status)) {
        return res.status(409).json({ error: `Inspection cannot be requested for an order that is ${order.status.toLowerCase()}` });
      }

      if (order.listing.category !== 'AGRICULTURAL') {
        return res.status(400).json({
          error: 'Inspections are only available for agricultural listings',
        });
      }

      const resolvedListingId = order.listingId;

      if (inspectorId) {
        const inspector = await prisma.user.findUnique({
          where: { id: inspectorId },
        });

        if (
          !inspector ||
          !inspector.roles.includes('INSPECTOR')
        ) {
          return res.status(400).json({
            error: 'inspectorId does not belong to a registered inspector',
          });
        }

        if (inspector.id === req.user.id) {
          return res.status(400).json({
            error: 'You cannot select yourself as the inspector',
          });
        }
      }

      const request = await prisma.$transaction(async (tx) => {
        // An order may have only one active inspection workflow. The old UI
        // exposed both "Request inspection" and "Find an inspector" even
        // after an inspection already existed, which allowed duplicate
        // requests on the same listing. A later pending request then blocked
        // the agricultural goods payment even when an earlier inspection had
        // already been completed. Reject a second active request at the
        // database transaction boundary. Cancelled requests are historical
        // records and do not block a new workflow.
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
            // Preserve the location at the time the inspection was requested.
            location: order.listing.location || null,
            inspectorId: inspectorId || null,
            status: inspectorId ? 'ACCEPTED' : 'REQUESTED',
            fee: inspectorId ? Number(fee) : null,
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

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REQUEST_CREATED',
          resourceType: 'InspectionRequest',
          resourceId: created.id,
          metadata: { orderId: order.id, listingId: resolvedListingId, mode, inspectorId: inspectorId || null },
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

      return res.status(500).json({
        error: 'Could not create inspection request',
      });
    }
  }
);

// ============================================================================
// FIND INSPECTORS
// ============================================================================

router.get('/inspectors', authenticate, async (req, res) => {
  try {
    const { location } = req.query;

    const inspectors = await prisma.user.findMany({
      where: {
        roles: {
          has: 'INSPECTOR',
        },

        ...(location
          ? {
              location: {
                contains: location,
                mode: 'insensitive',
              },
            }
          : {}),
      },

      select: {
        id: true,
        name: true,
        rating: true,
        location: true,
        verificationStatus: true,
      },

      orderBy: [
        {
          rating: 'desc',
        },
        {
          name: 'asc',
        },
      ],
    });

    return res.json({ inspectors });
  } catch (error) {
    req.log.error({ err: error }, 'GET INSPECTORS ERROR:');

    return res.status(500).json({
      error: 'Could not load inspectors',
    });
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

          ...(location
            ? {
                location: {
                  contains: location,
                  mode: 'insensitive',
                },
              }
            : {}),
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
            select: {
              id: true,
              name: true,
              rating: true,
            },
          },

          // Sealed-bid: an inspector browsing open requests only ever sees
          // their OWN quote here, never anyone else's amount, message, or
          // even the fact that other quotes exist. The requester is the
          // only party who can see the full quote list, via the separate
          // GET /:id/quotes route below.
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

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({ requests });
    } catch (error) {
      req.log.error({ err: error }, 'AVAILABLE INSPECTIONS ERROR:');

      return res.status(500).json({
        error: 'Could not load available inspections',
      });
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

    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Quote amount must be greater than zero'),

    body('message')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Quote message is too long'),
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
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({
          error: 'This inspection is no longer accepting quotes',
        });
      }

      if (request.requestedById === req.user.id) {
        return res.status(403).json({
          error: 'You cannot quote on your own inspection request',
        });
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

      return res.status(201).json({
        quote,
      });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE INSPECTION QUOTE ERROR:');

      return res.status(500).json({
        error: 'Could not submit inspection quote',
      });
    }
  }
);

// ============================================================================
// VIEW QUOTES FOR AN INSPECTION
// Only the requester can view the quote marketplace.
// ============================================================================

router.get(
  '/:id/quotes',
  authenticate,
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },

        select: {
          id: true,
          requestedById: true,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (
        request.requestedById !== req.user.id &&
        !req.user.roles.includes('ADMIN')
      ) {
        return res.status(403).json({
          error: 'Only the inspection requester can view quotes',
        });
      }

      const quotes = await prisma.inspectionQuote.findMany({
        where: {
          inspectionRequestId: request.id,
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

        orderBy: [
          {
            status: 'asc',
          },
          {
            amount: 'asc',
          },
          {
            createdAt: 'asc',
          },
        ],
      });

      return res.json({
        quotes,
      });
    } catch (error) {
      req.log.error({ err: error }, 'GET INSPECTION QUOTES ERROR:');

      return res.status(500).json({
        error: 'Could not load inspection quotes',
      });
    }
  }
);

// ============================================================================
// SHARED LOOKUP: request + leaf quote, with the caller's role in the
// negotiation (REQUESTER or PROVIDER/inspector). Returns null + a response
// already sent if anything is invalid.
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
// Competition is sealed: the requester can compare all bids, then select one
// provider. Selection does not assign the inspector or trigger payment.
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
// Either the requester accepts the inspector's (counter-)offer, or the
// inspector accepts the requester's counter — whichever party's turn it is.
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
        return res.status(400).json({
          error: 'This inspection is no longer accepting quotes',
        });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({
          error: 'This quote is no longer available',
        });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      if (quote.status !== 'ACCEPTED' && quoteTurn(quote) !== actorRole) {
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

          // This is a provisional commercial selection. The inspection
          // request remains REQUESTED until the inspector payment settles.
          // Keeping the other quotes open is what allows the buyer to cancel
          // this provisional agreement and continue with another bidder.
          data: {
            inspectorId: quote.inspectorId,
            fee: finalAmount,
          },
        });

        if (claim.count !== 1) {
          throw new Error('INSPECTION_ALREADY_CLAIMED');
        }

        const acceptedQuote = await tx.inspectionQuote.update({
          where: {
            id: quote.id,
          },

          data: {
            status: 'ACCEPTED',
            amount: finalAmount,
          },

          include: {
            inspector: {
              select: {
                id: true,
                name: true,
                rating: true,
                location: true,
              },
            },
          },
        });

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

      return res.json({
        message: 'Inspection quote accepted',
        quote: result,
      });
    } catch (error) {
      if (error.message === 'INSPECTION_ALREADY_CLAIMED') {
        return res.status(409).json({
          error: 'This inspection was already assigned to another inspector',
        });
      }

      req.log.error({ err: error }, 'ACCEPT INSPECTION QUOTE ERROR:');

      return res.status(500).json({
        error: 'Could not accept inspection quote',
      });
    }
  }
);

// ============================================================================
// COUNTER INSPECTION QUOTE
// Requester and inspector can go back and forth on price, same pattern as
// buyer <-> seller offer negotiation. Whoever it is NOT waiting on can
// propose a new amount, which becomes a new child quote in the chain.
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/counter',
  authenticate,
  [
    param('id').notEmpty(),
    param('quoteId').notEmpty(),
    body('counterAmount').isFloat({ gt: 0 }).withMessage('counterAmount must be greater than zero'),
    body('message').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
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

      if (quoteTurn(quote) !== actorRole) {
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
        if (quoteTurn(freshQuote) !== actorRole) {
          throw quoteError('It is the other party\u2019s turn to respond to this negotiation', 409);
        }

        await tx.inspectionQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'COUNTERED' },
        });

        const created = await tx.inspectionQuote.create({
          data: {
            inspectionRequestId: request.id,
            inspectorId: freshQuote.inspectorId,
            amount: counterAmount,
            counterAmount,
            counteredBy: actorRole,
            status: 'COUNTERED',
            parentQuoteId: freshQuote.id,
            expiresAt: quoteExpiry(12),
            message: req.body.message || freshQuote.message,
          },
          include: {
            inspector: { select: { id: true, name: true, rating: true, location: true } },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_COUNTERED',
          resourceType: 'InspectionQuote',
          resourceId: created.id,
          metadata: {
            inspectionRequestId: request.id,
            parentQuoteId: freshQuote.id,
            counteredBy: actorRole,
            previousAmount: freshQuote.counterAmount ?? freshQuote.amount,
            counterAmount,
          },
        });

        return created;
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
// REJECT INSPECTION QUOTE
// Either party can end a negotiation thread when it's their turn to respond.
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/reject',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      if (!['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(quote.status)) {
        return res.status(400).json({ error: `Quote cannot be rejected because it is ${quote.status}` });
      }

      if (quote.status === 'ACCEPTED') {
        const paid = await prisma.payment.findFirst({
          where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'PAID' },
          select: { id: true },
        });
        if (paid || request.status !== 'REQUESTED') {
          return res.status(409).json({ error: 'This inspection agreement is already committed by payment' });
        }
      }

      if (quoteTurn(quote) !== actorRole) {
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

        if (quote.status === 'ACCEPTED') {
          await tx.inspectionRequest.updateMany({
            where: { id: request.id, status: 'REQUESTED', inspectorId: quote.inspectorId },
            data: { inspectorId: null, fee: null },
          });
        }

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
// INSPECTION ASSIGNMENT
// Assignment is intentionally quote-driven: an inspector cannot bypass the
// competitive marketplace by directly claiming an open request. The requester
// selects a bid, negotiates if needed, and accepts the final quote.
// ============================================================================

router.patch('/:id/accept', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  return res.status(410).json({
    error: 'Direct inspection acceptance is no longer supported. Submit a competitive quote; the requester selects and negotiates the winning bid.',
  });
});

// ============================================================================
// INSPECTOR STARTS INSPECTION
// ACCEPTED -> IN_PROGRESS
// ============================================================================

router.post(
  '/:id/start',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({
          error: 'Only the assigned inspector can start this inspection',
        });
      }

      if (request.status !== 'ACCEPTED') {
        return res.status(400).json({
          error: `Only an accepted inspection can be started. Current status: ${request.status}`,
        });
      }

      // Fast, friendly pre-check outside the transaction — not itself the
      // guard against the race (see lockOrderAndAssertNotClosed below), just
      // avoids starting a transaction for the common, non-racy case.
      const orderForStart = await prisma.order.findUnique({
        where: { id: request.orderId },
        select: { status: true },
      });
      if (orderForStart && ['DISPUTED', 'CANCELLED'].includes(orderForStart.status)) {
        return res.status(409).json({
          error: `This order is ${orderForStart.status.toLowerCase()}, so the inspection cannot be started until that is resolved.`,
        });
      }

      if (request.fee != null && Number(request.fee) > 0) {
        const paid = await prisma.payment.findFirst({
          where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'PAID' },
          select: { id: true },
        });
        if (!paid) {
          return res.status(409).json({
            code: 'INSPECTION_PAYMENT_REQUIRED',
            error: 'The inspection fee must be paid before the inspector can start the inspection.',
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be started until that is resolved');

        const updatedCount = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'ACCEPTED',
          },
          data: { status: 'IN_PROGRESS' },
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
        return res.status(409).json({
          error: 'This inspection was already started or its status changed',
        });
      }

      const updated = await prisma.inspectionRequest.findUnique({
        where: {
          id: request.id,
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
            select: {
              id: true,
              name: true,
            },
          },

          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
            },
          },

          report: true,
        },
      });

      return res.json({
        message: 'Inspection started',
        request: updated,
      });
    } catch (error) {
      req.log.error({ err: error }, 'START INSPECTION ERROR:');

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({
        error: 'Could not start inspection',
      });
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
        where: {
          inspectorId: req.user.id,
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
              orders: {
                select: { id: true, status: true },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },

          requestedBy: {
            select: {
              id: true,
              name: true,
              rating: true,
            },
          },

          report: true,
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({
        requests,
      });
    } catch (error) {
      req.log.error({ err: error }, 'MY INSPECTIONS ERROR:');

      return res.status(500).json({
        error: 'Could not load your inspections',
      });
    }
  }
);

// ============================================================================
// INSPECTION EVIDENCE ACCESS
// Evidence is private transaction data. Only the inspection requester,
// listing seller, assigned inspector, or ADMIN may access it.
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
// Returns private object-storage keys for use in POST /:id/report or
// POST /:id/evidence. Only the assigned inspector may upload.
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
// IN_PROGRESS -> COMPLETED
// ============================================================================

router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [
    body('quantity')
      .isFloat({ gt: 0 })
      .withMessage('Verified quantity must be greater than zero'),

    body('grade')
      .optional({ nullable: true })
      .isString(),

    body('moisture')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('moisture must be zero or greater'),

    body('visibleDefects')
      .optional({ nullable: true })
      .isString(),

    body('damageNotes')
      .optional({ nullable: true })
      .isString(),

    body('packagingNotes')
      .optional({ nullable: true })
      .isString(),

    body('gpsLocation')
      .optional({ nullable: true })
      .isString(),

    body('photos')
      .optional()
      .isArray()
      .withMessage('photos must be an array'),

    body('videos')
      .optional()
      .isArray()
      .withMessage('videos must be an array'),
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
        where: {
          id: req.params.id,
        },

        include: {
          report: true,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Request not found',
        });
      }

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({
          error: 'Only the assigned inspector can submit this report',
        });
      }

      if (request.status !== 'IN_PROGRESS') {
        return res.status(400).json({
          error: `Inspection must be IN_PROGRESS before submitting a report. Current status: ${request.status}`,
        });
      }

      if (request.report) {
        return res.status(409).json({
          error: 'An inspection report has already been submitted',
        });
      }

      // Fast, friendly pre-check outside the transaction — not itself the
      // guard against the race (see lockOrderAndAssertNotClosed below), just
      // avoids starting a transaction for the common, non-racy case.
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
        quantity,
        grade,
        moisture,
        visibleDefects,
        damageNotes,
        packagingNotes,
        photos,
        videos,
        gpsLocation,
      } = req.body;

      // Report submission performs several related writes (report, evidence,
      // inspection status, payment obligations, order event, notifications and
      // optional SMS outbox rows). Prisma's default interactive transaction
      // timeout is 5 seconds, which can be exceeded on a real/remote database
      // even though the operation is healthy. Keep the entire submission
      // atomic, but give this workflow enough time to finish.
      const report = await prisma.$transaction(async (tx) => {
        // Real guard against the dispute/cancellation race — takes a row
        // lock on the order, so it can't land between this check and the
        // report actually committing below.
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'a report cannot be submitted until that is resolved');

        const createdReport = await tx.inspectionReport.create({
          data: {
            requestId: request.id,
            quantity: Number(quantity),
            grade: grade || null,
            moisture:
              moisture !== undefined &&
              moisture !== null &&
              moisture !== ''
                ? Number(moisture)
                : null,
            visibleDefects: visibleDefects || null,
            damageNotes: damageNotes || null,
            packagingNotes: packagingNotes || null,
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

          data: {
            status: 'COMPLETED',
          },
        });

        if (completed.count !== 1) {
          throw new Error('INSPECTION_STATUS_CHANGED');
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

      return res.status(201).json({
        report,
      });
    } catch (error) {
      if (error.message === 'INSPECTION_STATUS_CHANGED') {
        return res.status(409).json({
          error: 'Inspection status changed before the report could be completed',
        });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      req.log.error({ err: error }, 'CREATE INSPECTION REPORT ERROR:');

      return res.status(500).json({
        // Surfacing error.message (like the sibling evidence-media upload
        // route already does) instead of a fixed string, so a runtime
        // failure here is diagnosable from the toast alone instead of only
        // from server logs. req.requestId is also echoed so it can be
        // correlated with the pino log line above if you have log access.
        error: error.message || 'Could not submit inspection report',
        requestId: req.requestId,
      });
    }
  }
);

module.exports = router;






