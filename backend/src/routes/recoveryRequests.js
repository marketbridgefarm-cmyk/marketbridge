'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { closeCoordination } = require('../services/inspectionCoordinationService');

const router = express.Router();

const TYPES = new Set(['INSPECTION', 'TRANSPORT']);
const TARGETS = new Set(['BUYER', 'SELLER']);

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
      disputes: { where: { status: 'RESOLVED' }, orderBy: { updatedAt: 'desc' }, take: 1, select: { updatedAt: true } },
      inspectionRequests: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: {
          id: true, status: true, inspectorId: true, updatedAt: true,
          quotes: { select: { inspectorId: true, status: true, updatedAt: true } },
          payments: { where: { type: 'INSPECTOR', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true } },
        },
      },
      transportJob: {
        select: {
          id: true, status: true, truckOwnerId: true, updatedAt: true,
          quotes: { select: { truckOwnerId: true, status: true, updatedAt: true } },
          payments: { where: { type: 'TRANSPORT', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true } },
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

  if (!order) return { INSPECTION: false, TRANSPORT: false };

  const latestApproved = (type) => order.recoveryRequests.find((r) => r.type === type)?.formReleasedAt || null;
  // Dispute resolution updates the Dispute row; it does not currently create
  // an OrderEvent, so eligibility must read the authoritative dispute record.
  const disputeResolvedAt = order.disputes[0]?.updatedAt || null;
  const inspection = order.inspectionRequests[0] || null;
  const transport = order.transportJob;

  // A provider withdrawal is a recovery trigger only when it affects the
  // assigned provider, or when every bid in the competition has become unusable.
  // A random losing bidder withdrawing must not reset a live competition.
  const latestInspectionWithdrawal = inspection?.quotes
    .filter((q) => q.status === 'WITHDRAWN' && (!inspection.inspectorId || q.inspectorId === inspection.inspectorId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
  const inspectionHasLiveBid = Boolean(inspection?.quotes.some((q) => ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)));
  const inspectionWithdrawalAt = latestInspectionWithdrawal && (!inspectionHasLiveBid || latestInspectionWithdrawal.inspectorId === inspection?.inspectorId)
    ? latestInspectionWithdrawal.updatedAt : null;

  const latestTransportWithdrawal = transport?.quotes
    .filter((q) => q.status === 'WITHDRAWN' && (!transport.truckOwnerId || q.truckOwnerId === transport.truckOwnerId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
  const transportHasLiveBid = Boolean(transport?.quotes.some((q) => ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)));
  const transportWithdrawalAt = latestTransportWithdrawal && (!transportHasLiveBid || latestTransportWithdrawal.truckOwnerId === transport?.truckOwnerId)
    ? latestTransportWithdrawal.updatedAt : null;

  const inspectionTriggerAt = [
    ['CANCELLED', 'STALLED'].includes(inspection?.status) ? inspection.updatedAt : null,
    inspectionWithdrawalAt,
    disputeResolvedAt,
  ].filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  const transportTriggerAt = [
    transport?.status === 'CANCELLED' ? transport.updatedAt : null,
    transportWithdrawalAt,
    disputeResolvedAt,
  ].filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

  const eligible = (triggerAt, releasedAt, hasUnresolvedServicePayment) => Boolean(
    triggerAt && !hasUnresolvedServicePayment && (!releasedAt || new Date(triggerAt) > new Date(releasedAt))
  );

  // NOTE: Eligibility deliberately does NOT consider InspectionCoordination.
  // A legitimate recovery trigger is a dead competition, a withdrawn
  // assigned provider, or a resolved dispute — never "coordination is
  // incomplete". Coordination is closed as a side-effect of admin approval
  // (see the inspection branch of PATCH /admin/:id/approve), not evaluated
  // here.
  return {
    INSPECTION: eligible(inspectionTriggerAt, latestApproved('INSPECTION'), Boolean(inspection?.payments?.length)),
    TRANSPORT: eligible(transportTriggerAt, latestApproved('TRANSPORT'), Boolean(transport?.payments?.length)),
  };
}

router.use(authenticate);

// Buyer/seller asks MarketBridge admin to release a fresh workflow form.
router.post('/', async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    const type = String(req.body?.type || '').toUpperCase();
    const targetParties = normalizeTargets(req.body?.targetParties);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : null;

    if (!orderId || !TYPES.has(type)) return res.status(400).json({ error: 'orderId and a valid recovery type are required' });
    if (!targetParties.length) return res.status(400).json({ error: 'At least one requested party is required' });

    const order = await getOrderForParticipant(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!participant(order, req.user.id)) return res.status(403).json({ error: 'Only the buyer or seller can request workflow recovery' });
    if (['CANCELLED', 'COMPLETED'].includes(order.status)) return res.status(409).json({ error: 'Recovery is not available for a closed order' });

    const eligibility = await getRecoveryEligibility(orderId);
    if (!eligibility[type]) {
      return res.status(409).json({ error: `Admin recovery is only available after a genuine ${type.toLowerCase()} cancellation, provider withdrawal, or resolved dispute.` });
    }

    const existing = await prisma.recoveryRequest.findFirst({
      where: { orderId, type, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) return res.json({ message: 'A recovery request is already awaiting admin review', recoveryRequest: existing });

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

    return res.status(201).json({ message: 'Recovery request sent to MarketBridge admin for approval', recoveryRequest: created });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST CREATE ERROR');
    return res.status(500).json({ error: 'Could not submit recovery request' });
  }
});

router.get('/order/:orderId', async (req, res) => {
  try {
    const order = await getOrderForParticipant(req.params.orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!participant(order, req.user.id)) return res.status(403).json({ error: 'Only the buyer or seller can view workflow recovery requests' });

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
      order: { select: { id: true, status: true, buyer: { select: { id: true, name: true, email: true } }, seller: { select: { id: true, name: true, email: true } }, listing: { select: { id: true, title: true, cropType: true } } } },
      requestedBy: { select: { id: true, name: true, email: true } },
    },
  });
  return res.json({ recoveryRequests });
});

router.patch('/admin/:id/approve', requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.recoveryRequest.findUnique({ where: { id: req.params.id }, include: { order: true } });
      if (!request) throw Object.assign(new Error('Recovery request not found'), { statusCode: 404 });
      if (request.status !== 'PENDING') throw Object.assign(new Error('This recovery request has already been decided'), { statusCode: 409 });
      if (['CANCELLED', 'COMPLETED'].includes(request.order.status)) throw Object.assign(new Error('This order is closed and cannot be recovered'), { statusCode: 409 });

      const now = new Date();
      if (request.type === 'INSPECTION') {
        const current = await tx.inspectionRequest.findFirst({ where: { orderId: request.orderId }, orderBy: { createdAt: 'desc' } });
        if (current) {
          const activePayment = await tx.payment.findFirst({ where: { inspectionRequestId: current.id, type: 'INSPECTOR', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true } });
          if (activePayment) throw Object.assign(new Error('Inspection recovery is blocked because inspection payment has already started'), { statusCode: 409 });
          if (['REQUESTED', 'ACCEPTED', 'STALLED'].includes(current.status)) {
            await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: current.id, inspectorId: current.inspectorId, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
            await tx.inspectionRequest.update({ where: { id: current.id }, data: { inspectorId: null, fee: null, buyerFeeAmount: null, sellerFeeAmount: null, sellerConfirmedAt: null, startDueAt: null, completionDueAt: null, startedAt: null, status: 'REQUESTED' } });
            // Close coordination so the next inspector does not inherit the
            // previous inspector's phone, availability, or site notes.
            await closeCoordination(tx, current.id, 'ADMIN_RECOVERY_APPROVED');
          } else if (current.status === 'CANCELLED') {
            const requestedById = request.targetParties?.includes('BUYER') ? request.order.buyerId : request.targetParties?.includes('SELLER') ? request.order.sellerId : request.requestedById;
            const recreated = await tx.inspectionRequest.create({
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
            // The recreated request carries a fresh id; close any coordination
            // row left on the old cancelled request so the historical record
            // is marked closed and cannot resurface. The new request opens a
            // fresh coordination row only when its own quote is accepted.
            await closeCoordination(tx, current.id, 'ADMIN_RECOVERY_RECREATED');
            // `recreated` intentionally has no coordination row at this point.
          }
        }
      } else {
        const job = await tx.transportJob.findUnique({ where: { orderId: request.orderId } });
        if (job) {
          const activePayment = await tx.payment.findFirst({ where: { transportJobId: job.id, type: 'TRANSPORT', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true } });
          if (activePayment) throw Object.assign(new Error('Transport recovery is blocked because transport payment has already started'), { statusCode: 409 });
          await tx.transportQuote.updateMany({ where: { transportJobId: job.id, truckOwnerId: job.truckOwnerId, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
          await tx.transportJob.update({ where: { id: job.id }, data: { truckOwnerId: null, truckId: null, agreedAmount: null, status: 'REQUESTED' } });
        }
      }

      const updated = await tx.recoveryRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: now, formReleasedAt: now, adminNote: typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim().slice(0, 1000) : null } });
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_APPROVED',
        metadata: { recoveryRequestId: request.id, recoveryType: request.type, targetParties: request.targetParties, formReleasedAt: now.toISOString() },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'WORKFLOW_RECOVERY_APPROVED', resourceType: 'RecoveryRequest', resourceId: request.id, metadata: { orderId: request.orderId, type: request.type, targetParties: request.targetParties } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });

    return res.json({ message: 'Recovery approved. A fresh requesting form has been released.', recoveryRequest: result, formReleased: true });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST APPROVE ERROR');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not approve recovery request' });
  }
});

router.patch('/admin/:id/reject', requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const request = await tx.recoveryRequest.findUnique({ where: { id: req.params.id } });
      if (!request || request.status !== 'PENDING') return null;
      const result = await tx.recoveryRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', rejectedAt: new Date(), adminNote: typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim().slice(0, 1000) : null } });
      await recordOrderEvent(tx, { orderId: request.orderId, actorId: req.user.id, type: 'WORKFLOW_RECOVERY_REJECTED', metadata: { recoveryRequestId: request.id, recoveryType: request.type, adminNote: req.body?.adminNote || null } });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'WORKFLOW_RECOVERY_REJECTED', resourceType: 'RecoveryRequest', resourceId: req.params.id, metadata: { orderId: request.orderId, adminNote: req.body?.adminNote || null } });
      return result;
    });
    if (!updated) return res.status(404).json({ error: 'Pending recovery request not found' });
    return res.json({ message: 'Recovery request rejected' });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST REJECT ERROR');
    return res.status(500).json({ error: 'Could not reject recovery request' });
  }
});

module.exports = router;
