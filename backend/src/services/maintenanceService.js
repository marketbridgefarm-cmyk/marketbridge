'use strict';

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');

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

async function runMaintenanceCycle() {
  return withJobLock(async () => {
    const startedAt = Date.now();
    const now = new Date();
    const [offers, listings, ads, reminders] = await Promise.all([
      expireOffers(now), expireListings(now), expireAdvertisements(now), createPickupReminders(now),
    ]);
    return { durationMs: Date.now() - startedAt, offers, listings, ads, reminders };
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

module.exports = { runMaintenanceCycle, startMaintenanceScheduler, expireOffers, expireListings, expireAdvertisements, createPickupReminders };
