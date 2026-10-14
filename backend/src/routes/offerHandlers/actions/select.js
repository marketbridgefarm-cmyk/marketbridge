const prisma = require('../../../config/db');
const {
  offerError,
  validateNegotiationWindow,
  findLeafOffer,
  expireOfferIfNeeded,
} = require('../../../services/offers/offerHelpers');
const { noticeWaitingLocked } = require('../../../services/waitingListService');
const { recordAuditEvent } = require('../../../utils/audit');

// SELLER SELECTS A BUYER BID FOR DEAL NEGOTIATION
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function selectOffer(req, res, ctx) {
  const { action, offer, sellerId, isSeller, admin } = ctx;

  if (!isSeller && !admin) {
    return res.status(403).json({
      error: 'Only the seller can select a buyer bid',
    });
  }

  if (offer.status !== 'PENDING') {
    return res.status(409).json({
      error: `Only a pending bid can be selected (current: ${offer.status})`,
    });
  }

  const selected = await prisma.$transaction(async (tx) => {
    const lockedListings = await tx.$queryRaw`
      SELECT "id", "sellerId"
      FROM "Listing"
      WHERE "id" = ${offer.listingId}
      FOR UPDATE
    `;

    if (!lockedListings?.length) {
      throw offerError('Listing not found', 404);
    }

    if (String(lockedListings[0].sellerId) !== String(sellerId)) {
      throw offerError('Listing seller changed; refresh and try again', 409);
    }

    const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });

    if (!fresh) throw offerError('Offer not found', 404);

    if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
      throw offerError('Offer has expired and can no longer be selected', 409);
    }

    if (fresh.status !== 'PENDING') {
      throw offerError(
        `This bid is no longer pending (current: ${fresh.status})`,
        409
      );
    }

    const negotiationWindowError = validateNegotiationWindow(fresh.listing);
    if (negotiationWindowError) {
      throw offerError(negotiationWindowError, 409);
    }

    const activeNegotiation = await tx.offer.findFirst({
      where: {
        listingId: fresh.listingId,
        status: { in: ['SELECTED', 'COUNTERED', 'PROVISIONAL'] },
        childOffers: { none: {} },
      },
      select: { id: true, buyerId: true, status: true },
    });

    if (activeNegotiation && String(activeNegotiation.buyerId) !== String(fresh.buyerId)) {
      throw offerError(
        'Another buyer is already in negotiation. Waiting bids cannot be selected until that negotiation is released, rejected, withdrawn, or expires.',
        409
      );
    }

    const provisionalOrder = await tx.order.findFirst({
      where: {
        listingId: fresh.listingId,
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
      },
      select: { id: true },
    });

    if (provisionalOrder) {
      throw offerError(
        'This listing already has an active provisional order. Release or cancel it before selecting another buyer.',
        409
      );
    }

    const claim = await tx.offer.updateMany({
      where: { id: fresh.id, status: 'PENDING' },
      data: { status: 'SELECTED' },
    });

    if (claim.count !== 1) {
      throw offerError(
        'This bid changed while you were selecting it. Refresh and try again.',
        409
      );
    }

    await recordAuditEvent(tx, {
      actorId: req.user.id,
      action: 'OFFER_SELECTED',
      resourceType: 'Offer',
      resourceId: fresh.id,
      metadata: {
        listingId: fresh.listingId,
        buyerId: fresh.buyerId,
      },
    });

    return tx.offer.findUnique({ where: { id: fresh.id } });
  }, { maxWait: 10000, timeout: 15000 });

  await noticeWaitingLocked(prisma, {
    listingId: selected.listingId,
    selectedOfferId: selected.id,
    selectedBuyerId: selected.buyerId,
  });

  return res.json({
    message: 'Buyer bid selected for exclusive price negotiation',
    offer: selected,
  });
}

module.exports = { selectOffer };
