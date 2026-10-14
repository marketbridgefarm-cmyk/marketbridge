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

const {
  computeSellerConfirmationDueAt,
} = require('../services/inspectionLapseService');

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
  noContactInfo,
} = require('../utils/contactGuard');

const {
  BID_MESSAGES,
  presetMessage,
} = require('../utils/requestOptions');

const {
  closeCoordination,
  ensureOpenCoordination,
} = require('../services/inspectionCoordinationService');

const {
  noticeInspectionWaitingLocked,
  noticeInspectionWaitingUnlocked,
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
// INSPECTION QUOTES
// ----------------------------------------------------------------------------
// Sealed-bid submission, comparison, and counter-offer negotiation for
// inspection services. Extracted from routes/inspections.js so the
// inspection lifecycle file stays focused on the request state machine.
//
// Same paths, same responses, same validation — pure relocation.
// ============================================================================

const router = express.Router();

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

async function findLeafQuote(tx, quoteId) {
  return tx.inspectionQuote.findFirst({
    where: { id: quoteId, childQuotes: { none: {} } },
  });
}

async function findCompetingLiveQuote(tx, inspectionRequestId, exceptQuoteId) {
  return tx.inspectionQuote.findFirst({
    where: {
      inspectionRequestId,
      id: { not: exceptQuoteId },
      status: { in: ['SELECTED', 'COUNTERED'] },
      childQuotes: { none: {} },
    },
    select: { id: true, inspectorId: true, status: true },
  });
}

const INSPECTION_RELEASE_AFTER_HOURS = resolveReleaseWindowHours('INSPECTION_RELEASE_AFTER_HOURS', 72);

function inspectionReleaseAvailableAt(quote) {
  return computeReleaseAvailableAt(quote, INSPECTION_RELEASE_AFTER_HOURS);
}

// ============================================================================
// SHARED LOOKUP FOR NEGOTIATION
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

      await assertProviderCanBid(prisma, req.user.id);

      if (['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(request.status)) {
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
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
          childQuotes: { none: {} },
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'You already have an active quote or negotiation for this inspection',
        });
      }

      const cancelledBefore = await prisma.auditEvent.count({
        where: {
          actorId: req.user.id,
          action: 'INSPECTION_ACCEPTED_RELEASED_BY_PROVIDER',
          metadata: { path: ['inspectionRequestId'], equals: request.id },
        },
      });
      if (cancelledBefore > 0) {
        return res.status(409).json({
          error: 'You cancelled an accepted agreement on this inspection and cannot bid on it again.',
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
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(String(error.code || '').startsWith('PROVIDER_') ? { code: error.code } : {}),
        });
      }
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
// MY ACTIVE QUOTES (provider side)
// ============================================================================

router.get(
  '/my-quotes',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const quotes = await prisma.inspectionQuote.findMany({
        where: {
          inspectorId: req.user.id,
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
          childQuotes: { none: {} },
        },
        include: {
          inspectionRequest: {
            select: {
              id: true,
              status: true,
              mode: true,
              requestedById: true,
              inspectorId: true,
              listing: { select: { id: true, cropType: true, title: true, location: true } },
              requestedBy: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ quotes });
    } catch (error) {
      req.log.error({ err: error }, 'MY INSPECTION QUOTES ERROR:');
      return res.status(500).json({ error: 'Could not load your inspection quotes' });
    }
  }
);

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
        const fresh = await findLeafQuote(tx, quote.id);
        if (!fresh || fresh.status !== 'PENDING') {
          throw quoteError('This bid is no longer available', 409);
        }
        if (isQuoteExpired(fresh)) {
          throw quoteError('This bid has expired', 409);
        }

        const competing = await findCompetingLiveQuote(tx, request.id, fresh.id);
        if (competing) {
          throw quoteError(
            'Another inspector bid is already in negotiation. Resolve it before selecting a different bid.',
            409
          );
        }

        return tx.inspectionQuote.update({ where: { id: fresh.id }, data: { status: 'SELECTED', expiresAt: null } });
      }, { maxWait: 10000, timeout: 15000 });

      await noticeInspectionWaitingLocked(prisma, {
        inspectionRequestId: request.id,
        selectedQuoteId: selected.id,
        selectedInspectorId: selected.inspectorId,
      });

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

        const fresh = await findLeafQuote(tx, quote.id);
        if (!fresh || !['SELECTED', 'COUNTERED'].includes(fresh.status)) {
          throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        }

        const sellerConfirmationDueAt = computeSellerConfirmationDueAt();

        // This update claims the job for the ACTIVE inspector.
        // New waiting bids will still be allowed because the GET /available and POST /quote routes are open.
        const claim = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            status: 'REQUESTED',
            inspectorId: null,
          },
          data: {
            inspectorId: fresh.inspectorId,
            fee: finalAmount,
            feePayer: request.feePayer,
            buyerFeeAmount: request.feePayer === 'SELLER' ? null : request.feePayer === 'SPLIT' ? Math.round(finalAmount * 50) / 100 : finalAmount,
            sellerFeeAmount: request.feePayer === 'BUYER' ? null : request.feePayer === 'SPLIT' ? Math.round((finalAmount - Math.round(finalAmount * 50) / 100) * 100) / 100 : finalAmount,
            status: 'ACCEPTED',
            workflowDueAt: sellerConfirmationDueAt,
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
          where: { id: fresh.id },
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
              sellerConfirmed: false,
              deadline: sellerConfirmationDueAt.toISOString(),
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
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not accept inspection quote' });
    }
  }
);

// ============================================================================
// COUNTER INSPECTION QUOTE
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

        const freshQuote = await findLeafQuote(tx, quote.id);
        if (!freshQuote) {
          throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        }
        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError(`Quote cannot be countered because it is ${freshQuote.status}`, 409);
        }

        const freshTurn = quoteTurn(freshQuote);
        if (freshTurn !== null && freshTurn !== actorRole) {
          throw quoteError('It is the other party\u2019s turn to respond to this negotiation', 409);
        }

        const competing = await findCompetingLiveQuote(tx, request.id, freshQuote.id);
        if (competing) {
          throw quoteError(
            'Another inspector bid is already in negotiation. Resolve it before countering a different bid.',
            409
          );
        }

        await tx.inspectionQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'COUNTERED' },
        });

        const updated = await tx.inspectionQuote.create({
          data: {
            inspectionRequestId: freshQuote.inspectionRequestId,
            inspectorId: freshQuote.inspectorId,
            amount: counterAmount,
            parentQuoteId: freshQuote.id,
            status: 'COUNTERED',
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
// REJECT INSPECTION QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/reject',
  authenticate,
  [
    param('id').notEmpty(),
    param('quoteId').notEmpty(),
  ],
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, actorRole } = loaded;

      if (quote.status === 'PENDING') {
        return res.status(409).json({
          error: 'Waiting bids cannot be rejected. Select the bid you want to negotiate with; the others will keep waiting.',
        });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
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

        const fresh = await findLeafQuote(tx, quote.id);
        if (!fresh || !['SELECTED', 'COUNTERED'].includes(fresh.status)) {
          throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        }

        const rejected = await tx.inspectionQuote.update({
          where: { id: fresh.id },
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

      await noticeInspectionWaitingUnlocked(prisma, {
        inspectionRequestId: loaded.request.id,
        reason: 'QUOTE_REJECTED',
      });

      return res.json({ message: 'Quote rejected', quote: updated });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      req.log.error({ err: error }, 'REJECT INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not reject inspection quote' });
    }
  }
);

// ============================================================================
// RELEASE PROVISIONAL AGREEMENT OR SILENT SELECTED INSPECTOR
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/withdraw',
  authenticate,
  [
    param('id').notEmpty(),
    param('quoteId').notEmpty(),
  ],
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      const isProviderRelease =
        actorRole === 'PROVIDER' &&
        quote.status === 'ACCEPTED' &&
        quote.inspectorId === req.user.id;

      if (actorRole !== 'REQUESTER' && !isProviderRelease) {
        return res.status(403).json({ error: 'Only the requester can release this negotiation' });
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
        const availableAt = inspectionReleaseAvailableAt(quote);
        if (availableAt && availableAt.getTime() > Date.now()) {
          return res.status(409).json({
            error: `This inspector has not been inactive long enough. You can release them from ${availableAt.toISOString()}.`,
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
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection agreement cannot be released until the order dispute is resolved');

        let releaseNumber = null;
        if (!isProviderRelease) {
          const { used, allowed } = await releaseAllowance(tx, {
            action: isAcceptedRelease
              ? 'INSPECTION_QUOTE_WITHDRAWN'
              : 'INSPECTION_SILENT_INSPECTOR_RELEASED',
            metadataKey: 'inspectionRequestId',
            jobId: request.id,
          });
          if (used >= allowed) {
            await recordAuditEvent(tx, {
              actorId: req.user.id,
              action: 'INSPECTION_RELEASE_BLOCKED_ADMIN_REVIEW',
              resourceType: 'InspectionQuote',
              resourceId: quote.id,
              metadata: {
                inspectionRequestId: request.id,
                orderId: request.orderId,
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

        const freshQuote = await findLeafQuote(tx, quote.id);
        if (!freshQuote) {
          throw quoteError('This negotiation has moved on. Refresh and try again.', 409);
        }

        if (isAcceptedRelease) {
          if (!isProviderRelease) {
            try {
              assertAcceptedReleaseWindowElapsed(freshQuote);
            } catch (e) {
              throw quoteError(e.message, 409);
            }
          }
          const freshRequest = await tx.inspectionRequest.findUnique({ where: { id: request.id } });
          if (!freshRequest || freshRequest.status !== 'ACCEPTED' || freshRequest.inspectorId !== freshQuote.inspectorId) {
            throw quoteError('This provisional inspection agreement is no longer active', 409);
          }
        } else {
          const freshAvailableAt = inspectionReleaseAvailableAt(freshQuote);
          if (freshAvailableAt && freshAvailableAt.getTime() > Date.now()) {
            throw quoteError('This negotiation changed. Refresh and try again.', 409);
          }
        }

        const updatedQuote = await tx.inspectionQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'WITHDRAWN' },
        });

        if (isAcceptedRelease) {
          await tx.inspectionRequest.update({
            where: { id: request.id },
            data: {
              inspectorId: null,
              fee: null,
              feeTermsLockedAt: null,
              lockedFee: null,
              lockedFeePayer: null,
              lockedBuyerFeeAmount: null,
              lockedSellerFeeAmount: null,
              buyerFeeAmount: null,
              sellerFeeAmount: null,
              sellerConfirmedAt: null,
              inspectorOnSiteConfirmedAt: null,
              status: 'REQUESTED',
              ...(isProviderRelease ? {} : { acceptedReleaseCount: { increment: 1 } }),
            },
          });
        } else if (isSilentRelease) {
          await tx.inspectionRequest.update({
            where: { id: request.id },
            data: { acceptedReleaseCount: { increment: 1 } },
          });
        }

        await closeCoordination(tx, request.id, isAcceptedRelease ? 'INSPECTOR_WITHDREW' : 'SILENT_INSPECTOR_RELEASED');

        let providerReleases30d = null;
        if (isProviderRelease) {
          providerReleases30d = (await providerReleaseCountLast30d(tx, req.user.id)) + 1;
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: isProviderRelease
            ? 'INSPECTION_ACCEPTED_RELEASED_BY_PROVIDER'
            : isAcceptedRelease ? 'INSPECTION_QUOTE_WITHDRAWN' : 'INSPECTION_SILENT_INSPECTOR_RELEASED',
          resourceType: 'InspectionQuote',
          resourceId: updatedQuote.id,
          metadata: {
            inspectionRequestId: request.id,
            inspectorId: freshQuote.inspectorId,
            releasedBy: actorRole,
            ...(isProviderRelease ? { providerId: req.user.id } : { requesterId: req.user.id }),
            previousStatus: freshQuote.status,
            reason: releaseInfo.reason,
            note: releaseInfo.note,
            releaseNumber,
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
            orderId: request.orderId,
            reason: releaseInfo.reason,
          });
        }

        await recordOrderEvent(tx, {
          orderId: request.orderId,
          actorId: req.user.id,
          type: isProviderRelease ? 'PROVIDER_AGREEMENT_RELEASED' : 'REQUESTER_AGREEMENT_RELEASED',
          metadata: {
            service: 'INSPECTION',
            providerId: freshQuote.inspectorId,
            reason: releaseInfo.reason,
          },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      if (result && result.blocked) {
        return res.status(409).json({ error: LIMIT_MESSAGE, code: 'RELEASE_LIMIT_REACHED' });
      }

      await noticeInspectionWaitingUnlocked(prisma, {
        inspectionRequestId: request.id,
        reason: isAcceptedRelease ? 'PROVISIONAL_RELEASED' : 'SILENT_RELEASED',
      });

      return res.json({
        ...(standingOutcome ? { standing: standingOutcome } : {}),
        message: isProviderRelease
          ? 'Provisional agreement cancelled. The requester can choose another inspector.'
          : isAcceptedRelease
          ? 'Provisional inspector agreement released. Other inspector bids are available again.'
          : 'Silent inspector released. Other inspector bids are available again.',
        quote: result,
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      req.log.error({ err: error }, 'WITHDRAW INSPECTION QUOTE ERROR:');
      return res.status(500).json({ error: 'Could not release inspection agreement' });
    }
  }
);

// ============================================================================
// INSPECTOR WITHDRAWS A WAITING BID
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/withdraw-bid',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const loaded = await loadQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { request, quote, actorRole } = loaded;

      if (actorRole !== 'PROVIDER') {
        return res.status(403).json({ error: 'Only the inspector who submitted the bid can withdraw it' });
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

        const updated = await tx.inspectionQuote.update({
          where: { id: fresh.id },
          data: { status: 'WITHDRAWN' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_WITHDRAWN_BY_PROVIDER',
          resourceType: 'InspectionQuote',
          resourceId: updated.id,
          metadata: { inspectionRequestId: request.id, inspectorId: fresh.inspectorId },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Your bid has been withdrawn.', quote: withdrawn });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      req.log.error({ err: error }, 'INSPECTOR WITHDRAW BID ERROR:');
      return res.status(500).json({ error: 'Could not withdraw bid' });
    }
  }
);

module.exports = router;
