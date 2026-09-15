'use strict';

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { cancelOrderInTransaction } = require('./orderCancellationService');
const { sendSms } = require('./smsService');

const LOCK_KEY = 82461327;

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function withJobLock(fn) {
  const rows = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
  if (!rows?.[0]?.locked) return { skipped: true };
  try { return await fn(); } finally { await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`; }
}

async function expireOffers(now = new Date()) {
  const offers = await prisma.offer.findMany({
    where: { status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lte: now } },
    select: { id: true, listingId: true, status: true, expiresAt: true }, take: 500,
  });
  let expired = 0;
  for (const offer of offers) {
    const changed = await prisma.$transaction(async (tx) => {
      const updated = await tx.offer.updateMany({
        where: { id: offer.id, status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      if (updated.count !== 1) return false;
      await recordAuditEvent(tx, { actorId: null, action: 'OFFER_EXPIRED_AUTOMATICALLY', resourceType: 'Offer', resourceId: offer.id, metadata: { listingId: offer.listingId, expiresAt: offer.expiresAt } });
      return true;
    });
    if (changed) expired += 1;
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

/**
 * Automatic inventory release for abandoned orders. An order sits in
 * PENDING_PAYMENT the moment it's created — via buy-now or offer
 * acceptance — with the sold quantity already deducted from the listing
 * (see inventoryService.reserveListingQuantity / the buy-now atomic claim).
 * If the buyer never completes payment, that quantity would otherwise stay
 * locked forever, since nothing else transitions the order out of
 * PENDING_PAYMENT. This finds every such order past its paymentDueAt
 * deadline and cancels it through the same path as a manual cancel
 * (cancelOrderInTransaction), which returns the quantity to the listing,
 * closes open payment obligations, and records the audit/event trail.
 *
 * Orders created before the paymentDueAt column existed have it as NULL
 * and are deliberately left alone here — only orders that were given an
 * explicit deadline at creation are auto-expired.
 */
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
        // Re-read and re-check inside the transaction: a payment may have
        // settled (or the buyer/seller may have already cancelled) between
        // the query above and this job actually running on this order.
        const current = await tx.order.findUnique({
          where: { id: candidate.id },
          include: { transportJob: true, payments: true },
        });

        if (!current || current.status !== 'PENDING_PAYMENT' || !current.paymentDueAt || current.paymentDueAt > now) {
          return;
        }

        // Belt-and-suspenders: settlePayment() (paymentService.js) is what
        // normally moves an order out of PENDING_PAYMENT the moment its
        // MARKETPLACE payment is marked PAID, so this order's status should
        // already reflect a completed payment. If a PAID payment is
        // somehow still attached to a PENDING_PAYMENT order — a narrow
        // window between the payment write and the order-status write
        // inside that same transaction — do not cancel and take the goods
        // away from a buyer who already paid; skip and let the next cycle
        // re-evaluate once the picture is consistent.
        if (current.payments.some((p) => p.status === 'PAID')) {
          console.warn(`Skipping auto-expire for order ${current.id}: has a PAID payment despite PENDING_PAYMENT status.`);
          return;
        }

        await cancelOrderInTransaction(tx, {
          order: current,
          actorId: null,
          reason: 'Payment window expired without a completed payment',
          cancelledByRole: 'SYSTEM',
        });
      });
      expired += 1;
    } catch (error) {
      console.error(`Failed to auto-expire unpaid order ${candidate.id}:`, error);
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
    });
    created += 1;
  }
  return { created };
}

const SMS_MAX_ATTEMPTS = 3;

/**
 * Actually send queued SMS notifications (see services/notificationService.js,
 * which writes PENDING rows in the same DB transaction as the triggering
 * event — this is the "outbox" half of that pattern: send outside any
 * transaction, so a slow/flaky SMS provider never holds a DB lock).
 */
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
      console.error(`SMS send failed for outbox entry ${entry.id} (attempt ${attempts}):`, error.message || error);
    }
  }

  return { sent, failed, remaining: pending.length - sent - failed };
}

async function runMaintenanceCycle() {
  return withJobLock(async () => {
    const startedAt = Date.now();
    const now = new Date();
    const [offers, listings, ads, reminders, unpaidOrders, sms] = await Promise.all([
      expireOffers(now), expireListings(now), expireAdvertisements(now), createPickupReminders(now), expireUnpaidOrders(now), sendPendingSms(now),
    ]);
    return { durationMs: Date.now() - startedAt, offers, listings, ads, reminders, unpaidOrders, sms };
  });
}

function startMaintenanceScheduler() {
  if (process.env.MARKETBRIDGE_JOBS_ENABLED === 'false') return null;
  const intervalMs = Math.max(Number(process.env.MARKETBRIDGE_JOB_INTERVAL_MS) || 60_000, 15_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { const result = await runMaintenanceCycle(); console.log('[jobs] maintenance cycle', JSON.stringify(result)); }
    catch (error) { console.error('[jobs] maintenance cycle failed:', error); }
    finally { running = false; }
  };
  void tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runMaintenanceCycle, startMaintenanceScheduler, expireOffers, expireListings, expireAdvertisements, createPickupReminders, sendPendingSms };
