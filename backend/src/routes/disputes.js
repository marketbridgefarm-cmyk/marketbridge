const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { transitionOrderStatus, DISPUTABLE_STATUSES } = require('../services/orderStateMachine');
const { holdForDispute, resumeAfterDispute } = require('../services/payoutService');
const { cancelOrderInTransaction } = require('../services/orderCancellationService');
const { noContactInfo, findContactInfo } = require('../utils/contactGuard');
const paymentService = require('../services/paymentService');

const router = express.Router();

// ============================================================================
// CREATE DISPUTE
// ============================================================================

router.post(
  '/',
  authenticate,
  [
    body('orderId').isUUID().withMessage('orderId must be a valid UUID'),
    body('againstId').isUUID().withMessage('againstId must be a valid UUID'),
    body('disputeType').isString().trim().isLength({ min: 2, max: 50 }).withMessage('disputeType must be 2-50 characters').custom(noContactInfo),
    body('description').isString().trim().isLength({ min: 10, max: 5000 }).withMessage('description must be 10-5000 characters').custom(noContactInfo),
    body('evidence').optional({ nullable: true }).isArray({ max: 10 }).withMessage('evidence must contain at most 10 references'),
    body('evidence.*').optional().isString().trim().isLength({ min: 1, max: 2048 }).withMessage('Each evidence reference must be 1-2048 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });

      const { orderId, againstId, disputeType, description, evidence } = req.body;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          transportJob: true,
          inspectionRequests: {
            where: { status: { not: 'CANCELLED' } },
            select: { inspectorId: true },
          },
        },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      const truckOwnerId = order.transportJob?.truckOwnerId;
      const inspectorIds = (order.inspectionRequests || []).map((request) => request.inspectorId);
      const participants = [...new Set([order.buyerId, order.sellerId, truckOwnerId, ...inspectorIds].filter(Boolean))];

      if (!participants.includes(req.user.id)) {
        return res.status(403).json({ error: 'You are not a participant on this order' });
      }

      if (againstId === req.user.id) {
        return res.status(400).json({ error: 'You cannot raise a dispute against yourself' });
      }

      if (!participants.includes(againstId)) {
        return res.status(400).json({ error: 'againstId must be another participant on this order' });
      }

      if (order.status === 'DISPUTED') {
        return res.status(409).json({ error: 'This order already has an open dispute' });
      }

      if (!DISPUTABLE_STATUSES.includes(order.status)) {
        return res.status(400).json({ error: `An order in ${order.status} status cannot be disputed` });
      }

      const result = await prisma.$transaction(async (tx) => {
        const dispute = await tx.dispute.create({
          data: {
            orderId,
            raisedById: req.user.id,
            againstId,
            disputeType,
            description,
            evidence: evidence || [],
            previousOrderStatus: order.status,
          },
        });

        await transitionOrderStatus(tx, orderId, order.status, 'DISPUTED');

        await holdForDispute(tx, { orderId, actorId: req.user.id, disputeType });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'DISPUTE_RAISED',
          resourceType: 'Dispute',
          resourceId: dispute.id,
          metadata: {
            orderId,
            againstId,
            disputeType,
            previousOrderStatus: order.status,
          },
        });

        return dispute;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ dispute: result });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE DISPUTE ERROR:');
      if (error.code === 'ORDER_STATE_CONFLICT') {
        return res.status(409).json({ error: 'This order changed status just now; please refresh and try again.' });
      }
      return res.status(500).json({ error: 'Could not create dispute' });
    }
  }
);

// ============================================================================
// LIST DISPUTES (admin)
// ============================================================================

router.get('/', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const disputes = await prisma.dispute.findMany({
      include: {
        order: {
          select: {
            id: true,
            status: true,
            buyerId: true,
            sellerId: true,
            transportJob: { select: { truckOwnerId: true } },
            inspectionRequests: { select: { inspectorId: true } },
          },
        },
        raisedBy: { select: { id: true, name: true, roles: true } },
        against: { select: { id: true, name: true, roles: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const participantRole = (user, order) => {
      if (!user) return null;
      if (user.id === order?.buyerId) return 'BUYER';
      if (user.id === order?.sellerId) return 'SELLER';
      if (order?.inspectionRequests?.some((r) => r.inspectorId === user.id)) return 'INSPECTOR';
      if (order?.transportJob?.truckOwnerId === user.id) return 'TRUCK_OWNER';
      return Array.isArray(user.roles) ? user.roles[0] || null : null;
    };

    return res.json({
      disputes: disputes.map((dispute) => ({
        ...dispute,
        raisedByRole: participantRole(dispute.raisedBy, dispute.order),
        againstRole: participantRole(dispute.against, dispute.order),
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, 'LIST DISPUTES ERROR:');
    return res.status(500).json({ error: 'Could not load disputes' });
  }
});

// ============================================================================
// RESOLVE DISPUTE (admin)
// ----------------------------------------------------------------------------
// Three resolutions, scoped to what the claim is actually about:
//   DISMISSED       – unfreeze everything, no cancellation, no refund.
//   CANCEL_SERVICE  – cancel only the disputed service (inspection or transport),
//                     refund its paid amount, keep the order alive, resume
//                     everything else. Goods disputes cannot use this.
//   CANCEL_ORDER    – cancel the entire order and refund every settled
//                     payment (previous behaviour).
//
// Which services CANCEL_SERVICE can affect is derived from dispute.againstId.
// If the dispute is against the inspector, only the inspection can be
// cancelled this way. If against the truck owner, only the transport.
// If against the buyer or seller, CANCEL_SERVICE is refused; the caller must
// choose CANCEL_ORDER (or DISMISSED).
// ============================================================================

router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const { resolutionType, resolution } = req.body;

    if (!['DISMISSED', 'CANCEL_SERVICE', 'CANCEL_ORDER'].includes(resolutionType)) {
      return res.status(400).json({ error: 'resolutionType must be DISMISSED, CANCEL_SERVICE, or CANCEL_ORDER' });
    }
    if (!resolution || typeof resolution !== 'string' || resolution.trim().length < 5 || resolution.trim().length > 5000) {
      return res.status(400).json({ error: 'resolution must be 5-5000 characters' });
    }
    if (findContactInfo(resolution)) {
      return res.status(400).json({ error: 'Resolution cannot contain contact information' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { id: req.params.id },
      });
      if (!dispute) throw Object.assign(new Error('Dispute not found'), { status: 404 });
      if (dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW') {
        throw Object.assign(new Error(`Dispute is already ${dispute.status}`), { status: 409 });
      }

      const order = await tx.order.findUnique({
        where: { id: dispute.orderId },
        include: {
          transportJob: true,
          inspectionRequests: true,
          payments: true,
          listing: true,
        },
      });
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'DISPUTED') {
        throw Object.assign(
          new Error(`Order is ${order.status}; the open dispute can no longer be resolved here`),
          { status: 409, code: 'ORDER_STATE_CONFLICT' }
        );
      }

      const againstId = dispute.againstId;
      const isAgainstBuyer = againstId === order.buyerId;
      const isAgainstSeller = againstId === order.sellerId;
      const isAgainstInspector = (order.inspectionRequests || []).some(
        (r) => r.inspectorId === againstId && r.status !== 'CANCELLED'
      );
      const isAgainstTransporter = order.transportJob?.truckOwnerId === againstId;

      const affectedService =
        isAgainstInspector ? 'INSPECTION' :
        isAgainstTransporter ? 'TRANSPORT' :
        'GOODS';

      if (resolutionType === 'CANCEL_SERVICE' && affectedService === 'GOODS') {
        throw Object.assign(
          new Error(
            'A goods dispute cannot be resolved by cancelling only one service. ' +
            'Use CANCEL_ORDER to cancel the whole order, or DISMISSED to resume without cancelling.'
          ),
          { status: 400, code: 'CANCEL_SERVICE_NOT_ALLOWED_FOR_GOODS' }
        );
      }

      const frozenPayout = await tx.payout.findFirst({
        where: { orderId: order.id, status: 'ON_HOLD_DISPUTE' },
        select: { id: true },
      });

      let refundIds = [];
      let restoredOrderStatus = null;
      let cancelledServiceIds = [];

      if (resolutionType === 'CANCEL_ORDER') {
        const cancelled = await cancelOrderInTransaction(tx, {
          order,
          actorId: req.user.id,
          reason: 'Dispute resolved: order cancelled and buyer refund requested',
          cancelledByRole: 'ADMIN',
        });
        const refunds = await tx.paymentRefund.findMany({
          where: { payment: { orderId: order.id } },
          select: { id: true },
        });
        refundIds = refunds.map((r) => r.id);
        restoredOrderStatus = cancelled.status;
      } else {
        // DISMISSED or CANCEL_SERVICE — the order stays alive.

        if (resolutionType === 'CANCEL_SERVICE') {
          if (affectedService === 'INSPECTION') {
            const inspections = (order.inspectionRequests || []).filter((r) => r.status !== 'CANCELLED');
            for (const insp of inspections) {
              const paidInspectorPayments = await tx.payment.findMany({
                where: { inspectionRequestId: insp.id, type: 'INSPECTOR', status: 'PAID' },
                select: { id: true },
              });
              for (const p of paidInspectorPayments) {
                const refund = await paymentService.requestRefund(tx, {
                  paymentId: p.id,
                  reason: 'Dispute resolved: inspection cancelled, fee refunded',
                  requestedById: req.user.id,
                });
                refundIds.push(refund.id);
              }

              await tx.inspectionRequest.update({
                where: { id: insp.id },
                data: {
                  inspectorId: null,
                  fee: null,
                  sellerConfirmedAt: null,
                  inspectorOnSiteConfirmedAt: null,
                  feeTermsLockedAt: null,
                  lockedFee: null,
                  lockedFeePayer: null,
                  lockedBuyerFeeAmount: null,
                  lockedSellerFeeAmount: null,
                  startDueAt: null,
                  completionDueAt: null,
                  startedAt: null,
                  status: 'CANCELLED',
                  acceptedReleaseCount: 0,
                },
              });

              await tx.inspectionQuote.updateMany({
                where: {
                  inspectionRequestId: insp.id,
                  status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
                },
                data: { status: 'EXPIRED' },
              });

              cancelledServiceIds.push(insp.id);
            }
          } else if (affectedService === 'TRANSPORT') {
            const job = order.transportJob;
            if (job && job.status !== 'CANCELLED') {
              const paidTransportPayments = await tx.payment.findMany({
                where: { transportJobId: job.id, type: 'TRANSPORT', status: 'PAID' },
                select: { id: true },
              });
              for (const p of paidTransportPayments) {
                const refund = await paymentService.requestRefund(tx, {
                  paymentId: p.id,
                  reason: 'Dispute resolved: transport cancelled, fee refunded',
                  requestedById: req.user.id,
                });
                refundIds.push(refund.id);
              }

              await tx.transportJob.update({
                where: { id: job.id },
                data: {
                  truckOwnerId: null,
                  truckId: null,
                  agreedAmount: null,
                  truckArrivedAt: null,
                  truckArrivedConfirmedBy: null,
                  sellerPickupConfirmedAt: null,
                  sellerPreparationDueAt: null,
                  buyerLoadingConfirmedAt: null,
                  buyerLoadingDueAt: null,
                  status: 'CANCELLED',
                  acceptedReleaseCount: 0,
                },
              });

              await tx.transportQuote.updateMany({
                where: {
                  transportJobId: job.id,
                  status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
                },
                data: { status: 'EXPIRED' },
              });

              cancelledServiceIds.push(job.id);
            }
          }
        }

        // Unfreeze the payouts that are not tied to the cancelled service.
        // Anything tied to a service in `cancelledServiceIds` is left to the
        // refund flow to cancel.
        await resumeAfterDispute(tx, {
          orderId: order.id,
          actorId: req.user.id,
          disputeType: dispute.disputeType,
          cancelledServiceIds,
        });

        restoredOrderStatus = dispute.previousOrderStatus || 'CONFIRMED';
        await transitionOrderStatus(tx, order.id, 'DISPUTED', restoredOrderStatus);

        // Replay any payments that settled while the dispute was open so
        // the workflow resumes correctly for services that stayed alive.
        const paidOrderPayments = await tx.payment.findMany({
          where: { orderId: order.id, status: 'PAID' },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        for (const paidPayment of paidOrderPayments) {
          await paymentService.replayDisputedPaidPayment(tx, paidPayment.id);
        }
      }

      const updated = await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: 'RESOLVED',
          resolution,
          resolutionType,
          resolutionAppliedAt: new Date(),
        },
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'DISPUTE_RESOLVED',
        resourceType: 'Dispute',
        resourceId: updated.id,
        metadata: {
          orderId: order.id,
          resolutionType,
          affectedService,
          restoredOrderStatus,
          refundIds,
          cancelledServiceIds,
          raisedAgainstId: againstId,
          hadFrozenPayouts: Boolean(frozenPayout),
        },
      });

      return updated;
    }, { maxWait: 10000, timeout: 20000 });

    return res.json({ dispute: result });
  } catch (error) {
    req.log.error({ err: error }, 'RESOLVE DISPUTE ERROR:');
    if (
      error.code === 'ORDER_STATE_CONFLICT' ||
      error.code === 'CANCEL_SERVICE_NOT_ALLOWED_FOR_GOODS' ||
      error.code === 'INVALID_ORDER_TRANSITION'
    ) {
      return res.status(error.status || 409).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Could not resolve dispute' });
  }
});

module.exports = router;
