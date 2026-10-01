'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');

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

    const existing = await prisma.recoveryRequest.findFirst({
      where: { orderId, type, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) return res.json({ message: 'A recovery request is already awaiting admin review', recoveryRequest: existing });

    const created = await prisma.recoveryRequest.create({
      data: { orderId, requestedById: req.user.id, type, targetParties, reason },
    });
    await recordAuditEvent(prisma, {
      actorId: req.user.id,
      action: 'WORKFLOW_RECOVERY_REQUESTED',
      resourceType: 'RecoveryRequest',
      resourceId: created.id,
      metadata: { orderId, type, targetParties },
    });
    await recordOrderEvent(prisma, {
      orderId,
      actorId: req.user.id,
      type: 'WORKFLOW_RECOVERY_REQUESTED',
      metadata: { recoveryRequestId: created.id, recoveryType: type, targetParties, requestedById: req.user.id },
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
    return res.json({ recoveryRequests });
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
          if (['REQUESTED', 'ACCEPTED'].includes(current.status)) {
            await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: current.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
            await tx.inspectionRequest.update({ where: { id: current.id }, data: { inspectorId: null, fee: null, status: 'REQUESTED' } });
          }
        }
      } else {
        const job = await tx.transportJob.findUnique({ where: { orderId: request.orderId } });
        if (job) {
          const activePayment = await tx.payment.findFirst({ where: { transportJobId: job.id, type: 'TRANSPORT', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true } });
          if (activePayment) throw Object.assign(new Error('Transport recovery is blocked because transport payment has already started'), { statusCode: 409 });
          await tx.transportQuote.updateMany({ where: { transportJobId: job.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
          await tx.transportJob.update({ where: { id: job.id }, data: { truckOwnerId: null, truckId: null, agreedAmount: null, status: 'REQUESTED' } });
        }
      }

      const updated = await tx.recoveryRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: now, formReleasedAt: now, adminNote: typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim().slice(0, 1000) : null } });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'WORKFLOW_RECOVERY_APPROVED', resourceType: 'RecoveryRequest', resourceId: request.id, metadata: { orderId: request.orderId, type: request.type, targetParties: request.targetParties } });
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_APPROVED',
        metadata: { recoveryRequestId: request.id, recoveryType: request.type, targetParties: request.targetParties, requestedById: request.requestedById },
      });
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
    const updated = await prisma.recoveryRequest.updateMany({ where: { id: req.params.id, status: 'PENDING' }, data: { status: 'REJECTED', rejectedAt: new Date(), adminNote: typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim().slice(0, 1000) : null } });
    if (!updated.count) return res.status(404).json({ error: 'Pending recovery request not found' });
    const rejected = await prisma.recoveryRequest.findUnique({ where: { id: req.params.id }, select: { orderId: true, requestedById: true, type: true } });
    await recordAuditEvent(prisma, { actorId: req.user.id, action: 'WORKFLOW_RECOVERY_REJECTED', resourceType: 'RecoveryRequest', resourceId: req.params.id, metadata: { adminNote: req.body?.adminNote || null } });
    if (rejected) {
      await recordOrderEvent(prisma, {
        orderId: rejected.orderId,
        actorId: req.user.id,
        type: 'WORKFLOW_RECOVERY_REJECTED',
        metadata: { recoveryRequestId: req.params.id, recoveryType: rejected.type, requestedById: rejected.requestedById, adminNote: req.body?.adminNote || null },
      });
    }
    return res.json({ message: 'Recovery request rejected' });
  } catch (error) {
    req.log.error({ err: error }, 'RECOVERY REQUEST REJECT ERROR');
    return res.status(500).json({ error: 'Could not reject recovery request' });
  }
});

module.exports = router;
