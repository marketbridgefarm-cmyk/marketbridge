'use strict';

/**
 * Shared limits for a requester releasing an ACCEPTED (provisional)
 * transporter or inspector agreement, so the two flows cannot drift apart.
 *
 *  1. A reason from a fixed list is required.
 *  2. The requester must wait RELEASE_AFTER_ACCEPT_HOURS (default 24) after
 *     acceptance before releasing.
 *  3. At most MAX_ACCEPTED_RELEASES (default 2) accepted releases per job;
 *     after that the release is blocked and flagged for admin review.
 *  4. Providers cancelling an accepted deal must also give a reason (their own
 *     list), are recorded, notified-to-others, barred from re-bidding on the
 *     same job, and listed for admin when they do it often (30 days).
 *  5. Every release is recorded in the audit trail against the requester
 *     (reason, note, release number) and is visible to admin through
 *     GET /admin/audit-events.
 *
 * Silent-provider releases (SELECTED / requester-countered quotes) keep their
 * own existing waiting window and are not counted here.
 */

const RELEASE_REASONS = Object.freeze([
  'PROVIDER_UNAVAILABLE',
  'NO_RESPONSE',
  'PRICE_CHANGED',
  'SCHEDULE_CONFLICT',
  'OTHER',
]);

// Provider-side (truck owner / inspector) reasons for cancelling an accepted
// agreement. PROVIDER_UNAVAILABLE is kept for older clients.
const PROVIDER_RELEASE_REASONS = Object.freeze([
  'VEHICLE_OR_EQUIPMENT_ISSUE',
  'SCHEDULE_CONFLICT',
  'PRICE_NOT_VIABLE',
  'REQUESTER_UNRESPONSIVE',
  'SITE_OR_ROUTE_ISSUE',
  'PROVIDER_UNAVAILABLE',
  'OTHER',
]);

const PROVIDER_RELEASE_ACTIONS = Object.freeze([
  'TRANSPORT_ACCEPTED_RELEASED_BY_PROVIDER',
  'INSPECTION_ACCEPTED_RELEASED_BY_PROVIDER',
]);

// Provider cancels of accepted deals within 30 days that put them on the
// admin "frequent provider releases" list. Informational only: no automatic
// penalty is applied.
function providerFlagThreshold() {
  const configured = Number(process.env.PROVIDER_RELEASE_FLAG_THRESHOLD);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
}

const NOTE_MAX_LENGTH = 200;

function acceptedReleaseWaitHours() {
  const configured = Number(process.env.RELEASE_AFTER_ACCEPT_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
}

function maxAcceptedReleases() {
  const configured = Number(process.env.MAX_ACCEPTED_RELEASES_PER_JOB);
  return Number.isInteger(configured) && configured >= 0 ? configured : 2;
}

function releaseError(message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

// Returns { reason, note } or throws a 400 error.
function parseReleaseReason(body, { provider = false } = {}) {
  const allowedReasons = provider ? PROVIDER_RELEASE_REASONS : RELEASE_REASONS;
  const reason = String(body?.reason || '').trim().toUpperCase();
  const note = String(body?.note || '').trim().slice(0, NOTE_MAX_LENGTH);
  if (!allowedReasons.includes(reason)) {
    throw releaseError(`Choose a release reason: ${allowedReasons.join(', ')}.`, 400);
  }
  if (reason === 'OTHER' && !note) {
    throw releaseError('Add a short note when the release reason is OTHER.', 400);
  }
  return { reason, note: note || null };
}

// Earliest time an ACCEPTED agreement may be released (null if unknown).
function acceptedReleaseAvailableAt(acceptedQuote) {
  if (!acceptedQuote) return null;
  const since = new Date(acceptedQuote.updatedAt || acceptedQuote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + acceptedReleaseWaitHours() * 60 * 60 * 1000);
}

function assertAcceptedReleaseWindowElapsed(acceptedQuote) {
  const availableAt = acceptedReleaseAvailableAt(acceptedQuote);
  if (availableAt && availableAt.getTime() > Date.now()) {
    throw releaseError(
      `This agreement can be released from ${availableAt.toISOString()} (${acceptedReleaseWaitHours()}h after acceptance).`,
      409,
      { releaseAvailableAt: availableAt }
    );
  }
}

// How many accepted releases were already recorded for this job.
// Call inside the transaction, after the job/order row lock is held.
async function countAcceptedReleases(tx, { action, metadataKey, jobId }) {
  return tx.auditEvent.count({
    where: { action, metadata: { path: [metadataKey], equals: jobId } },
  });
}

// How many accepted deals this provider cancelled in the last 30 days.
async function providerReleaseCountLast30d(tx, userId) {
  return tx.auditEvent.count({
    where: {
      actorId: userId,
      action: { in: [...PROVIDER_RELEASE_ACTIONS] },
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
  });
}

const OVERRIDE_ACTION = 'RELEASE_LIMIT_OVERRIDE';

// { used, allowed }: allowed = cap + one extra release per admin override
// recorded for this job. Call inside the transaction after the row lock.
async function releaseAllowance(tx, { action, metadataKey, jobId }) {
  const [used, overrides] = await Promise.all([
    countAcceptedReleases(tx, { action, metadataKey, jobId }),
    tx.auditEvent.count({
      where: { action: OVERRIDE_ACTION, metadata: { path: ['jobId'], equals: jobId } },
    }),
  ]);
  return { used, allowed: maxAcceptedReleases() + overrides };
}

const LIMIT_MESSAGE =
  'Release limit reached for this job. MarketBridge admin has been flagged to review before another provider can be released.';

module.exports = {
  RELEASE_REASONS,
  PROVIDER_RELEASE_REASONS,
  PROVIDER_RELEASE_ACTIONS,
  providerFlagThreshold,
  providerReleaseCountLast30d,
  acceptedReleaseWaitHours,
  maxAcceptedReleases,
  parseReleaseReason,
  acceptedReleaseAvailableAt,
  assertAcceptedReleaseWindowElapsed,
  countAcceptedReleases,
  releaseAllowance,
  OVERRIDE_ACTION,
  releaseError,
  LIMIT_MESSAGE,
};
