'use strict';

// ============================================================================
// NEGOTIATION SERVICE
// ============================================================================
//
// Pure helper functions for the sealed-bid / counter-offer negotiation
// pattern used by transport quotes, inspection quotes, and offers.
//
// Nothing in this file touches the database. Every function takes a plain
// quote object (a Prisma row or a plain serialized quote) and returns a
// value. This is intentional: the same helpers serve multiple quote tables
// without dynamic model dispatch.
//
// Used by:
//   • routes/transport.js       (transport quotes)
//   • routes/inspections.js     (inspection quotes)  — will migrate in Step 6
//   • offers flow               — will migrate in a later step
// ============================================================================

/**
 * Whose turn is it to respond in this negotiation?
 *
 *   'PENDING'   → REQUESTER (they haven't selected yet)
 *   'SELECTED'  → REQUESTER (they must accept or counter the initial bid)
 *   'COUNTERED' → the OTHER party from whoever last countered
 *   anything else → null (no turn; quote is in a terminal or non-negotiable state)
 */
function quoteTurn(quote) {
  if (!quote) return null;
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'SELECTED') return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

/**
 * Has this quote's expiresAt timestamp passed?
 *
 * A quote with `expiresAt: null` never expires — this is the state of
 * waiting bids in the null-expiry pool. The function returns false for them.
 */
function isQuoteExpired(quote) {
  return Boolean(quote && quote.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
}

/**
 * Returns a Date that is `hours` from now. Used when creating a quote or a
 * counter-offer with a validity window.
 */
function quoteExpiry(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Read a release-window env var, falling back to a default when the value is
 * missing or invalid. Handles the pattern used by transport and inspection
 * for their "how many hours before a silent provider can be released" window.
 *
 *   resolveReleaseWindowHours('TRANSPORT_RELEASE_AFTER_HOURS', 72)
 *   resolveReleaseWindowHours('INSPECTION_RELEASE_AFTER_HOURS', 72)
 */
function resolveReleaseWindowHours(envVarName, defaultHours) {
  const configured = Number(process.env[envVarName]);
  return Number.isFinite(configured) && configured >= 0 ? configured : defaultHours;
}

/**
 * When can the requester release this silent provider?
 *
 * Applies only while the provider has the turn — i.e. the quote is
 * SELECTED (requester picked the bid but hasn't yet negotiated a price), or
 * COUNTERED by the REQUESTER (the requester countered and the provider has
 * not yet answered). Once the provider answers, this returns null.
 *
 * Uses `updatedAt || createdAt` as the "since" point, so any state change to
 * the quote resets the clock.
 */
function computeReleaseAvailableAt(quote, afterHours) {
  if (!quote || !Number.isFinite(afterHours)) return null;

  const providerTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');

  if (!providerTurn) return null;

  const since = new Date(quote.updatedAt || quote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;

  return new Date(since + afterHours * 60 * 60 * 1000);
}

module.exports = {
  quoteTurn,
  isQuoteExpired,
  quoteExpiry,
  resolveReleaseWindowHours,
  computeReleaseAvailableAt,
};
