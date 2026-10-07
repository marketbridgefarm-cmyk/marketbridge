'use strict';

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { cancelOrderInTransaction } = require('./orderCancellationService');
const { sendSms } = require('./smsService');
const { releaseDuePayouts } = require('./payoutService');
const { processRefund, verifyAndFinalizeRefund } = require('./paymentRefundService');
const logger = require('../utils/logger');

const { promoteNextWaitingBuyer } = require('./orderCancellationService');

const LOCK_KEY = 82461327;

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Run `fn` under an exclusive maintenance lock.
 *
 * Uses pg_try_advisory_xact_lock (transaction-scoped) rather than
 * pg_try_advisory_lock (session-scoped). The session-scoped variant is
 * released only by an explicit pg_advisory_unlock() call OR when the client
 * session ends. On Neon, a pooled session can linger after a crash, so the
 * session-scoped lock would remain held and every subsequent cycle returned
 * {skipped:true} — silently freezing all background work.
 *
 * The transaction-scoped lock is released automatically the instant the
 * transaction commits, rolls back, or errors, so a crashed cycle can never
 * strand it.
 *
 * The whole cycle runs inside this transaction, so nested per-item
 * transactions inside `fn` become savepoints — that is fine for the current
 * workload. If you ever need to run a job that cannot live inside a parent
 * transaction, break it out with its own prisma.$transaction (Prisma
 * promotes the outer one to a plain connection in that case, which would
 * invalidate the lock — do not do that without revisiting this helper).
 *
 * Diagnostic: logs pg_backend_pid() plus the gotLock result on every
 * attempt so the Render log makes it obvious whether one instance is
 * consistently winning (healthy) or two instances are racing / a stale
 * holder exists.
 */
async function withJobLock(fn) {
  const pid = (await prisma.$queryRaw`SELECT pg_backend_pid() AS pid`)?.[0]?.pid;
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
      logger.info({ pid, gotLock: rows?.[0]?.locked }, 'withJobLock attempt');
      if (!rows?.[0]?.locked) return { skipped: true };
      return fn();
    }, { maxWait: 10000, timeout: 120000 });
  } catch (error) {
    // Log and rethrow so startMaintenanceScheduler's catch can also record it.
    logger.error({ err: error, pid }, 'withJobLock transaction failed');
    throw error;
  }
}

async function expireOffers(now = new Date()) {
  const offers = await prisma.offer.findMany({
    where: { status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] }, expiresAt: { lte: now } },
    select: { id: true, listingId: true, status: true, expiresAt: true }, take: 500,
  });
  let expired = 0;
  for (const offer of offers) {
    const changed = await prisma.$transaction(async (tx) => {
      const updated = await tx.offer.updateMany({
        where: { id: offer.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] }, expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      if (updated.count !== 1) return false;
      await recordAuditEvent(tx, { actorId: null, action: 'OFFER_EXPIRED_AUTOMATICALLY', resourceType: 'Offer', resourceId: offer.id, metadata: { listingId: offer.listingId, previousStatus: offer.status, expiresAt: offer.expiresAt } });
      if (offer.status === 'SELECTED') await promoteNextWaitingBuyer(tx, offer.listingId, null);
      return true;
    }, { maxWait: 10000, timeout: 15000 });
    if (changed) expired += 1;
  }
  return { expired };
}

async function expireInspectionWorkflows(now = new Date()) {
  const candidates = await prisma.inspectionRequest.findMany({
    where: {
      OR: [
        { status: 'REQUESTED', workflowDueAt: { lte: now } },
        { status: 'ACCEPTED', startDueAt: { lte: now } },
        { status: 'IN_PROGRESS', completionDueAt: { lte: now } },
      ],
    },
    select: { id: true, orderId: true, status: true, workflowDueAt: true, startDueAt: true, completionDueAt: true }, take: 200,
  });
  let expired = 0;
  for (const candidate of candidates) {
    try {
      const changed = await prisma.$transaction(async (tx) => {
        const request = await tx.inspectionRequest.findUnique({ where: { id: candidate.id } });
        if (!request) return false;

        if (request.status === 'REQUESTED' && request.workflowDueAt && request.workflowDueAt <= now) {
          await tx.inspectionRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
          await tx.inspectionQuote.updateMany({ where: { inspectionRequestId: request.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } }, data: { status: 'EXPIRED' } });
          if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: null, type: 'INSPECTION_WORKFLOW_EXPIRED', fromStatus: 'REQUESTED', toStatus: 'CANCELLED', metadata: { inspectionRequestId: request.id, workflowDueAt: request.workflowDueAt.toISOString() } });
          await recordAuditEvent(tx, { actorId: null, action: 'INSPECTION_WORKFLOW_EXPIRED', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { orderId: request.orderId, workflowDueAt: request.workflowDueAt.toISOString() } });
          return true;
        }

        if (request.status === 'ACCEPTED' && request.startDueAt && request.startDueAt <= now) {
          await tx.inspectionRequest.update({ where: { id: request.id }, data: { status: 'STALLED', startDueAt: null } });
          if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: null, type: 'INSPECTION_STALLED', fromStatus: 'ACCEPTED', toStatus: 'STALLED', metadata: { inspectionRequestId: request.id, reason: 'Inspector did not start within the allowed window' } });
          await recordAuditEvent(tx, { actorId: null, action: 'INSPECTION_STALLED', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { orderId: request.orderId, phase: 'START' } });
          return true;
        }

        if (request.status === 'IN_PROGRESS' && request.completionDueAt && request.completionDueAt <= now) {
          await tx.inspectionRequest.update({ where: { id: request.id }, data: { status: 'STALLED', completionDueAt: null } });
          if (request.orderId) await recordOrderEvent(tx, { orderId: request.orderId, actorId: null, type: 'INSPECTION_STALLED', fromStatus: 'IN_PROGRESS', toStatus: 'STALLED', metadata: { inspectionRequestId: request.id, reason: 'Inspector did not complete the report within the allowed window' } });
          await recordAuditEvent(tx, { actorId: null, action: 'INSPECTION_STALLED', resourceType: 'InspectionRequest', resourceId: request.id, metadata: { orderId: request.orderId, phase: 'COMPLETION' } });
          return true;
        }
        return false;
      }, { maxWait: 10000, timeout: 15000 });
      if (changed) expired += 1;
    } catch (error) {
      logger.error({ err: error, inspectionRequestId: candidate.id }, 'Failed to maintain inspection workflow');
    }
  }
  return { expired, stalled: candidates.filter((c) => ['ACCEPTED', 'IN_PROGRESS'].includes(c.status)).length };
}

async function expireTransportWorkflows(now = new Date()) {
  const candidates = await prisma.transportJob.findMany({
    where: { status: { in: ['REQUESTED', 'QUOTED'] }, workflowDueAt: { lte: now } },
    select: { id: true, orderId: true, status: true, truckId: true, workflowDueAt: true }, take: 200,
  });
  let expired = 0;
  for (const candidate of candidates) {
    try {
      const changed = await prisma.$transaction(async (tx) => {
        const job = await tx.transportJob.findUnique({ where: { id: candidate.id } });
        if (!job || !['REQUESTED', 'QUOTED'].includes(job.status) || !job.workflowDueAt || job.workflowDueAt > now) return false;
        await tx.transportJob.update({ where: { id: job.id }, data: { status: 'CANCELLED', workflowDueAt: null } });
        await tx.transportQuote.updateMany({
          where: { transportJobId: job.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } },
          data: { status: 'EXPIRED' },
        });
        if (job.truckId) {
          await tx.truck.updateMany({ where: { id: job.truckId, availability: 'BUSY' }, data: { availability: 'AVAILABLE' } });
        }
        await recordOrderEvent(tx, {
          orderId: job.orderId, actorId: null, type: 'TRANSPORT_WORKFLOW_EXPIRED',
          fromStatus: job.status, toStatus: 'CANCELLED',
          metadata: { transportJobId: job.id, workflowDueAt: job.workflowDueAt.toISOString() },
        });
        await recordAuditEvent(tx, {
          actorId: null, action: 'TRANSPORT_WORKFLOW_EXPIRED', resourceType: 'TransportJob', resourceId: job.id,
          metadata: { orderId: job.orderId, workflowDueAt: job.workflowDueAt.toISOString() },
        });
        return true;
      }, { maxWait: 10000, timeout: 15000 });
      if (changed) expired += 1;
    } catch (error) {
      logger.error({ err: error, transportJobId: candidate.id }, 'Failed to expire transport workflow');
    }
  }
  return { expired };
}

async function expireListings(now = new Date()) {
  const candidates = await prisma.listing.findMany({
    where: { status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] }, category: 'AGRICULTURAL', pickupWindowEnd: { lte: now } },
    select: { id: true, pickupWindowEnd: true }, take: 500,
  });
  let expired = 0;
  for (const listing of candidates) {
    const result = await prisma.listing.updateMany({
      where: { id: listing.id, status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] }, pickupWindowEnd: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    if (result.count === 1) expired += 1;
  }
  return { expired };
}

async function expireAdvertisements(now = new Date()) {
  const result = await prisma.advertisement.updateMany({
    where: { status: { in: ['ACTIVE', 'PUBLISHED', 'SCHEDULED', 'APPROVED'] }, endDate: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}

async function activateScheduledAdvertisements(now = new Date()) {
  const result = await prisma.advertisement.updateMany({
    where: { status: 'SCHEDULED', startDate: { lte: now }, endDate: { gt: now } },
    data: { status: 'PUBLISHED', publishedAt: now },
  });
  return { activated: result.count };
}

async function expireUnpaidOrders(now = new Date()) {
  const candidates = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', paymentDueAt: { lte: now } },
    select: { id: true },
    take: 200,
  });

  let expired = 0;
  for (const candidate of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: candidate.id },
          include: { transportJob: true, payments: true },
        });

        if (!current || current.status !== 'PENDING_PAYMENT' || !current.paymentDueAt || current.paymentDueAt > now) {
          return;
        }

        if (current.payments.some((p) => p.status === 'PAID')) {
          logger.warn({ orderId: current.id }, 'Skipping auto-expire: order has a PAID payment despite PENDING_PAYMENT status');
          return;
        }

        await cancelOrderInTransaction(tx, {
          order: current,
          actorId: null,
          reason: 'Payment window expired without a completed payment',
          cancelledByRole: 'SYSTEM',
        });
      }, { maxWait: 10000, timeout: 15000 });
      expired += 1;
    } catch (error) {
      logger.error({ err: error, orderId: candidate.id }, 'Failed to auto-expire unpaid order');
    }
  }

  return { expired };
}

async function createPickupReminders(now = new Date()) {
  const until = hoursFromNow(24);
  const orders = await prisma.order.findMany({
    where: { status: { notIn: ['COMPLETED', 'CANCELLED'] }, listing: { category: 'AGRICULTURAL', pickupWindowStart: { gt: now, lte: until } } },
    select: { id: true, listing: { select: { pickupWindowStart: true } } }, take: 500,
  });
  let created = 0;
  for (const order of orders) {
    const dateKey = order.listing.pickupWindowStart.toISOString().slice(0, 10);
    const exists = await prisma.orderEvent.findFirst({
      where: { orderId: order.id, type: 'PICKUP_WINDOW_REMINDER', metadata: { path: ['dateKey'], equals: dateKey } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.$transaction(async (tx) => {
      await recordOrderEvent(tx, { orderId: order.id, actorId: null, type: 'PICKUP_WINDOW_REMINDER', metadata: { dateKey, pickupWindowStart: order.listing.pickupWindowStart.toISOString() } });
    }, { maxWait: 10000, timeout: 15000 });
    created += 1;
  }
  return { created };
}

const SMS_MAX_ATTEMPTS = 3;

async function sendPendingSms(now = new Date()) {
  const pending = await prisma.smsOutboxEntry.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let sent = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendSms({ to: entry.phone, body: entry.body });
      // eslint-disable-next-line no-await-in-loop
      await prisma.smsOutboxEntry.update({
        where: { id: entry.id },
        data: { status: 'SENT', sentAt: now },
      });
      sent += 1;
    } catch (error) {
      const attempts = entry.attempts + 1;
      const giveUp = attempts >= SMS_MAX_ATTEMPTS;
      // eslint-disable-next-line no-await-in-loop
      await prisma.smsOutboxEntry.update({
        where: { id: entry.id },
        data: {
          attempts,
          lastError: String(error.message || error).slice(0, 500),
          ...(giveUp ? { status: 'FAILED' } : {}),
        },
      });
      if (giveUp) failed += 1;
      logger.error({ err: error, outboxId: entry.id, attempts }, 'SMS send failed for outbox entry');
    }
  }

  return { sent, failed, remaining: pending.length - sent - failed };
}

async function submitRequestedRefunds() {
  const pending = await prisma.paymentRefund.findMany({
    where: { status: 'REQUESTED' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let submitted = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  for (const item of pending) {
    try {
      const refund = await processRefund({
        refundId: item.id,
        actorId: null,
        note: 'Automatically submitted by maintenance sweep',
      });
      submitted += 1;
      if (refund?.status === 'COMPLETED') completed += 1;
      else if (refund?.status === 'FAILED') failed += 1;
    } catch (error) {
      if (error?.code === 'REFUND_BLOCKED_ORDER_ACTIVE') blocked += 1;
      logger.error({ err: error, refundId: item.id }, 'Failed to submit requested refund');
    }
  }

  return { checked: pending.length, submitted, completed, failed, blocked };
}

async function syncProcessingRefunds() {
  const pending = await prisma.paymentRefund.findMany({
    where: { status: 'PROCESSING', providerRefundId: { not: null } },
    select: { id: true },
    take: 100,
  });

  let completed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const item of pending) {
    try {
      const { refund } = await verifyAndFinalizeRefund({ refundId: item.id, actorId: null, note: 'Reconciled by maintenance sweep' });
      if (refund?.status === 'COMPLETED') completed += 1;
      else if (refund?.status === 'FAILED') failed += 1;
      else stillPending += 1;
    } catch (error) {
      logger.error({ err: error, refundId: item.id }, 'Failed to sync refund status with provider');
    }
  }

  return { checked: pending.length, completed, failed, stillPending };
}

async function sweepStandings(now = new Date()) {
  const { sweepProviderStandings } = require('./providerStandingService');
  return sweepProviderStandings(prisma, now);
}

async function runMaintenanceCycle() {
  return withJobLock(async () => {
    const startedAt = Date.now();
    const now = new Date();
    const [offers, listings, ads, adsActivated, reminders, unpaidOrders, inspectionWorkflows, transportWorkflows, sms, payouts, requestedRefunds, refundSync, providerStandings] = await Promise.all([
      expireOffers(now), expireListings(now), expireAdvertisements(now), activateScheduledAdvertisements(now), createPickupReminders(now), expireUnpaidOrders(now), expireInspectionWorkflows(now), expireTransportWorkflows(now), sendPendingSms(now), releaseDuePayouts(prisma, now), submitRequestedRefunds(), syncProcessingRefunds(), sweepStandings(now),
    ]);
    return { durationMs: Date.now() - startedAt, offers, listings, ads, adsActivated, reminders, unpaidOrders, inspectionWorkflows, transportWorkflows, sms, payouts, requestedRefunds, refundSync, providerStandings };
  });
}

function startMaintenanceScheduler() {
  if (process.env.MARKETBRIDGE_JOBS_ENABLED === 'false') return null;
  const intervalMs = Math.max(Number(process.env.MARKETBRIDGE_JOB_INTERVAL_MS) || 60_000, 15_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { const result = await runMaintenanceCycle(); logger.info({ result }, 'maintenance cycle complete'); }
    catch (error) { logger.error({ err: error }, 'maintenance cycle failed'); }
    finally { running = false; }
  };
  void tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runMaintenanceCycle, startMaintenanceScheduler, expireOffers, expireListings, expireAdvertisements, activateScheduledAdvertisements, createPickupReminders, expireInspectionWorkflows, expireTransportWorkflows, expireUnpaidOrders, sendPendingSms, releaseDuePayouts, submitRequestedRefunds, syncProcessingRefunds };
