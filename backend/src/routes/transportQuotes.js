'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isAdmin } = require('../utils/authorization');
const { idempotency } = require('../middleware/idempotency');

const {
  computeSellerTransportPreparationDueAt: computeSellerPreparationDueAt,
} = require('../utils/orderTiming');

const {
  quoteTurn,
  isQuoteExpired,
  quoteExpiry,
  resolveReleaseWindowHours,
  computeReleaseAvailableAt,
} = require('../services/negotiationService');

const {
  AMOUNT_LIMITS,
  validAmount,
} = require('../utils/contactGuard');

const {
  BID_MESSAGES,
  presetMessage,
} = require('../utils/requestOptions');

const {
  closeCoordination,
} = require('../services/transportCoordinationService');

const {
  noticeTransportWaitingLocked,
  noticeTransportWaitingUnlocked,
} = require('../services/waitingListService');

const {
  parseReleaseReason,
  assertAcceptedReleaseWindowElapsed,
  releaseAllowance,
  providerFlagThreshold,
  providerReleaseCountLast30d,
  LIMIT_MESSAGE,
} = require('../services/releaseLimitsService');

const {
  applyProviderCancellation,
  assertProviderCanBid,
} = require('../services/providerStandingService');

// ============================================================================
// TRANSPORT QUOTES
// ----------------------------------------------------------------------------
// Sealed-bid submission, comparison, and counter-offer negotiation for
// hired transport. Extracted from routes/transport.js so the transport
// lifecycle file stays focused on the job state machine.
//
// Same paths, same responses, same validation — pure relocation.
// ============================================================================

const router = express.Router();

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
};

function quoteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function findCompetingLiveQuote(tx, transportJobId, exceptQuoteId) {
  return tx.transportQuote.findFirst({
    where: {
      transportJobId,
      id: { not: exceptQuoteId },
      status: { in: ['SELECTED', 'COUNTERED'] },
      childQuotes: { none: {} },
    },
    select: { id: true, truckOwnerId: true, status: true },
  });
}

function findLeafQuote(tx, quoteId, extra = {}) {
  return tx.transportQuote.findFirst({
    where: { id: quoteId, childQuotes: { none: {} } },
    ...extra,
  });
}

function isArrangingParty(job, order, userId) {
  return (
    (job.arrangingParty === 'SELLER' && order.sellerId === userId) ||
    (job.arrangingParty === 'BUYER' && order.buyerId === userId) ||
    (job.arrangingParty === 'JOINT' && (order.buyerId === userId || order.sellerId === userId))
  );
}

const TRANSPORT_RELEASE_AFTER_HOURS = resolveReleaseWindowHours('TRANSPORT_RELEASE_AFTER_HOURS', 72);

function transportReleaseAvailableAt(quote) {
  return computeReleaseAvailableAt(quote, TRANSPORT_RELEASE_AFTER_HOURS);
}

// ============================================================================
// COUNTER-CHAIN CAP
// ----------------------------------------------------------------------------
// A counter-offer can legitimately go back and forth — but not forever.
// After MAX_COUNTER_ROUNDS counters (plus the initial bid), the negotiation
// must resolve one way or another: accept the current price, reject it, or
// let the 12-hour expiry close it. Prevents endless ping-pong.
// ============================================================================
const MAX_COUNTER_ROUNDS = 4;

async function countCounterDepth(tx, leafQuoteId) {
  let depth = 0;
  let cursor = leafQuoteId;
  let safety = 0;
  while (cursor && safety < 50) {
    const row = await tx.transportQuote.findUnique({
      where: { id: cursor },
      select: { parentQuoteId: true },
    });
    if (!row?.parentQuoteId) break;
    depth += 1;
    cursor = row.parentQuoteId;
    safety += 1;
  }
  return depth;
}

// ============================================================================
// SUBMIT TRANSPORT QUOTE
// ============================================================================

router.post(
  '/:id/quotes',
  authenticate,
  idempotency('transport.quote-create'),
  requireRole('TRUCK_OWNER'),
  [
    param('id').isUUID(),
    body('amount').custom(validAmount(AMOUNT_LIMITS.transport)),
    body('message').optional().isString().trim().custom(presetMessage(BID_MESSAGES)),
    body('truckId').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      if (job.order && ['DISPUTED', 'CANCELLED'].includes(job.order.status)) {
        return res.status(409).json({
          code: 'ORDER_DISPUTED',
          error: `This order is ${job.order.status.toLowerCase()}. Transport quote proceedings are paused until it is resolved.`,
        });
      }

      await assertProviderCanBid(prisma, req.user.id);

      if (job.method !== 'HIRE_TRANSPORTER') {
        return res.status(400).json({ error: 'Quotes are only for HIRE_TRANSPORTER jobs' });
      }

      if (!['REQUESTED', 'QUOTED', 'ACCEPTED', 'PICKUP', 'IN_TRANSIT'].includes(job.status)) {
        return res.status(400).json({ error: 'This job is no longer accepting quotes' });
      }

      let truckId = req.body.truckId;

      if (!truckId) {
        const truck = await prisma.truck.findFirst({
          where: { ownerId: req.user.id, availability: 'AVAILABLE' },
          orderBy: { createdAt: 'asc' },
        });

        if (!truck) {
          return res.status(400).json({ error: 'You must have an available truck to quote' });
        }

        truckId = truck.id;
      } else {
        const truck = await prisma.truck.findUnique({ where: { id: truckId } });

        if (!truck) return res.status(404).json({ error: 'Truck not found' });

        if (truck.ownerId !== req.user.id) {
          return res.status(403).json({ error: 'Not your truck' });
        }

        if (truck.availability !== 'AVAILABLE') {
          return res.status(400).json({ error: 'Selected truck is not available' });
        }
      }

      const withdrawnBefore = await prisma.transportQuote.findFirst({
        where: { transportJobId: job.id, truckOwnerId: req.user.id, status: 'WITHDRAWN' },
        select: { id: true },
      });
      if (withdrawnBefore) {
        return res.status(409).json({
          code: 'TRANSPORT_REBID_NOT_ALLOWED',
          error: 'You withdrew your earlier bid on this transport job, so you cannot bid on it again.',
        });
      }

      const existing = await prisma.transportQuote.findFirst({
        where: {
          transportJobId: job.id,
          truckOwnerId: req.user.id,
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
          childQuotes: { none: {} },
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'You already have an active quote or negotiation for this job',
        });
      }

      const quote = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, job.orderId, 'a transport quote cannot be submitted until that is resolved');

        const truck = await tx.truck.findUnique({ where: { id: truckId } });

        if (!truck) {
          const error = new Error('Truck not found');
          error.statusCode = 404;
          throw error;
        }

        if (truck.ownerId !== req.user.id) {
          const error = new Error('Not your truck');
          error.statusCode = 403;
          throw error;
        }

        if (truck.availability !== 'AVAILABLE') {
          const error = new Error('Selected truck is no longer available');
          error.code = 'TRUCK_CONFLICT';
          error.statusCode = 409;
          throw error;
        }

        const createdQuote = await tx.transportQuote.create({
          data: {
            transportJobId: job.id,
            truckOwnerId: req.user.id,
            truckId,
            amount: Number(req.body.amount),
            message: req.body.message || null,
            status: 'PENDING',
            // FIXED: waiting bids never expire. They live for as long as the
            // job lives, so the buyer always has a live replacement pool if
            // the accepted transporter walks away — no fresh request needed.
            expiresAt: null,
          },
        });

        if (job.status === 'REQUESTED') {
          await tx.transportJob.update({
            where: { id: job.id },
            data: { status: 'QUOTED' },
          });
        }

        return createdQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ quote });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(String(error.code || '').startsWith('PROVIDER_') ? { code: error.code } : {}),
        });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A quote for this truck and job already exists' });
      }

      return res.status(500).json({ error: 'Could not submit quote' });
    }
  }
);

// ============================================================================
// LIST QUOTES FOR A TRANSPORT JOB
// ============================================================================

router.get(
  '/:id/quotes',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' && (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));

      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to view these quotes' });
      }

      const quotes = await prisma.transportQuote.findMany({
        where: { transportJobId: job.id },
        include: {
          truckOwner: { select: { id: true, name: true, rating: true } },
          truck: true,
        },
        orderBy: { amount: 'asc' },
      });

      return res.json({ quotes });
    } catch (error) {
      req.log.error({ err: error }, 'LIST QUOTES ERROR:');
      return res.status(500).json({ error: 'Could not load quotes' });
    }
  }
);

// ============================================================================
// SHARED LOOKUP FOR NEGOTIATION
// ============================================================================

async function loadTransportQuoteForNegotiation(req, res) {
  const quote = await prisma.transportQuote.findUnique({
    where: { id: req.params.quoteId },
    include: {
      transportJob: { include: { order: true } },
    },
  });

  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return null;
  }

  const job = quote.transportJob;

  if (req.params.id && job.id !== req.params.id) {
    res.status(404).json({ error: 'Quote not found for this transport job' });
    return null;
  }

  const order = job.order;

  if (order && ['DISPUTED', 'CANCELLED'].includes(order.status)) {
    res.status(409).json({
      code: 'ORDER_DISPUTED',
      error: `This order is ${order.status.toLowerCase()}. Transport quote proceedings are paused until it is resolved.`,
    });
    return null;
  }

  const isRequester = isArrangingParty(job, order, req.user.id);
  const isProvider = quote.truckOwnerId === req.user.id;

  if (!isRequester && !isProvider && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Not authorized for this transport quote negotiation' });
    return null;
  }

  return {
    quote,
    job,
    order,
    actorRole: isRequester ? 'REQUESTER' : 'PROVIDER',
  };
}

// ============================================================================
// SELECT TRANSPORT BID FOR DEAL NEGOTIATION
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/select',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      if (actorRole !== 'REQUESTER') return res.status(403).json({ error: 'Only the arranging party can select a transport bid' });
      if (!['REQUESTED', 'QUOTED'].includes(job.status)) return res.status(400).json({ error: 'This transport request is no longer accepting bids' });
      if (quote.status !== 'PENDING') return res.status(400).json({ error: `Only a pending bid can be selected (current: ${quote.status})` });
      if (isQuoteExpired(quote)) return res.status(409).json({ error: 'This quote has expired' });

      const selected = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true, status: true, transportQuoteId: true },
        });
        if (activePayment) {
          throw quoteError(
            'Transporter selection is locked because a transport payment has already started. Wait for that payment to fail/cancel before selecting another quote.',
            409
          );
        }

        const freshJob = await tx.transportJob.findUnique({
          where: { id: job.id },
          select: { id: true, status: true },
        });
        if (!freshJob || !['REQUESTED', 'QUOTED'].includes(freshJob.status)) {
          throw quoteError('This transport request is no longer accepting bids', 409);
        }

        const fresh = await findLeafQuote(tx, quote.id);
        if (!fresh || fresh.status !== 'PENDING') throw quoteError('This bid is no longer available', 409);
        if (isQuoteExpired(fresh)) throw quoteError('This quote has expired', 409);

        const competingThread = await findCompetingLiveQuote(tx, job.id, fresh.id);
        if (competingThread) {
          throw quoteError(
            'Another transporter bid is already in active negotiation. Release or reject that thread before selecting a different bid.',
            409
          );
        }

        const acceptedElsewhere = await tx.transportQuote.findFirst({
          where: { transportJobId: job.id, id: { not: fresh.id }, status: 'ACCEPTED', childQuotes: { none: {} } },
          select: { id: true },
        });
        if (acceptedElsewhere) {
          throw quoteError(
            'A transporter agreement is already provisionally accepted. Release that transporter first to select a different bid.',
            409
          );
        }

        const selectedQuote = await tx.transportQuote.update({ where: { id: fresh.id }, data: { status: 'SELECTED', expiresAt: null } });
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_SELECTED',
          resourceType: 'TransportQuote',
          resourceId: selectedQuote.id,
          metadata: { transportJobId: job.id, truckOwnerId: selectedQuote.truckOwnerId },
        });
        return selectedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      await noticeTransportWaitingLocked(prisma, {
        transportJobId: job.id,
        selectedQuoteId: selected.id,
        selectedTruckOwnerId: selected.truckOwnerId,
      });

      return res.json({ message: 'Transporter bid selected for price negotiation', quote: selected });
    } catch (error) {
      req.log.error({ err: error }, 'SELECT TRANSPORT QUOTE ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not select transport bid' });
    }
  }
);

// ============================================================================
// ACCEPT A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/accept',
  authenticate,
  idempotency('transport.quote-accept'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: `This quote is already ${quote.status.toLowerCase()}` });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      if (quoteTurn(quote) !== effectiveRole && !isAdmin(req.user)) {
        return res.status(409).json({ error: 'It is the other party\u2019s turn to respond to this negotiation' });
      }

      const finalAmount = quote.status === 'COUNTERED' ? quote.counterAmount ?? quote.amount : quote.amount;

      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await findLeafQuote(tx, quote.id, {
          include: { transportJob: { include: { order: true } } },
        });

        if (!freshQuote) {
          throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        }

        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          const error = new Error(`This quote is already ${freshQuote.status.toLowerCase()}`);
          error.statusCode = 409;
          throw error;
        }

        const competingThread = await findCompetingLiveQuote(tx, job.id, freshQuote.id);
        if (competingThread) {
          throw quoteError('Another transporter bid is already in active negotiation. This quote cannot be accepted until the competing thread is released.', 409);
        }

        const freshJob = freshQuote.transportJob;

        if (freshJob.status !== 'REQUESTED' && freshJob.status !== 'QUOTED') {
          const error = new Error(`This transport job cannot accept a quote while it is ${freshJob.status}`);
          error.statusCode = 409;
          throw error;
        }

        await lockOrderAndAssertNotClosed(tx, freshJob.orderId, 'a transport quote cannot be accepted until that is resolved');

        const updatedQuote = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: {
            status: 'ACCEPTED',
            amount: finalAmount,
            // FIXED: the 24h "go to the site" clock starts only when the
            // transport fee is PAID (stamped by the payment success handler).
            // Clear any inherited expiry here so accept never carries a
            // stale deadline from the earlier negotiation window.
            expiresAt: null,
          },
        });

        await tx.transportQuote.updateMany({
          where: {
            transportJobId: freshJob.id,
            id: { not: freshQuote.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          data: { status: 'REJECTED' },
        });

        await tx.transportJob.update({
          where: { id: freshJob.id },
          data: {
            truckOwnerId: freshQuote.truckOwnerId,
            truckId: freshQuote.truckId,
            agreedAmount: finalAmount,
            status: 'ACCEPTED',
            sellerPreparationDueAt: computeSellerPreparationDueAt(),
            buyerLoadingDueAt: null,
          },
        });

        await syncOrderPaymentObligations(tx, freshJob.orderId);

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_ACCEPTED',
          resourceType: 'TransportQuote',
          resourceId: updatedQuote.id,
          metadata: { transportJobId: freshJob.id, truckOwnerId: updatedQuote.truckOwnerId, acceptedBy: effectiveRole, amount: finalAmount },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Transport quote agreed. The transport fee is now payable.', commercialStatus: 'AGREED_PAYABLE', quote: result });
    } catch (error) {
      req.log.error({ err: error }, 'ACCEPT TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// REJECT A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/reject',
  authenticate,
  idempotency('transport.quote-reject'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (quote.status === 'PENDING') {
        return res.status(409).json({
          error: 'Waiting bids cannot be rejected. Select the bid you want to negotiate with; the others will keep waiting.',
        });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: `This quote is already ${quote.status.toLowerCase()}` });
      }

      if (quoteTurn(quote) !== effectiveRole && !isAdmin(req.user)) {
        return res.status(409).json({ error: 'It is the other party\u2019s turn to respond to this negotiation' });
      }

      const updatedQuote = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await findLeafQuote(tx, quote.id);
        if (!freshQuote || !['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError('This quote is no longer available for rejection', 409);
        }
        const competingThread = await findCompetingLiveQuote(tx, job.id, freshQuote.id);
        if (competingThread) {
          throw quoteError('This quote is not the sole active negotiation thread', 409);
        }

        const rejected = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'REJECTED' },
        });

        // FIXED: Same ancestor cleanup as withdraw. Prevents the parent
        // COUNTERED quote from appearing active after the leaf is rejected.
        const ancestorIds = [];
        let cursor = freshQuote.parentQuoteId;
        let safety = 0;
        while (cursor && safety < 20) {
          ancestorIds.push(cursor);
          const parent = await tx.transportQuote.findUnique({
            where: { id: cursor },
            select: { parentQuoteId: true },
          });
          cursor = parent?.parentQuoteId || null;
          safety += 1;
        }
        if (ancestorIds.length) {
          await tx.transportQuote.updateMany({
            where: { id: { in: ancestorIds }, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } },
            data: { status: 'REJECTED' },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_REJECTED',
          resourceType: 'TransportQuote',
          resourceId: rejected.id,
          metadata: { transportJobId: job.id, rejectedBy: effectiveRole },
        });

        return rejected;
      }, { maxWait: 10000, timeout: 15000 });

      await noticeTransportWaitingUnlocked(prisma, {
        transportJobId: job.id,
        reason: 'QUOTE_REJECTED',
      });

      return res.json({ message: 'Quote rejected', quote: updatedQuote });
    } catch (error) {
      req.log.error({ err: error }, 'REJECT TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// COUNTER A TRANSPORT QUOTE
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/counter',
  authenticate,
  idempotency('transport.quote-counter'),
  [
    param('id').isUUID(),
    param('quoteId').isUUID(),
    body('counterAmount').custom(validAmount(AMOUNT_LIMITS.transport)),
    body('message').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }).custom(presetMessage(BID_MESSAGES)),
  ],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({ error: `Quote cannot be countered because it is ${quote.status}` });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      if (quoteTurn(quote) !== effectiveRole) {
        return res.status(409).json({ error: 'It is the other party\u2019s turn to respond to this negotiation' });
      }

      const counterAmount = Number(req.body.counterAmount);

      const counterQuote = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await findLeafQuote(tx, quote.id);
        if (!freshQuote) throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError(`Quote cannot be countered because it is ${freshQuote.status}`, 409);
        }
        const competingThread = await findCompetingLiveQuote(tx, job.id, freshQuote.id);
        if (competingThread) {
          throw quoteError('Another transporter bid is already in active negotiation. Refresh and select only after that negotiation is released.', 409);
        }
        if (quoteTurn(freshQuote) !== effectiveRole) {
          throw quoteError('It is the other party\u2019s turn to respond to this negotiation', 409);
        }

        // FIXED: cap the counter-offer chain. After MAX_COUNTER_ROUNDS
        // counters (plus the initial bid), further counters are refused —
        // the parties must accept, reject, or let it expire.
        const counterDepth = await countCounterDepth(tx, freshQuote.id);
        if (counterDepth >= MAX_COUNTER_ROUNDS) {
          const err = new Error(
            `This negotiation has reached the maximum of ${MAX_COUNTER_ROUNDS} counter-offers. Accept the current price or reject the negotiation.`
          );
          err.statusCode = 409;
          err.code = 'MAX_COUNTER_ROUNDS_REACHED';
          throw err;
        }

        await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'COUNTERED' },
        });

        const updated = await tx.transportQuote.create({
          data: {
            transportJobId: freshQuote.transportJobId,
            truckOwnerId: freshQuote.truckOwnerId,
            truckId: freshQuote.truckId,
            amount: counterAmount,
            parentQuoteId: freshQuote.id,
            status: 'COUNTERED',
            counteredBy: effectiveRole,
            message: req.body.message || freshQuote.message,
            // NOTE: the 12h window here is a negotiation window, not a
            // waiting-bid window.
            expiresAt: quoteExpiry(12),
          },
          include: {
            truckOwner: { select: { id: true, name: true, rating: true } },
            truck: true,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_COUNTERED',
          resourceType: 'TransportQuote',
          resourceId: updated.id,
          metadata: {
            transportJobId: freshQuote.transportJobId,
            counteredBy: effectiveRole,
            previousAmount: String(freshQuote.counterAmount ?? freshQuote.amount),
            counterAmount: String(counterAmount),
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({
        message: effectiveRole === 'REQUESTER'
          ? 'Counter-offer sent. The transporter must respond next.'
          : 'Counter-offer sent. The requester must respond next.',
        quote: counterQuote,
      });
    } catch (error) {
      req.log.error({ err: error }, 'COUNTER TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// WITHDRAW / RELEASE A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/withdraw',
  authenticate,
  idempotency('transport.quote-withdraw'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      const isProviderRelease =
        actorRole === 'PROVIDER' &&
        quote.status === 'ACCEPTED' &&
        quote.truckOwnerId === req.user.id;

      if (actorRole !== 'REQUESTER' && !isProviderRelease) {
        return res.status(403).json({
          error: 'Only the arranging party can release this negotiation',
        });
      }

      const isAcceptedRelease = quote.status === 'ACCEPTED';
      const isSilentRelease =
        quote.status === 'SELECTED' ||
        (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');

      if (!isAcceptedRelease && !isSilentRelease) {
        return res.status(400).json({
          error: `This quote cannot be released in its current state (current: ${quote.status})`,
        });
      }

      if (isSilentRelease) {
        const availableAt = transportReleaseAvailableAt(quote);
        if (availableAt && availableAt.getTime() > Date.now()) {
          return res.status(409).json({
            error: `This truck owner has not been inactive long enough. You can release them from ${availableAt.toISOString()}.`,
            releaseAvailableAt: availableAt,
          });
        }
      }

      let releaseInfo = { reason: 'NO_RESPONSE', note: null };
      if (isAcceptedRelease) {
        try {
          releaseInfo = parseReleaseReason(req.body, { provider: isProviderRelease });
          if (!isProviderRelease) assertAcceptedReleaseWindowElapsed(quote);
        } catch (limitErr) {
          return res.status(limitErr.statusCode || 400).json({
            error: limitErr.message,
            ...(limitErr.releaseAvailableAt ? { releaseAvailableAt: limitErr.releaseAvailableAt } : {}),
          });
        }
      }

      let standingOutcome = null;
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        let releaseNumber = null;
        if (!isProviderRelease) {
          const { used, allowed } = await releaseAllowance(tx, {
            action: isAcceptedRelease
              ? 'TRANSPORT_QUOTE_WITHDRAWN'
              : 'TRANSPORT_SILENT_QUOTE_RELEASED',
            metadataKey: 'transportJobId',
            jobId: job.id,
          });
          if (used >= allowed) {
            await recordAuditEvent(tx, {
              actorId: req.user.id,
              action: 'TRANSPORT_RELEASE_BLOCKED_ADMIN_REVIEW',
              resourceType: 'TransportQuote',
              resourceId: quote.id,
              metadata: {
                transportJobId: job.id,
                orderId: job.orderId,
                requesterId: req.user.id,
                attemptedReason: releaseInfo.reason,
                releasesUsed: used,
                limit: allowed,
                wasSilent: isSilentRelease,
              },
            });
            return { blocked: true };
          }
          releaseNumber = used + 1;
        }

        const freshQuote = await findLeafQuote(tx, quote.id, {
          include: { transportJob: { include: { order: true } } },
        });
        if (!freshQuote) throw quoteError('This negotiation has moved on. Refresh and try again.', 409);

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: freshQuote.transportJobId,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true, status: true },
        });
        if (activePayment) {
          throw quoteError('This transporter cannot be released after transport payment has started or completed', 409);
        }

        if (isAcceptedRelease) {
          const freshJob = await tx.transportJob.findUnique({
            where: { id: freshQuote.transportJobId },
            select: { id: true, status: true, truckOwnerId: true },
          });
          if (
            !freshJob ||
            freshJob.status !== 'ACCEPTED' ||
            freshJob.truckOwnerId !== freshQuote.truckOwnerId
          ) {
            throw quoteError('This provisional transporter agreement is no longer active', 409);
          }
          if (!isProviderRelease) {
            try {
              assertAcceptedReleaseWindowElapsed(freshQuote);
            } catch (e) {
              throw quoteError(e.message, 409);
            }
          }
        } else {
          if (freshQuote.transportJob.status !== 'QUOTED') {
            throw quoteError(`This transport agreement cannot be released while the job is ${freshQuote.transportJob.status}`, 409);
          }
          const freshAvailableAt = transportReleaseAvailableAt(freshQuote);
          if (freshAvailableAt && freshAvailableAt.getTime() > Date.now()) {
            throw quoteError('This negotiation changed. Refresh and try again.', 409);
          }
        }

        const updatedQuote = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'WITHDRAWN' },
        });

        // FIXED: Withdraw every ancestor in the negotiation thread.
        const ancestorIds = [];
        let cursor = freshQuote.parentQuoteId;
        let safety = 0;
        while (cursor && safety < 20) {
          ancestorIds.push(cursor);
          const parent = await tx.transportQuote.findUnique({
            where: { id: cursor },
            select: { parentQuoteId: true },
          });
          cursor = parent?.parentQuoteId || null;
          safety += 1;
        }
        if (ancestorIds.length) {
          await tx.transportQuote.updateMany({
            where: { id: { in: ancestorIds }, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } },
            data: { status: 'WITHDRAWN' },
          });
        }

        if (isAcceptedRelease) {
          await tx.transportJob.update({
            where: { id: freshQuote.transportJobId },
            data: {
              truckOwnerId: null,
              truckId: null,
              agreedAmount: null,
              status: 'QUOTED',
              truckArrivedAt: null,
              truckArrivedConfirmedBy: null,
              sellerPickupConfirmedAt: null,
              sellerPreparationDueAt: null,
              buyerLoadingConfirmedAt: null,
              buyerLoadingDueAt: null,
              ...(isProviderRelease ? {} : { acceptedReleaseCount: { increment: 1 } }),
            },
          });

          await closeCoordination(tx, freshQuote.transportJobId, 'TRANSPORTER_RELEASED');

          await recordOrderEvent(tx, {
            orderId: freshQuote.transportJob.orderId,
            actorId: req.user.id,
            type: 'TRANSPORT_COORDINATION_CLOSED',
            metadata: {
              transportJobId: freshQuote.transportJobId,
              reason: 'TRANSPORTER_RELEASED',
            },
          });
        } else if (isSilentRelease) {
          await tx.transportJob.update({
            where: { id: freshQuote.transportJobId },
            data: { acceptedReleaseCount: { increment: 1 } },
          });
        }

        let providerReleases30d = null;
        if (isProviderRelease) {
          providerReleases30d = (await providerReleaseCountLast30d(tx, req.user.id)) + 1;
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: isProviderRelease
            ? 'TRANSPORT_ACCEPTED_RELEASED_BY_PROVIDER'
            : isAcceptedRelease ? 'TRANSPORT_QUOTE_WITHDRAWN' : 'TRANSPORT_SILENT_QUOTE_RELEASED',
          resourceType: 'TransportQuote',
          resourceId: updatedQuote.id,
          metadata: {
            transportJobId: freshQuote.transportJobId,
            orderId: freshQuote.transportJob.orderId,
            releasedBy: effectiveRole,
            ...(isProviderRelease ? { providerId: req.user.id } : { requesterId: req.user.id }),
            previousStatus: freshQuote.status,
            reason: releaseInfo.reason,
            note: releaseInfo.note,
            releaseNumber,
            ancestorsWithdrawn: ancestorIds.length,
            ...(isProviderRelease
              ? {
                  providerReleases30d,
                  flagged: providerReleases30d >= providerFlagThreshold(),
                }
              : {}),
          },
        });

        if (isProviderRelease) {
          standingOutcome = await applyProviderCancellation(tx, {
            userId: req.user.id,
            orderId: freshQuote.transportJob.orderId,
            reason: releaseInfo.reason,
          });
        }

        await recordOrderEvent(tx, {
          orderId: freshQuote.transportJob.orderId,
          actorId: req.user.id,
          type: isProviderRelease ? 'PROVIDER_AGREEMENT_RELEASED' : 'REQUESTER_AGREEMENT_RELEASED',
          metadata: {
            service: 'TRANSPORT',
            providerId: freshQuote.truckOwnerId,
            reason: releaseInfo.reason,
          },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      if (result && result.blocked) {
        return res.status(409).json({ error: LIMIT_MESSAGE, code: 'RELEASE_LIMIT_REACHED' });
      }

      await noticeTransportWaitingUnlocked(prisma, {
        transportJobId: job.id,
        reason: isAcceptedRelease ? 'PROVISIONAL_RELEASED' : 'SILENT_RELEASED',
      });

      return res.json({
        ...(standingOutcome ? { standing: standingOutcome } : {}),
        message: isProviderRelease
          ? 'Provisional agreement cancelled. The requester can choose another transporter.'
          : isAcceptedRelease
          ? 'Provisional transporter agreement released. Other transport bids are available again.'
          : 'Silent truck owner released. Other transport bids are available again.',
        quote: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'WITHDRAW TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// TRUCK OWNER WITHDRAWS A WAITING BID
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/withdraw-bid',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;

      if (actorRole !== 'PROVIDER') {
        return res.status(403).json({
          error: 'Only the truck owner who submitted the bid can withdraw it',
        });
      }

      if (quote.status !== 'PENDING') {
        return res.status(409).json({
          error: `Only a waiting bid can be withdrawn (current: ${quote.status})`,
        });
      }

      const withdrawn = await prisma.$transaction(async (tx) => {
        const fresh = await findLeafQuote(tx, quote.id);
        if (!fresh || fresh.status !== 'PENDING') {
          throw quoteError('This bid is no longer waiting. Refresh and try again.', 409);
        }

        const updated = await tx.transportQuote.update({
          where: { id: fresh.id },
          data: { status: 'WITHDRAWN' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_WITHDRAWN_BY_PROVIDER',
          resourceType: 'TransportQuote',
          resourceId: updated.id,
          metadata: {
            transportJobId: job.id,
            truckOwnerId: fresh.truckOwnerId,
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Your bid has been withdrawn.', quote: withdrawn });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      req.log.error({ err: error }, 'TRUCK OWNER WITHDRAW BID ERROR:');
      return res.status(500).json({ error: 'Could not withdraw bid' });
    }
  }
);

module.exports = router;
