const { offerError, isOfferExpired } = require('./offerHelpers');
const { recordOrderEvent } = require('../orderEventService');
const { recordAuditEvent } = require('../../utils/audit');
const { computePaymentDueAt } = require('../../utils/orderTiming');

async function moveOfferToProvisional(tx, offer, finalUnitPrice, actorId) {
  if (!['AGRICULTURAL', 'PRODUCT'].includes(offer.listing.category)) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }
  if (isOfferExpired(offer)) {
    throw offerError('Offer has expired and can no longer be accepted', 409);
  }

  const unitPrice = Number(finalUnitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw offerError('Offer does not have a valid unit price', 400);
  }

  const claim = await tx.offer.updateMany({
    where: { id: offer.id, status: { in: ['SELECTED', 'COUNTERED'] } },
    data: { status: 'PROVISIONAL' },
  });
  if (claim.count !== 1) throw offerError('This offer has already been acted on', 409);

  const updatedOffer = await tx.offer.findUnique({ where: { id: offer.id } });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_PROVISIONAL_AGREED',
    resourceType: 'Offer',
    resourceId: updatedOffer.id,
    metadata: {
      listingId: offer.listingId,
      buyerId: offer.buyerId,
      sellerId: offer.sellerId,
      agreedUnitPrice: unitPrice,
      quantity: Number(offer.quantity),
    },
  });

  return { offer: updatedOffer };
}

// ============================================================================
// ACCEPT OFFER AND CREATE ORDER
// ============================================================================

async function acceptOfferAndCreateOrder(
  tx,
  offer,
  finalUnitPrice,
  sellerId,
  actorId = sellerId
) {
  if (!['AGRICULTURAL', 'PRODUCT'].includes(offer.listing.category)) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }

  if (isOfferExpired(offer)) {
    throw offerError('Offer has expired and can no longer be accepted', 409);
  }

  const requestedQuantity = Number(offer.quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw offerError('Offer has no valid quantity', 400);
  }

  const unitPrice = Number(finalUnitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw offerError('Offer does not have a valid unit price', 400);
  }

  const lockedListingRows = await tx.$queryRaw`
    SELECT "id", "availableQuantity", "quantity", "minAcceptablePrice", "category", "sellerId"
    FROM "Listing"
    WHERE "id" = ${offer.listingId}
    FOR UPDATE
  `;
  const lockedListing = lockedListingRows?.[0];
  if (!lockedListing) throw offerError('Listing not found', 404);
  if (!['AGRICULTURAL', 'PRODUCT'].includes(String(lockedListing.category))) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }
  if (String(lockedListing.sellerId) !== String(sellerId)) {
    throw offerError('Listing seller changed; refresh and try again', 409);
  }

  const availableQuantity = Number(lockedListing.availableQuantity);
  if (!Number.isFinite(availableQuantity) || availableQuantity < requestedQuantity) {
    throw offerError(
      `Only ${Number.isFinite(availableQuantity) ? availableQuantity : 0} units remain available for this offer`,
      409
    );
  }

  const totalPrice = Math.round(unitPrice * requestedQuantity * 100) / 100;
  const minimumUnitPrice = lockedListing.minAcceptablePrice == null
    ? null
    : Number(lockedListing.minAcceptablePrice);
  if (minimumUnitPrice != null && Number.isFinite(minimumUnitPrice) && unitPrice < minimumUnitPrice) {
    throw offerError(
      "Offer price is below the seller's minimum acceptable price",
      409
    );
  }

  const offerClaim = await tx.offer.updateMany({
    where: {
      id: offer.id,
      status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
    },
    data: { status: 'ACCEPTED' },
  });

  if (offerClaim.count !== 1) {
    throw offerError('This offer has already been acted on', 409);
  }

  const updatedOffer = await tx.offer.findUnique({
    where: { id: offer.id },
  });

  const existingProvisionalOrder = await tx.order.findFirst({
    where: {
      listingId: offer.listingId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    select: { id: true, buyerId: true, status: true },
  });

  if (existingProvisionalOrder) {
    throw offerError(
      'This listing already has a provisional buyer agreement. Cancel or release that order before accepting another buyer.',
      409
    );
  }

  const inspectionRequired =
    offer.listing.category === 'AGRICULTURAL' ||
    offer.listing.inspectionRequired === true;

  const order =
    await tx.order.create({
      data: {
        listingId: offer.listingId,
        buyerId: offer.buyerId,
        sellerId,
        finalPrice: totalPrice,
        originalFinalPrice: totalPrice,
        quantity: requestedQuantity,
        status: 'PENDING_PAYMENT',
        agreedOfferId: updatedOffer.id,
        agreedAt: new Date(),
        paymentDueAt: inspectionRequired ? null : computePaymentDueAt(),
      },
    });

  await recordOrderEvent(tx, {
    orderId: order.id,
    actorId,
    type: 'ORDER_CREATED',
    toStatus: order.status,
    metadata: {
      listingId: offer.listingId,
      offerId: updatedOffer.id,
      via: 'offer-acceptance',
    },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_ACCEPTED',
    resourceType: 'Offer',
    resourceId: updatedOffer.id,
    metadata: {
      listingId: offer.listingId,
      buyerId: offer.buyerId,
      sellerId,
      finalUnitPrice: unitPrice,
      totalPrice,
      quantity: requestedQuantity,
      orderId: order.id,
    },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'ORDER_CREATED_FROM_OFFER',
    resourceType: 'Order',
    resourceId: order.id,
    metadata: {
      listingId: offer.listingId,
      offerId: updatedOffer.id,
      buyerId: offer.buyerId,
      sellerId,
      finalUnitPrice: unitPrice,
      totalPrice,
      quantity: requestedQuantity,
      status: order.status,
    },
  });

  return {
    offer: updatedOffer,
    order,
  };
}

module.exports = {
  moveOfferToProvisional,
  acceptOfferAndCreateOrder,
};
