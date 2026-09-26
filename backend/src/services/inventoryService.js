const EPSILON = 1e-9;

function normalizeQuantity(value, field = 'quantity') {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    const error = new Error(`${field} must be greater than zero`);
    error.status = 400;
    throw error;
  }
  return quantity;
}

function availableQuantity(listing) {
  const value = Number(listing?.availableQuantity);
  return Number.isFinite(value) ? value : Number(listing?.quantity || 0);
}

/**
 * Atomically reserve inventory for an agricultural order.
 * PostgreSQL evaluates the quantity predicate while holding the listing row
 * lock, so concurrent buyers cannot reserve the same produce twice.
 */
async function reserveListingQuantity(tx, listingId, requestedQuantity) {
  const quantity = normalizeQuantity(requestedQuantity);

  const claim = await tx.listing.updateMany({
    where: {
      id: listingId,
      category: { in: ['AGRICULTURAL', 'PRODUCT'] },
      status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] },
      availableQuantity: { gte: quantity },
    },
    data: {
      availableQuantity: { decrement: quantity },
    },
  });

  if (claim.count !== 1) {
    const error = new Error('Requested quantity is no longer available');
    error.status = 409;
    error.code = 'INSUFFICIENT_INVENTORY';
    throw error;
  }

  const listing = await tx.listing.findUnique({
    where: { id: listingId },
    select: { id: true, quantity: true, availableQuantity: true, status: true },
  });

  if (!listing) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }

  const remaining = availableQuantity(listing);
  await tx.listing.update({
    where: { id: listingId },
    data: {
      status: remaining <= EPSILON ? 'SOLD' : 'UNDER_NEGOTIATION',
    },
  });

  return { listing, reservedQuantity: quantity, remainingQuantity: remaining };
}

/**
 * Commit inventory at the moment the goods payment settles. A provisional
 * order created by offer acceptance does not consume inventory; this function
 * is the single commercial commitment point for physical goods.
 */
async function commitListingQuantity(tx, listingId, requestedQuantity) {
  const quantity = normalizeQuantity(requestedQuantity);

  const claim = await tx.listing.updateMany({
    where: {
      id: listingId,
      category: { in: ['AGRICULTURAL', 'PRODUCT'] },
      status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] },
      availableQuantity: { gte: quantity },
    },
    data: {
      availableQuantity: { decrement: quantity },
    },
  });

  if (claim.count !== 1) {
    const error = new Error('Requested quantity is no longer available for payment commitment');
    error.status = 409;
    error.code = 'INSUFFICIENT_INVENTORY';
    throw error;
  }

  const listing = await tx.listing.findUnique({
    where: { id: listingId },
    select: { id: true, quantity: true, availableQuantity: true, status: true },
  });

  if (!listing) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }

  const remaining = availableQuantity(listing);
  await tx.listing.update({
    where: { id: listingId },
    data: {
      status: remaining <= EPSILON ? 'SOLD' : 'UNDER_NEGOTIATION',
    },
  });

  // Once payment has actually committed the goods, all other waiting bids
  // are closed. Until this point they remain visible and eligible to be
  // promoted if the provisional winner cancels.
  if (remaining <= EPSILON) {
    await tx.offer.updateMany({
      where: {
        listingId,
        status: { in: ['PENDING', 'COUNTERED', 'SELECTED'] },
      },
      data: { status: 'REJECTED' },
    });
  }

  return { listing, committedQuantity: quantity, remainingQuantity: remaining };
}

/**
 * Return an order's committed quantity to the listing when a paid order is
 * cancelled before the goods have moved. This is deliberately idempotent at
 * the call-site: callers should invoke it only during the first transition
 * into CANCELLED.
 */
async function releaseListingQuantity(tx, order) {
  // Provisional PENDING_PAYMENT orders never consumed inventory. Their
  // cancellation must therefore not add quantity back to the listing.
  if (order.status !== 'CONFIRMED') return null;

  const quantity = normalizeQuantity(order.quantity, 'order quantity');

  const listing = await tx.listing.findUnique({
    where: { id: order.listingId },
    select: { id: true, category: true, quantity: true, availableQuantity: true },
  });

  if (!listing || !['AGRICULTURAL', 'PRODUCT'].includes(listing.category)) return null;

  const currentAvailable = availableQuantity(listing);
  const restored = Math.min(Number(listing.quantity), currentAvailable + quantity);

  const activeOffers = await tx.offer.count({
    where: {
      listingId: order.listingId,
      status: { in: ['PENDING', 'COUNTERED'] },
    },
  });

  const nextStatus = restored <= EPSILON
    ? 'SOLD'
    : activeOffers > 0
      ? 'UNDER_NEGOTIATION'
      : 'ACTIVE';

  return tx.listing.update({
    where: { id: order.listingId },
    data: {
      availableQuantity: restored,
      status: nextStatus,
    },
  });
}

module.exports = {
  normalizeQuantity,
  availableQuantity,
  reserveListingQuantity,
  commitListingQuantity,
  releaseListingQuantity,
};
