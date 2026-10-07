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
 *  4. Every release is recorded in the audit trail against the requester
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
function parseReleaseReason(body) {
  const reason = String(body?.reason || '').trim().toUpperCase();
  const note = String(body?.note || '').trim().slice(0, NOTE_MAX_LENGTH);
  if (!RELEASE_REASONS.includes(reason)) {
    throw releaseError(`Choose a release reason: ${RELEASE_REASONS.join(', ')}.`, 400);
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
