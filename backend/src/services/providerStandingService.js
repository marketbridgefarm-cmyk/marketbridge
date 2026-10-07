'use strict';

/**
 * Provider standing: automatic penalties for truck owners / inspectors who
 * repeatedly cancel accepted (provisional) agreements, and the way back.
 *
 * Applies to BIDDING only. The account itself (login, buying, selling) is
 * never suspended by this.
 *
 * Penalties
 *  - every cancellation: rating penalty -0.1
 *  - warning when one cancellation away from a suspension
 *  - suspension at PROVIDER_RELEASE_FLAG_THRESHOLD (default 3) cancellations
 *    since the last suspension and within 30 days:
 *      1st suspension  3 days   2nd  14 days   3rd  30 days
 *      4th and later   indefinite, admin reinstatement only
 *    each suspension also costs -0.5 rating
 *  - on PROBATION a single cancellation is an immediate next-tier suspension
 *
 * Rejoin path
 *  SUSPENDED --(timer ends)--> REJOIN_PENDING --(provider acknowledges
 *  the rules)--> PROBATION (30 days) --(clean)--> GOOD, half the rating
 *  penalty restored.
 *  Anytime: provider may appeal while SUSPENDED; admin may reinstate early
 *  (to PROBATION or straight to GOOD, optionally clearing the penalty).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPENSION_DAYS = [3, 14, 30];
const PROBATION_DAYS = 30;
const CANCEL_PENALTY = 0.1;
const SUSPENSION_PENALTY = 0.5;

const { providerFlagThreshold, PROVIDER_RELEASE_ACTIONS } = require('./releaseLimitsService');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');

function standingError(message, statusCode = 403, code = 'PROVIDER_STANDING', extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function suspensionDaysFor(suspensionNumber) {
  // null = indefinite
  return suspensionNumber <= SUSPENSION_DAYS.length ? SUSPENSION_DAYS[suspensionNumber - 1] : null;
}

async function getOrCreateStanding(tx, userId) {
  return tx.providerStanding.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

// Rating = average of received ratings minus the penalty (never below 0).
// Recomputed from scratch each time so penalties cannot drift.
async function recomputeUserRating(tx, userId) {
  const [agg, standing] = await Promise.all([
    tx.rating.aggregate({ where: { toUserId: userId }, _avg: { score: true } }),
    tx.providerStanding.findUnique({ where: { userId }, select: { ratingPenalty: true } }),
  ]);
  const avg = agg._avg.score || 0;
  const penalty = standing?.ratingPenalty || 0;
  const value = avg > 0 ? Math.max(0, Math.round((avg - penalty) * 100) / 100) : 0;
  await tx.user.update({ where: { id: userId }, data: { rating: value } });
  return value;
}

async function strikesSinceLastSuspension(tx, standing) {
  const windowStart = new Date(Date.now() - 30 * DAY_MS);
  const since = standing.suspendedAt && standing.suspendedAt > windowStart ? standing.suspendedAt : windowStart;
  return tx.auditEvent.count({
    where: {
      actorId: standing.userId,
      action: { in: [...PROVIDER_RELEASE_ACTIONS] },
      createdAt: { gt: since },
    },
  });
}

async function notifyProvider(tx, { orderId, providerId, kind, until = null }) {
  if (!orderId) return;
  await recordOrderEvent(tx, {
    orderId,
    actorId: null,
    type: 'PROVIDER_STANDING_CHANGED',
    metadata: { providerId, kind, until: until ? until.toISOString() : null },
  });
}

async function suspend(tx, standing, { reason, orderId = null, byAdminId = null, days } ) {
  const suspensionNumber = standing.suspensionCount + 1;
  const length = days === undefined ? suspensionDaysFor(suspensionNumber) : days;
  const now = new Date();
  const until = length === null ? null : new Date(now.getTime() + length * DAY_MS);

  const updated = await tx.providerStanding.update({
    where: { id: standing.id },
    data: {
      status: 'SUSPENDED',
      suspensionCount: suspensionNumber,
      suspendedAt: now,
      suspendedUntil: until,
      probationUntil: null,
      ratingPenalty: standing.ratingPenalty + SUSPENSION_PENALTY,
      lastReason: reason,
      appealMessage: null,
      appealedAt: null,
    },
  });
  await recomputeUserRating(tx, standing.userId);
  await recordAuditEvent(tx, {
    actorId: byAdminId,
    action: 'PROVIDER_SUSPENDED',
    resourceType: 'ProviderStanding',
    resourceId: standing.id,
    metadata: { providerId: standing.userId, suspensionNumber, until, reason, indefinite: until === null },
  });
  await notifyProvider(tx, { orderId, providerId: standing.userId, kind: 'SUSPENDED', until });
  return updated;
}

/**
 * Called inside the transaction right after a provider-release audit event
 * was recorded. Applies the rating hit and escalates warning/suspension.
 */
async function applyProviderCancellation(tx, { userId, orderId, reason }) {
  let standing = await getOrCreateStanding(tx, userId);
  standing = await settleTimers(tx, standing);

  standing = await tx.providerStanding.update({
    where: { id: standing.id },
    data: { ratingPenalty: standing.ratingPenalty + CANCEL_PENALTY },
  });

  const strikes = await strikesSinceLastSuspension(tx, standing);
  const threshold = providerFlagThreshold();

  let outcome = { status: standing.status, strikes, threshold, action: 'RATING_HIT' };

  if (standing.status === 'PROBATION' || strikes >= threshold) {
    standing = await suspend(tx, standing, {
      reason: standing.status === 'PROBATION'
        ? `Cancelled an accepted agreement while on probation (${reason})`
        : `${strikes} cancellations of accepted agreements within 30 days (${reason})`,
      orderId,
    });
    outcome = { status: 'SUSPENDED', strikes, threshold, action: 'SUSPENDED', until: standing.suspendedUntil };
  } else {
    await recomputeUserRating(tx, userId);
    if (strikes === threshold - 1) {
      await notifyProvider(tx, { orderId, providerId: userId, kind: 'WARNING' });
      outcome.action = 'WARNED';
    }
  }
  return outcome;
}

// Lazily move timers forward (also run by the maintenance sweep).
async function settleTimers(tx, standing) {
  const now = new Date();
  if (standing.status === 'SUSPENDED' && standing.suspendedUntil && standing.suspendedUntil <= now) {
    return tx.providerStanding.update({ where: { id: standing.id }, data: { status: 'REJOIN_PENDING' } });
  }
  if (standing.status === 'PROBATION' && standing.probationUntil && standing.probationUntil <= now) {
    const updated = await tx.providerStanding.update({
      where: { id: standing.id },
      data: {
        status: 'GOOD',
        probationUntil: null,
        ratingPenalty: Math.round((standing.ratingPenalty / 2) * 100) / 100,
      },
    });
    await recomputeUserRating(tx, standing.userId);
    await recordAuditEvent(tx, {
      action: 'PROVIDER_PROBATION_COMPLETED',
      resourceType: 'ProviderStanding',
      resourceId: standing.id,
      metadata: { providerId: standing.userId },
    });
    return updated;
  }
  return standing;
}

// Gate for placing bids. Throws a 403 with a code the UI can act on.
async function assertProviderCanBid(prisma, userId) {
  const existing = await prisma.providerStanding.findUnique({ where: { userId } });
  if (!existing) return;
  const standing = await prisma.$transaction((tx) => settleTimers(tx, existing));

  if (standing.status === 'SUSPENDED') {
    throw standingError(
      standing.suspendedUntil
        ? `Your bidding is suspended until ${standing.suspendedUntil.toISOString()} because of repeated cancellations. You can appeal from your dashboard.`
        : 'Your bidding is suspended until MarketBridge admin reviews your account. You can appeal from your dashboard.',
      403,
      'PROVIDER_SUSPENDED',
      { suspendedUntil: standing.suspendedUntil }
    );
  }
  if (standing.status === 'REJOIN_PENDING') {
    throw standingError(
      'Your suspension has ended. Acknowledge the marketplace rules on your dashboard to rejoin on probation.',
      403,
      'PROVIDER_REJOIN_REQUIRED'
    );
  }
}

async function getStandingSummary(prisma, userId) {
  let standing = await prisma.providerStanding.findUnique({ where: { userId } });
  if (standing) standing = await prisma.$transaction((tx) => settleTimers(tx, standing));
  const base = standing || { status: 'GOOD', suspensionCount: 0, ratingPenalty: 0 };
  const strikes = standing ? await strikesSinceLastSuspension(prisma, standing) : 0;
  return {
    status: base.status,
    suspensionCount: base.suspensionCount,
    suspendedUntil: base.suspendedUntil || null,
    probationUntil: base.probationUntil || null,
    ratingPenalty: base.ratingPenalty,
    strikes,
    threshold: providerFlagThreshold(),
    probationDays: PROBATION_DAYS,
    canAppeal: base.status === 'SUSPENDED' && !base.appealedAt,
    appealMessage: base.appealMessage || null,
    nextSuspensionDays: suspensionDaysFor(base.suspensionCount + 1),
  };
}

async function rejoin(prisma, userId) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.providerStanding.findUnique({ where: { userId } });
    if (!existing) throw standingError('Nothing to rejoin.', 409, 'NOT_SUSPENDED');
    const standing = await settleTimers(tx, existing);
    if (standing.status !== 'REJOIN_PENDING') {
      throw standingError('You can rejoin once your suspension period has ended.', 409, 'NOT_REJOIN_PENDING');
    }
    const updated = await tx.providerStanding.update({
      where: { id: standing.id },
      data: { status: 'PROBATION', probationUntil: new Date(Date.now() + PROBATION_DAYS * DAY_MS) },
    });
    await recordAuditEvent(tx, {
      actorId: userId,
      action: 'PROVIDER_REJOINED_ON_PROBATION',
      resourceType: 'ProviderStanding',
      resourceId: standing.id,
      metadata: { providerId: userId, probationUntil: updated.probationUntil },
    });
    return updated;
  });
}

async function appeal(prisma, userId, message) {
  const text = String(message || '').trim().slice(0, 1000);
  if (text.length < 10) throw standingError('Please explain your appeal in at least 10 characters.', 400, 'APPEAL_TOO_SHORT');
  return prisma.$transaction(async (tx) => {
    const standing = await tx.providerStanding.findUnique({ where: { userId } });
    if (!standing || standing.status !== 'SUSPENDED') {
      throw standingError('Appeals are only possible while suspended.', 409, 'NOT_SUSPENDED');
    }
    if (standing.appealedAt) throw standingError('You already submitted an appeal for this suspension.', 409, 'ALREADY_APPEALED');
    const updated = await tx.providerStanding.update({
      where: { id: standing.id },
      data: { appealMessage: text, appealedAt: new Date() },
    });
    await recordAuditEvent(tx, {
      actorId: userId,
      action: 'PROVIDER_SUSPENSION_APPEALED',
      resourceType: 'ProviderStanding',
      resourceId: standing.id,
      metadata: { providerId: userId },
    });
    return updated;
  });
}

// Admin: reinstate early. to = 'PROBATION' | 'GOOD'. clearPenalty restores the whole rating penalty.
async function adminReinstate(prisma, { userId, adminId, to = 'PROBATION', clearPenalty = false, note = null }) {
  if (!['PROBATION', 'GOOD'].includes(to)) throw standingError('Invalid target status.', 400, 'BAD_TARGET');
  return prisma.$transaction(async (tx) => {
    const standing = await tx.providerStanding.findUnique({ where: { userId } });
    if (!standing || !['SUSPENDED', 'REJOIN_PENDING'].includes(standing.status)) {
      throw standingError('This provider is not suspended.', 409, 'NOT_SUSPENDED');
    }
    const updated = await tx.providerStanding.update({
      where: { id: standing.id },
      data: {
        status: to,
        suspendedUntil: null,
        probationUntil: to === 'PROBATION' ? new Date(Date.now() + PROBATION_DAYS * DAY_MS) : null,
        ratingPenalty: clearPenalty ? 0 : standing.ratingPenalty,
        appealMessage: null,
        appealedAt: null,
      },
    });
    await recomputeUserRating(tx, userId);
    await recordAuditEvent(tx, {
      actorId: adminId,
      action: 'PROVIDER_REINSTATED_BY_ADMIN',
      resourceType: 'ProviderStanding',
      resourceId: standing.id,
      metadata: { providerId: userId, to, clearPenalty, note: note ? String(note).slice(0, 300) : null },
    });
    return updated;
  });
}

// Maintenance sweep: expire suspensions and finish clean probations.
async function sweepProviderStandings(prisma, now = new Date()) {
  const due = await prisma.providerStanding.findMany({
    where: {
      OR: [
        { status: 'SUSPENDED', suspendedUntil: { lte: now } },
        { status: 'PROBATION', probationUntil: { lte: now } },
      ],
    },
    take: 200,
  });
  let moved = 0;
  for (const s of due) {
    await prisma.$transaction((tx) => settleTimers(tx, s));
    moved += 1;
  }
  return { moved };
}

module.exports = {
  SUSPENSION_DAYS,
  PROBATION_DAYS,
  CANCEL_PENALTY,
  SUSPENSION_PENALTY,
  suspensionDaysFor,
  recomputeUserRating,
  applyProviderCancellation,
  settleTimers,
  assertProviderCanBid,
  getStandingSummary,
  rejoin,
  appeal,
  adminReinstate,
  sweepProviderStandings,
};
