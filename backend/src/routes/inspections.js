const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { newCodeSalt, config: arrivalConfig } = require('../services/inspectionArrivalLogic');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const paymentService = require('../services/paymentService');
const {
  noticeInspectionWaitingUnlocked,
} = require('../services/waitingListService');
const { lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const {
  computeSellerConfirmationDueAt,
  lapseInspectionAgreement,
} = require('../services/inspectionLapseService');
const {
  computeInspectionWorkflowDueAt,
  computeInspectionStartDueAt,
  computeInspectionCompletionDueAt,
  computePaymentDueAt,
} = require('../utils/orderTiming');
const {
  noContactInfo,
} = require('../utils/contactGuard');
const {
  closeCoordination,
} = require('../services/inspectionCoordinationService');

// ============================================================================
// INSPECTOR COORDINATION WINDOW
// ----------------------------------------------------------------------------
// From the moment the price is agreed (quote ACCEPTED) the inspector has 3
// hours to submit their coordination handoff. If they don't, the agreement
// lapses and the request returns to the open bidding pool. Overridable via
// env for testing / policy tuning.
// ============================================================================
const INSPECTOR_COORDINATION_WINDOW_HOURS = (() => {
  const configured = Number(process.env.INSPECTOR_COORDINATION_WINDOW_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3;
})();

function computeInspectorCoordinationDueAt() {
  return new Date(Date.now() + INSPECTOR_COORDINATION_WINDOW_HOURS * 60 * 60 * 1000);
}

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

// ============================================================================
// INSPECTION WORK DETAILS — allow-listed, size-capped
// ============================================================================
const WORK_CATEGORIES = new Set([
  'GENERAL_QUALITY',
  'AGRICULTURAL_PRODUCE',
  'QUANTITY_VERIFICATION',
  'DAMAGE_ASSESSMENT',
  'FUNCTIONAL_TESTING',
  'CONFORMITY_CHECK',
  'SAFETY_COMPLIANCE',
]);

const WORK_CHECKS = new Set([
  'QUALITY_GRADE',
  'SIZE_WEIGHT',
  'MOISTURE',
  'VISIBLE_DEFECTS',
  'PACKAGING',
  'SAMPLING',
  'PHOTOGRAPHS',
]);

const REPORT_FORMATS = new Set([
  'CHECKLIST_PHOTOS',
  'MEASUREMENTS',
  'PASS_FAIL',
  'FULL_REPORT',
]);

function sanitizeWorkDetails(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const out = {};

  if (typeof input.workCategory === 'string' && WORK_CATEGORIES.has(input.workCategory)) {
    out.workCategory = input.workCategory;
  }

  if (typeof input.quantityValue === 'string') {
    const v = input.quantityValue.trim();
    if (v) out.quantityValue = v.slice(0, 40);
  } else if (typeof input.quantityToInspect === 'string') {
    const v = input.quantityToInspect.trim();
    if (v) out.quantityValue = v.slice(0, 40);
  }

  if (typeof input.quantityUnit === 'string') {
    const u = input.quantityUnit.trim();
    if (u) out.quantityUnit = u.slice(0, 40);
  }

  if (input.lotCount != null && input.lotCount !== '') {
    const n = Number(input.lotCount);
    if (Number.isFinite(n) && n > 0 && n <= 10000) {
      out.lotCount = Math.floor(n);
    }
  }

  if (Array.isArray(input.checks)) {
    out.checks = [
      ...new Set(input.checks.filter((v) => typeof v === 'string' && WORK_CHECKS.has(v))),
    ].slice(0, WORK_CHECKS.size);
  }

  if (typeof input.reportFormat === 'string' && REPORT_FORMATS.has(input.reportFormat)) {
    out.reportFormat = input.reportFormat;
  }

  if (typeof input.requiredBy === 'string') {
    const d = new Date(input.requiredBy);
    if (!Number.isNaN(d.getTime())) out.requiredBy = d.toISOString();
  }

  return Object.keys(out).length ? out : null;
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
            workDetails: sanitizeWorkDetails(req.body?.workDetails),
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

    const inFlightPayment = await prisma.payment.findFirst({
      where: {
        inspectionRequestId: request.id,
        type: 'INSPECTOR',
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      select: { id: true, status: true },
    });
    if (inFlightPayment) {
      return res.status(409).json({
        error: 'An inspection payment is still in flight. Wait for it to settle or fail, then try again.',
      });
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be cancelled until the order dispute is resolved');
      const fresh = await tx.inspectionRequest.findUnique({ where: { id: request.id } });
      if (!fresh) throw Object.assign(new Error('Inspection request not found'), { statusCode: 404 });
      if (['COMPLETED', 'IN_PROGRESS'].includes(fresh.status)) throw Object.assign(new Error(`An inspection cannot be cancelled while it is ${fresh.status.toLowerCase()}`), { statusCode: 409 });
      const updated = await tx.inspectionRequest.update({ where: { id: fresh.id }, data: { inspectorId: null, fee: null, feeTermsLockedAt: null, lockedFee: null, lockedFeePayer: null, lockedBuyerFeeAmount: null, lockedSellerFeeAmount: null, status: 'CANCELLED' } });
      await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } }, data: { status: 'EXPIRED' } });
      await closeCoordination(tx, fresh.id, 'INSPECTION_CANCELLED');

      const paidInspectorPayments = await tx.payment.findMany({
        where: { inspectionRequestId: fresh.id, type: 'INSPECTOR', status: 'PAID' },
        select: { id: true },
      });
      for (const p of paidInspectorPayments) {
        await paymentService.requestRefund(tx, {
          paymentId: p.id,
          reason: 'Inspection request cancelled by requester',
          requestedById: req.user.id,
        });
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'INSPECTION_REQUEST_CANCELLED',
        resourceType: 'InspectionRequest',
        resourceId: fresh.id,
        metadata: { orderId: fresh.orderId, refundedPayments: paidInspectorPayments.map((p) => p.id) },
      });

      return updated;
    }, { maxWait: 10000, timeout: 15000 });
    return res.json({ message: 'Inspection request cancelled. The inspector fee is being refunded.', request: cancelled });
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
      const liveBidders = await tx.inspectionQuote.count({ where: { inspectionRequestId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } } });
      if (liveBidders > 0) {
        throw Object.assign(new Error(`A fresh inspection form cannot be released while ${liveBidders} inspector bid(s) are still waiting or pending. They stay on the waiting list until the selected inspector submits the report or they release themselves.`), { statusCode: 409 });
      }
      const updated = await tx.inspectionRequest.update({
        where: { id: fresh.id },
        data: {
          inspectorId: null,
          fee: null,
          buyerFeeAmount: null,
          sellerFeeAmount: null,
          sellerConfirmedAt: null,
          inspectorOnSiteConfirmedAt: null,
          feeTermsLockedAt: null,
          lockedFee: null,
          lockedFeePayer: null,
          lockedBuyerFeeAmount: null,
          lockedSellerFeeAmount: null,
          workflowDueAt: computeInspectionWorkflowDueAt(),
          coordinationDueAt: null,
          startDueAt: null,
          completionDueAt: null,
          startedAt: null,
          status: 'REQUESTED',
          acceptedReleaseCount: 0,
        },
      });
      await closeCoordination(tx, fresh.id, 'ADMIN_REOPENED_BIDDING');
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_BIDDING_REOPENED', resourceType: 'InspectionRequest', resourceId: fresh.id, metadata: { orderId: fresh.orderId } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });
    return res.json({ message: 'Fresh inspection form released.', request: reopened });
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
          ...(location ? { location: { contains: location, mode: 'insensitive' } } : {}),
          status: { in: ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'] },
        },
        select: {
          id: true,
          orderId: true,
          listingId: true,
          status: true,
          mode: true,
          location: true,
          workDetails: true,
          createdAt: true,
          listing: {
            select: { id: true, cropType: true, title: true, quantity: true, unit: true, location: true, category: true },
          },
          requestedBy: {
            select: { id: true, name: true, rating: true },
          },
          inspector: {
            select: { id: true, name: true, rating: true },
          },
          quotes: {
            where: {
              inspectorId: req.user.id,
            },
            select: {
              id: true,
              amount: true,
              status: true,
              message: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
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
// INSPECTION ASSIGNMENT (legacy — disabled)
// ============================================================================

router.patch('/:id/accept', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  return res.status(410).json({
    error: 'Direct inspection acceptance is no longer supported. Submit a competitive quote; the requester selects and negotiates the winning bid.',
  });
});

// ============================================================================
// Seller review queue
// ============================================================================

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

// ============================================================================
// SELLER CONFIRMS INSPECTOR ON-SITE (merged)
// ============================================================================

router.post('/:id/seller-confirm', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const preCheck = await prisma.inspectionRequest.findUnique({
      where: { id: req.params.id },
      include: {
        order: { select: { id: true, sellerId: true } },
        coordination: true,
      },
    });

    if (
      preCheck &&
      preCheck.status === 'ACCEPTED' &&
      preCheck.inspectorId &&
      preCheck.coordinationDueAt &&
      new Date(preCheck.coordinationDueAt) <= new Date() &&
      !preCheck.coordination?.inspectorSubmittedAt
    ) {
      const lapsed = await prisma.$transaction(async (tx) => {
        return lapseInspectionAgreement(tx, {
          inspectionRequestId: preCheck.id,
          code: 'INSPECTOR_COORDINATION_EXPIRED',
          actorId: null,
          actorRole: 'SYSTEM',
        });
      }, { maxWait: 10000, timeout: 15000 });

      if (lapsed?.lapsed) {
        await noticeInspectionWaitingUnlocked(prisma, {
          inspectionRequestId: preCheck.id,
          reason: 'INSPECTOR_COORDINATION_EXPIRED',
        }).catch(() => {});
      }

      return res.status(409).json({
        code: 'COORDINATION_WINDOW_EXPIRED',
        error: `The inspector did not share their arrival handoff within ${INSPECTOR_COORDINATION_WINDOW_HOURS} hours of accepting the price. The provisional agreement has expired and the request is back in the bidding pool.`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.inspectionRequest.findUnique({
        where: { id: req.params.id },
        include: {
          order: { select: { id: true, sellerId: true, status: true } },
          coordination: true,
        },
      });
      if (!request) throw Object.assign(new Error('Inspection request not found'), { statusCode: 404 });
      if (request.orderId) {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be confirmed until that is resolved');
      }
      if (request.order && ['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(request.order.status)) {
        throw Object.assign(new Error(`This order is ${request.order.status.toLowerCase()}, so the inspection can no longer be confirmed`), { statusCode: 409 });
      }
      if (request.workflowDueAt && request.workflowDueAt <= new Date()) {
        throw Object.assign(new Error('The confirmation window has expired. The provisional agreement is being closed.'), { statusCode: 409 });
      }
      if (!request.order || request.order.sellerId !== req.user.id) {
        throw Object.assign(new Error('Only the order seller can confirm this inspection'), { statusCode: 403 });
      }
      if (request.status !== 'ACCEPTED' || !request.inspectorId) {
        throw Object.assign(new Error('Only a provisionally agreed inspection can be confirmed'), { statusCode: 409 });
      }
      if (request.sellerConfirmedAt || request.inspectorOnSiteConfirmedAt) {
        throw Object.assign(new Error('This inspection has already been confirmed'), { statusCode: 409 });
      }
      if (request.fee == null || Number(request.fee) <= 0) {
        throw Object.assign(new Error('An agreed inspection fee is required before confirmation'), { statusCode: 409 });
      }

      const coordination = request.coordination;
      if (!coordination || coordination.supersededAt) {
        throw Object.assign(new Error('Coordination must be opened before the inspection can be confirmed'), { statusCode: 409, code: 'COORDINATION_NOT_OPEN' });
      }
      if (!coordination.sellerSubmittedAt) {
        throw Object.assign(new Error('Save your site handoff details before accepting the inspector and fee'), { statusCode: 409, code: 'COORDINATION_SELLER_INCOMPLETE' });
      }
      if (!coordination.inspectorSubmittedAt) {
        throw Object.assign(new Error('Waiting for the inspector to share their arrival details. You can accept once they have submitted their handoff.'), { statusCode: 409, code: 'COORDINATION_INSPECTOR_INCOMPLETE' });
      }

      const now = new Date();
      const message = typeof req.body?.message === 'string'
        ? req.body.message.trim().slice(0, 500)
        : null;

      const updated = await tx.inspectionRequest.updateMany({
        where: {
          id: request.id,
          status: 'ACCEPTED',
          inspectorId: request.inspectorId,
          sellerConfirmedAt: null,
          inspectorOnSiteConfirmedAt: null,
        },
        data: {
          sellerConfirmedAt: now,
          // Accepting the inspector and fee does NOT mean the inspector is on site.
          // Arrival is proven later by the inspector's check-in (GPS + photo +
          // optional handshake code): see routes/inspectionArrival.js.
          arrivalCodeSalt: newCodeSalt(),
          arrivalCodeFailedAttempts: 0,
          feeTermsLockedAt: now,
          lockedFee: request.fee,
          lockedFeePayer: request.feePayer,
          lockedBuyerFeeAmount: request.feePayer === 'SELLER' ? null : request.feePayer === 'SPLIT' ? Math.round(Number(request.fee) * 50) / 100 : request.fee,
          lockedSellerFeeAmount: request.feePayer === 'BUYER' ? null : request.feePayer === 'SPLIT' ? Math.round((Number(request.fee) - Math.round(Number(request.fee) * 50) / 100) * 100) / 100 : request.fee,
          // The next deadline is the arrival window; the 24h fee-payment clock
          // starts only once the arrival is confirmed.
          workflowDueAt: new Date(Date.now() + arrivalConfig.arrivalWindowHours() * 60 * 60 * 1000),
          coordinationDueAt: null,
          startDueAt: null,
          sellerMessage: message || null,
          sellerMessageAt: message ? now : null,
        },
      });
      if (!updated.count) throw Object.assign(new Error('Inspection was already confirmed or its status changed'), { statusCode: 409 });

      await syncOrderPaymentObligations(tx, request.orderId);

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'INSPECTION_SELLER_CONFIRMED',
        resourceType: 'InspectionRequest',
        resourceId: request.id,
        metadata: { inspectorId: request.inspectorId, message, inspectorOnSiteConfirmed: false },
      });
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: req.user.id,
        type: 'INSPECTION_ACCEPTED',
        metadata: { inspectionRequestId: request.id, sellerConfirmed: true, inspectorOnSiteConfirmed: false, message },
      });

      return {
        sellerConfirmedAt: now.toISOString(),
        arrivalDueAt: new Date(now.getTime() + arrivalConfig.arrivalWindowHours() * 60 * 60 * 1000).toISOString(),
      };
    });

    return res.json({
      message: 'Inspector and fee accepted. When the inspector arrives they check in on site; the inspection fee can be paid once their arrival is confirmed.',
      ...result,
    });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION CONFIRM ERROR');
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Could not accept the inspector and fee',
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

router.post('/:id/inspector-arrived', authenticate, requireRole('SELLER'), async (req, res) => {
  return res.status(410).json({
    code: 'ENDPOINT_MERGED',
    error: 'Arrival is now proven by the inspector checking in. Use POST /inspections/:id/arrival/check-in (inspector) and POST /inspections/:id/arrival/confirm or /arrival/dispute (seller).',
  });
});

router.post('/:id/seller-decline', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.inspectionRequest.findUnique({
        where: { id: req.params.id },
        include: { order: { select: { id: true, sellerId: true } } },
      });
      if (!request) throw Object.assign(new Error('Inspection request not found'), { statusCode: 404 });
      if (!request.order || request.order.sellerId !== req.user.id) {
        throw Object.assign(new Error('Only the order seller can decline this inspection'), { statusCode: 403 });
      }
      if (request.orderId) {
        await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspection cannot be declined until that is resolved');
      }
      if (request.status !== 'ACCEPTED' || request.sellerConfirmedAt) {
        throw Object.assign(new Error('Only an unconfirmed provisional inspection can be declined'), { statusCode: 409 });
      }
      const outcome = await lapseInspectionAgreement(tx, {
        inspectionRequestId: request.id,
        code: 'SELLER_DECLINED',
        actorId: req.user.id,
        actorRole: 'SELLER',
      });
      if (!outcome.lapsed) throw Object.assign(new Error('The inspection could not be declined in its current state'), { statusCode: 409 });
      return outcome;
    }, { maxWait: 10000, timeout: 15000 });

    await noticeInspectionWaitingUnlocked(prisma, {
      inspectionRequestId: req.params.id,
      reason: 'INSPECTION_SELLER_DECLINED',
    }).catch(() => {});

    return res.json({ message: 'Inspection declined. The provisional purchase has been closed and the buyer notified.', ...result });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION DECLINE ERROR');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not decline inspection' });
  }
});

router.post('/:id/seller-message', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 500) return res.status(400).json({ error: 'Message must contain 1–500 characters' });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { listing: true, order: { select: { sellerId: true } } } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    const authoritativeSellerId = request.order ? request.order.sellerId : request.listing.sellerId;
    if (authoritativeSellerId !== req.user.id) return res.status(403).json({ error: 'Only the order seller can send inspection instructions' });

    if (!['ACCEPTED', 'IN_PROGRESS', 'STALLED'].includes(request.status)) {
      return res.status(409).json({
        error: 'Seller instructions can only be added after an inspector has been accepted for this inspection.',
      });
    }

    const updated = await prisma.inspectionRequest.update({ where: { id: request.id }, data: { sellerMessage: message, sellerMessageAt: new Date() } });
    await prisma.$transaction(async (tx) => {
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_SELLER_MESSAGE', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { message } });
    });
    return res.json({ message: 'Seller instructions saved to the inspection record. This does not confirm the inspection.', sellerMessage: updated.sellerMessage, sellerMessageAt: updated.sellerMessageAt });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER INSPECTION MESSAGE ERROR');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not save seller instructions' });
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
      if (!request.inspectorOnSiteConfirmedAt) {
        return res.status(409).json({
          code: 'INSPECTOR_ARRIVAL_NOT_CONFIRMED',
          error: 'The seller must confirm the inspector is on site and ready to start before work can begin.',
        });
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
            inspectorOnSiteConfirmedAt: { not: null },
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

      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not start inspection' });
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

module.exports = router;
