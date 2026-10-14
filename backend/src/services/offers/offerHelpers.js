const { recordAuditEvent } = require('../../utils/audit');

// Shared helpers for the offer/negotiation routes (routes/offers.js and
// routes/offerHandlers/*). Extracted verbatim from the former single-file router.

function isAdmin(req) {
  return (
    Array.isArray(req.user.roles) &&
    req.user.roles.includes('ADMIN')
  );
}

function isPositiveNumber(value) {
  const number = Number(value);

  return (
    value !== undefined &&
    value !== null &&
    Number.isFinite(number) &&
    number > 0
  );
}

function offerError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// No response timers: waiting bids stay until the goods are paid and
// negotiation continues until a price is agreed. The only natural limit is the
// end of an agricultural listing's pickup window (null = no expiry).
function offerExpiry(listing = null) {
  if (listing?.category === 'AGRICULTURAL' && listing.pickupWindowEnd) {
    const end = new Date(listing.pickupWindowEnd);
    if (Number.isFinite(end.getTime())) return end;
  }
  return null;
}

function validateNegotiationWindow(listing) {
  if (listing?.category !== 'AGRICULTURAL' || !listing.pickupWindowEnd) return null;

  const deadline = new Date(listing.pickupWindowEnd).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    return 'The agricultural pickup window has expired; negotiation cannot continue until the listing is updated.';
  }

  return null;
}

// Safety valve for a silent buyer. The seller can never reject a buyer in
// negotiation, but may RELEASE a buyer who has not responded for a while.
// Only when it is the buyer's turn: SELECTED (buyer has not answered) or a
// seller counter (buyer has not answered it). 0 hours = allowed immediately.
function releaseAfterHours() {
  const configured = Number(process.env.OFFER_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 72;
}

function releaseAvailableAt(offer) {
  const buyersTurn =
    offer.status === 'SELECTED' ||
    (offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER');
  if (!buyersTurn) return null;
  const since = new Date(offer.updatedAt || offer.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + releaseAfterHours() * 60 * 60 * 1000);
}

// Provisional release window (24h by default). This is the "you must wait
// before you can release a provisional agreement" cooldown.
const PROVISIONAL_RELEASE_AFTER_HOURS = (() => {
  const configured = Number(process.env.OFFER_PROVISIONAL_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

function provisionalReleaseAvailableAt(offer) {
  if (!offer) return null;
  const since = new Date(offer.updatedAt || offer.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + PROVISIONAL_RELEASE_AFTER_HOURS * 60 * 60 * 1000);
}

function isOfferExpired(offer) {
  return Boolean(
    offer.expiresAt &&
    new Date(offer.expiresAt).getTime() <= Date.now()
  );
}

// ---------------------------------------------------------------------------
// LEAF RESOLUTION
// ---------------------------------------------------------------------------
// A counter-chain is a linked list of immutable rows. The leaf is the row
// with no children — the current live price. Every mutation must resolve the
// leaf first so a stale parent id can never be acted on.
function findLeafOffer(tx, offerId, extra = {}) {
  return tx.offer.findFirst({
    where: { id: offerId, childOffers: { none: {} } },
    ...extra,
  });
}

async function expireOfferIfNeeded(tx, offer, actorId = null) {
  if (!offer || !isOfferExpired(offer)) return false;
  if (!['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(offer.status)) return false;

  const updated = await tx.offer.update({
    where: { id: offer.id },
    data: { status: 'EXPIRED' },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_EXPIRED',
    resourceType: 'Offer',
    resourceId: updated.id,
    metadata: {
      listingId: updated.listingId,
      previousStatus: offer.status,
      expiresAt: offer.expiresAt,
    },
  });

  return true;
}

module.exports = {
  isAdmin,
  isPositiveNumber,
  offerError,
  offerExpiry,
  validateNegotiationWindow,
  releaseAfterHours,
  releaseAvailableAt,
  provisionalReleaseAvailableAt,
  isOfferExpired,
  findLeafOffer,
  expireOfferIfNeeded,
  PROVISIONAL_RELEASE_AFTER_HOURS,
};
