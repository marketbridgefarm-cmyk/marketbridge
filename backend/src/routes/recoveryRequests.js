'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { closeCoordination } = require('../services/inspectionCoordinationService');
const {
  noticeInspectionWaitingUnlocked,
  noticeTransportWaitingUnlocked,
} = require('../services/waitingListService');

const router = express.Router();

// Recovery types: OFFER (product/agricultural listings with no live bids),
// INSPECTION (dead or bidder-less inspection competition),
// TRANSPORT (dead or bidder-less transport job).
const TYPES = new Set(['INSPECTION', 'TRANSPORT', 'OFFER']);
const TARGETS = new Set(['BUYER', 'SELLER']);

// A request must be idle this long (no live bidders, no progress) before
// the "no bidders" trigger fires. Set RECOVERY_NO_BIDDER_GRACE_HOURS=0 to
// allow the button to appear immediately.
const NO_BIDDER_GRACE_HOURS = (() => {
  const configured = Number(process.env.RECOVERY_NO_BIDDER_GRACE_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

function olderThan(ts, hours) {
  if (!ts) return false;
  const ms = Date.now() - new Date(ts).getTime();
  return ms >= hours * 60 * 60 * 1000;
}

// A service payment that is PENDING or PROCESSING means an active attempt
// is in flight. A PAID payment is settled money — it does not block
// recovery; the refund flow handles returning it separately.
function hasUnresolvedServicePayment(payments) {
  return Boolean(
    Array.isArray(payments) &&
      payments.some((p) => ['PENDING', 'PROCESSING'].includes(p.status))
  );
}

function normalizeTargets(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : ['BUYER', 'SELLER'];
  return [...new Set(raw.map((v) => String(v || '').toUpperCase()).filter((v) => TARGETS.has(v)))];
}

async function getOrderForParticipant(orderId, userId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, buyerId: true, sellerId: true, status: true },
  });
}

function participant(order, userId) {
  return Boolean(order && (order.buyerId === userId || order.sellerId === userId));
}

async function getRecoveryEligibility(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      listingId: true,
      agreedOfferId: true,
      disputes: {
        where: { status: 'RESOLVED' },
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: { updatedAt: true },
      },
      inspectionRequests: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          inspectorId: true,
          createdAt: true,
          updatedAt: true,
          quotes: { select: { inspectorId: true, status: true, updatedAt: true } },
          payments: {
            where: { type: 'INSPECTOR', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } },
            select: { id: true, status: true },
          },
        },
      },
      transportJob: {
        select: {
          id: true,
          status: true,
          truckOwnerId: true,
          createdAt: true,
          updatedAt: true,
          quotes: { select: { truckOwnerId: true, status: true, updatedAt: true } },
          payments: {
            where: { type: 'TRANSPORT', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } },
            select: { id: true, status: true },
          },
        },
      },
      recoveryRequests: {
        where: { status: 'APPROVED' },
        orderBy: { formReleasedAt: 'desc' },
        take: 10,
        select: { type: true, formReleasedAt: true },
      },
    },
  });

  if (!order) return { INSPECTION: false, TRANSPORT: false, OFFER: false };

  const latestApproved = (type) =>
    order.recoveryRequests.find((r) => r.type === type)?.formReleasedAt || null;
  const disputeResolvedAt = order.disputes[0]?.updatedAt || null;
  const inspection = order.inspectionRequests[0] || null;
  const transport = order.transportJob;

  // ---------------------------------------------------------------------------
  // INSPECTION
  // ---------------------------------------------------------------------------
  const latestInspectionWithdrawal =
    inspection?.quotes
      .filter(
        (q) =>
          q.status === 'WITHDRAWN' &&
          (!inspection.inspectorId || q.inspectorId === inspection.inspectorId)
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ||
    null;

  const inspectionHasLiveBid = Boolean(
    inspection?.quotes.some((q) =>
      ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
    )
  );

  const inspectionWithdrawalAt =
    latestInspectionWithdrawal &&
    (!inspectionHasLiveBid ||
      latestInspectionWithdrawal.inspectorId === inspection?.inspectorId)
      ? latestInspectionWithdrawal.updatedAt
      : null;

  // No-live-bidder trigger. The request is still open (accepted / in progress
  // still counts as open because new inspectors may join the waiting list),
  // nobody is on the waiting list, and enough time has passed that the
  // requester is genuinely stuck.
  const inspectionNoBidderTrigger =
    inspection &&
    ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'].includes(inspection.status) &&
    !inspectionHasLiveBid &&
    olderThan(inspection.createdAt || inspection.updatedAt, NO_BIDDER_GRACE_HOURS);

  const inspectionTriggerAt =
    [
      ['CANCELLED', 'STALLED'].includes(inspection?.status) ? inspection.updatedAt : null,
      inspectionWithdrawalAt,
      disputeResolvedAt,
      inspectionNoBidderTrigger ? new Date() : null,
    ]
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

  // ---------------------------------------------------------------------------
  // TRANSPORT
  // ---------------------------------------------------------------------------
  const latestTransportWithdrawal =
    transport?.quotes
      .filter(
        (q) =>
          q.status === 'WITHDRAWN' &&
          (!transport.truckOwnerId || q.truckOwnerId === transport.truckOwnerId)
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ||
    null;

  const transportHasLiveBid = Boolean(
    transport?.quotes.some((q) =>
      ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
    )
  );

  const transportWithdrawalAt =
    latestTransportWithdrawal &&
    (!transportHasLiveBid ||
      latestTransportWithdrawal.truckOwnerId === transport?.truckOwnerId)
      ? latestTransportWithdrawal.updatedAt
      : null;

  const transportNoBidderTrigger =
    transport &&
    ['REQUESTED', 'QUOTED'].includes(transport.status) &&
    !transportHasLiveBid &&
    olderThan(transport.createdAt || transport.updatedAt, NO_BIDDER_GRACE_HOURS);

  const transportTriggerAt =
    [
      transport?.status === 'CANCELLED' ? transport.updatedAt : null,
      transportWithdrawalAt,
      disputeResolvedAt,
      transportNoBidderTrigger ? new Date() : null,
    ]
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

  // ---------------------------------------------------------------------------
  // OFFER (listing-level bidding)
  // ---------------------------------------------------------------------------
  // OFFER recovery is only meaningful when the listing has no live offer
  // leaves and no agreed order yet. It is used when a buyer/seller wants a
  // fresh bidding round on a stalled listing competition.
  const listing = await prisma.listing.findUnique({
    where: { id: order.listingId },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      offers: {
        where: { childOffers: { none: {} } },
        select: { id: true, status: true, updatedAt: true },
      },
    },
  });

  const offerHasLiveLeaf = Boolean(
    listing?.offers.some((o) =>
      ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(o.status)
    )
  );

  const offerNoBidderTrigger =
    listing &&
    listing.status === 'ACTIVE' &&
    !offerHasLiveLeaf &&
    olderThan(listing.updatedAt, NO_BIDDER_GRACE_HOURS);

  const offerEligible = Boolean(
    !order.agreedOfferId &&
      !['COMPLETED', 'CANCELLED'].includes(order.status) &&
      (offerNoBidderTrigger ||
        !latestApproved('OFFER') ||
        (disputeResolvedAt && new Date(disputeResolvedAt) > new Date(latestApproved('OFFER') || 0)))
  );

  // ---------------------------------------------------------------------------
  // Final: gate each channel by trigger AND by "no in-flight payment".
  // ---------------------------------------------------------------------------
  const eligible = (triggerAt, releasedAt, hasPendingPayment) =>
    Boolean(
      triggerAt &&
        !hasPendingPayment &&
        (!releasedAt || new Date(triggerAt) > new Date(releasedAt))
    );

  return {
    INSPECTION: eligible(
      inspectionTriggerAt,
      latestApproved('INSPECTION'),
      hasUnresolvedServicePayment(inspection?.payments)
    ),
    TRANSPORT: eligible(
      transportTriggerAt,
      latestApproved('TRANSPORT'),
      hasUnresolvedServicePayment(transport?.payments)
    ),
    OFFER: offerEligible,
  };
}

router.use(authenticate);

// Buyer/seller asks MarketBridge admin to release a fresh workflow form.
router.post('/', async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    const type = String(req.body?.type || '').toUpperCase();
    const targetParties = normalizeTargets(req.body?.targetParties);
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : null;

    if (!orderId || !TYPES.has(type)) {
      return res.status(400).json({ error: 'orderId and a valid recovery type are required' });
    }
    if (!targetParties.length) {
      return res.status(400).json({ error: 'At least one requested party is required' });
    }

    const order = await getOrderForParticipant(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!participant(order, req.user.id)) {
      return res.status(403).json({ error: 'Only the buyer or seller can request workflow recovery' });
    }
    if (['CANCELLED', 'COMPLETED'].includes(order.status)) {
      return res.status(409).json({ error: 'Recovery is not available for a closed order' });
    }

    const eligibility = await getRecoveryEligibility(orderId);
    if (!eligibility[type]) {
      return res.status(409).json({
        error: `Admin recovery is only available when the ${type.toLowerCase()} competition has no live bidders, was cancelled, was withdrawn by its provider, or ended in a resolved dispute.`,
      });
    }

    const existing = await prisma.recoveryRequest.findFirst({
      where: { orderId, type, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) {
      return res.json({
        message: 'A recovery request is already awaiting admin review',
        recoveryRequest: existing,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const recoveryRequest = await tx.recoveryRequest.create({
        data: { orderId, requestedById: req.user.id, type, targetParties, reason },
      });
      await recordOrderEvent(tx, {
        orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_REQUESTED',
        metadata: { recoveryRequestId: recoveryRequest.id, recoveryType: type, targetParties, reason },
      });
      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'WORKFLOW_RECOVERY_REQUESTED',
        resourceType: 'RecoveryRequest',
        resourceId: recoveryRequest.id,
        metadata: { orderId, type, targetParties },
      });
      return recoveryRequest;
    });

    return res.status(201).json({
      message: 'Recovery request sent to MarketBridge admin for approval',
      recoveryRequest: created,
    });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST CREATE ERROR');
    return res.status(500).json({ error: 'Could not submit recovery request' });
  }
});

router.get('/order/:orderId', async (req, res) => {
  try {
    const order = await getOrderForParticipant(req.params.orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!participant(order, req.user.id)) {
      return res.status(403).json({ error: 'Only the buyer or seller can view workflow recovery requests' });
    }

    const recoveryRequests = await prisma.recoveryRequest.findMany({
      where: { orderId: order.id },
      orderBy: { requestedAt: 'desc' },
      take: 20,
    });
    const eligibility = await getRecoveryEligibility(order.id);
    return res.json({ recoveryRequests, eligibility });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST LOAD ERROR');
    return res.status(500).json({ error: 'Could not load recovery requests' });
  }
});

// Admin queue.
router.get('/admin/pending', requireRole('ADMIN'), requireMfa(), async (req, res) => {
  const recoveryRequests = await prisma.recoveryRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
    include: {
      order: {
        select: {
          id: true,
          status: true,
          buyer: { select: { id: true, name: true, email: true } },
          seller: { select: { id: true, name: true, email: true } },
          listing: { select: { id: true, title: true, cropType: true } },
        },
      },
      requestedBy: { select: { id: true, name: true, email: true } },
    },
  });
  return res.json({ recoveryRequests });
});

router.patch('/admin/:id/approve', requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.recoveryRequest.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });
      if (!request) throw Object.assign(new Error('Recovery request not found'), { statusCode: 404 });
      if (request.status !== 'PENDING') {
        throw Object.assign(new Error('This recovery request has already been decided'), { statusCode: 409 });
      }
      if (['CANCELLED', 'COMPLETED'].includes(request.order.status)) {
        throw Object.assign(new Error('This order is closed and cannot be recovered'), { statusCode: 409 });
      }

      const now = new Date();

      if (request.type === 'OFFER') {
        // Reset the listing's offer competition: expire every live leaf
        // offer and reopen the listing. A pending provisional order blocks
        // OFFER recovery because cancelling it is a separate decision.
        const provisionalOrder = await tx.order.findFirst({
          where: {
            listingId: request.order.listingId,
            status: { notIn: ['CANCELLED', 'COMPLETED', 'DISPUTED'] },
          },
          select: { id: true, status: true },
        });
        if (provisionalOrder) {
          throw Object.assign(
            new Error('Offer recovery is blocked: this listing still has an active provisional order. Cancel or release that order first.'),
            { statusCode: 409 }
          );
        }

        await tx.offer.updateMany({
          where: {
            listingId: request.order.listingId,
            status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
          },
          data: { status: 'EXPIRED' },
        });

        await tx.listing.update({
          where: { id: request.order.listingId },
          data: { status: 'ACTIVE' },
        });
      } else if (request.type === 'INSPECTION') {
        const current = await tx.inspectionRequest.findFirst({
          where: { orderId: request.orderId },
          orderBy: { createdAt: 'desc' },
        });
        if (current) {
          const activePayment = await tx.payment.findFirst({
            where: {
              inspectionRequestId: current.id,
              type: 'INSPECTOR',
              status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
            },
            select: { id: true },
          });
          if (activePayment) {
            throw Object.assign(
              new Error('Inspection recovery is blocked because inspection payment has already started'),
              { statusCode: 409 }
            );
          }
          if (['REQUESTED', 'ACCEPTED', 'STALLED'].includes(current.status)) {
            await tx.inspectionQuote.updateMany({
              where: {
                inspectionRequestId: current.id,
                inspectorId: current.inspectorId,
                status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
              },
              data: { status: 'EXPIRED' },
            });
            await tx.inspectionRequest.update({
              where: { id: current.id },
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
                startDueAt: null,
                completionDueAt: null,
                startedAt: null,
                status: 'REQUESTED',
                acceptedReleaseCount: 0,
              },
            });
            await closeCoordination(tx, current.id, 'ADMIN_RECOVERY_APPROVED');
          } else if (current.status === 'CANCELLED') {
            const requestedById = request.targetParties?.includes('BUYER')
              ? request.order.buyerId
              : request.targetParties?.includes('SELLER')
              ? request.order.sellerId
              : request.requestedById;
            await tx.inspectionRequest.create({
              data: {
                orderId: request.orderId,
                listingId: current.listingId,
                requestedById,
                mode: current.mode,
                feePayer: current.feePayer,
                location: current.location,
                status: 'REQUESTED',
              },
            });
            await closeCoordination(tx, current.id, 'ADMIN_RECOVERY_RECREATED');
          }
        }
      } else {
        const job = await tx.transportJob.findUnique({ where: { orderId: request.orderId } });
        if (job) {
          const activePayment = await tx.payment.findFirst({
            where: {
              transportJobId: job.id,
              type: 'TRANSPORT',
              status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
            },
            select: { id: true },
          });
          if (activePayment) {
            throw Object.assign(
              new Error('Transport recovery is blocked because transport payment has already started'),
              { statusCode: 409 }
            );
          }
          if (job.truckOwnerId) {
            await tx.transportQuote.updateMany({
              where: {
                transportJobId: job.id,
                truckOwnerId: job.truckOwnerId,
                status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
              },
              data: { status: 'EXPIRED' },
            });
          }
          await tx.transportJob.update({
            where: { id: job.id },
            data: {
              truckOwnerId: null,
              truckId: null,
              agreedAmount: null,
              status: 'REQUESTED',
              acceptedReleaseCount: 0,
            },
          });
        }
      }

      const updated = await tx.recoveryRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          approvedById: req.user.id,
          approvedAt: now,
          formReleasedAt: now,
          adminNote:
            typeof req.body?.adminNote === 'string'
              ? req.body.adminNote.trim().slice(0, 1000)
              : null,
        },
      });

      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_APPROVED',
        metadata: {
          recoveryRequestId: request.id,
          recoveryType: request.type,
          targetParties: request.targetParties,
          formReleasedAt: now.toISOString(),
        },
      });
      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'WORKFLOW_RECOVERY_APPROVED',
        resourceType: 'RecoveryRequest',
        resourceId: request.id,
        metadata: { orderId: request.orderId, type: request.type, targetParties: request.targetParties },
      });

      return updated;
    }, { maxWait: 10000, timeout: 15000 });

    // Best-effort unlock notices, after the transaction has committed.
    if (result.type === 'INSPECTION') {
      const inspection = await prisma.inspectionRequest.findFirst({
        where: { orderId: result.orderId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (inspection) {
        await noticeInspectionWaitingUnlocked(prisma, {
          inspectionRequestId: inspection.id,
          reason: 'ADMIN_RECOVERY_APPROVED',
        }).catch(() => {});
      }
    } else if (result.type === 'TRANSPORT') {
      const job = await prisma.transportJob.findUnique({
        where: { orderId: result.orderId },
        select: { id: true },
      });
      if (job) {
        await noticeTransportWaitingUnlocked(prisma, {
          transportJobId: job.id,
          reason: 'ADMIN_RECOVERY_APPROVED',
        }).catch(() => {});
      }
    }
    // OFFER recovery has no waiting-list notice table; the listing simply
    // reopens and any buyers can bid again.

    return res.json({
      message: 'Recovery approved. A fresh requesting form has been released.',
      recoveryRequest: result,
      formReleased: true,
    });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST APPROVE ERROR');
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || 'Could not approve recovery request' });
  }
});

router.patch('/admin/:id/reject', requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const request = await tx.recoveryRequest.findUnique({ where: { id: req.params.id } });
      if (!request) throw Object.assign(new Error('Recovery request not found'), { statusCode: 404 });
      if (request.status !== 'PENDING') {
        throw Object.assign(new Error('This recovery request has already been decided'), { statusCode: 409 });
      }

      const result = await tx.recoveryRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          adminNote:
            typeof req.body?.adminNote === 'string'
              ? req.body.adminNote.trim().slice(0, 1000)
              : null,
        },
      });
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_REJECTED',
        metadata: {
          recoveryRequestId: request.id,
          recoveryType: request.type,
          adminNote: req.body?.adminNote || null,
        },
      });
      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'WORKFLOW_RECOVERY_REJECTED',
        resourceType: 'RecoveryRequest',
        resourceId: req.params.id,
        metadata: { orderId: request.orderId, adminNote: req.body?.adminNote || null },
      });
      return result;
    });
    if (!updated) return res.status(404).json({ error: 'Pending recovery request not found' });
    return res.json({ message: 'Recovery request rejected' });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST REJECT ERROR');
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || 'Could not reject recovery request' });
  }
});

module.exports = router;
