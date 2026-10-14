const prisma = require('../../../config/db');
const {
  offerError,
  provisionalReleaseAvailableAt,
  findLeafOffer,
  expireOfferIfNeeded,
} = require('../../../services/offers/offerHelpers');
const { moveOfferToProvisional } = require('../../../services/offers/offerOrderService');

// SELLER ACCEPTS  →  PROVISIONAL
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function acceptOffer(req, res, ctx) {
  const { offer, isSeller, admin } = ctx;

  if (!isSeller && !admin) {
    return res.status(403).json({
      error:
        'Only the seller can accept an offer',
    });
  }

  if (!['SELECTED', 'COUNTERED'].includes(offer.status)) {
    return res.status(400).json({ error: `Offer cannot be accepted because it is ${offer.status}` });
  }

  if (
    offer.status === 'COUNTERED' &&
    offer.counteredBy !== 'BUYER'
  ) {
    return res.status(409).json({
      error:
        'The seller cannot accept their own counter-offer. The buyer must respond first.',
    });
  }

  const result =
    await prisma.$transaction(
      async (tx) => {
        const freshOffer =
          await findLeafOffer(tx, offer.id, { include: { listing: true } });

        if (!freshOffer) {
          throw offerError(
            'This negotiation has moved on. Refresh and try again.',
            409
          );
        }

        if (await expireOfferIfNeeded(tx, freshOffer, req.user.id)) {
          throw offerError('Offer has expired and can no longer be accepted', 409);
        }

        if (!['SELECTED', 'COUNTERED'].includes(freshOffer.status)) {
          throw offerError(
            `Offer cannot be accepted because it is ${freshOffer.status}`,
            409
          );
        }

        if (
          freshOffer.status ===
            'COUNTERED' &&
          freshOffer.counteredBy !==
            'BUYER'
        ) {
          throw offerError(
            'The seller cannot accept their own counter-offer. The buyer must respond first.',
            409
          );
        }

        const finalPrice =
          freshOffer.status ===
            'COUNTERED'
            ? Number(
                freshOffer.counterAmount
              )
            : Number(
                freshOffer.amount
              );

        if (
          !Number.isFinite(
            finalPrice
          ) ||
          finalPrice <= 0
        ) {
          throw offerError(
            'Offer does not have a valid final price',
            400
          );
        }

        return moveOfferToProvisional(tx, freshOffer, finalPrice, req.user.id);
      },
      { maxWait: 10000, timeout: 15000 }
    );

  return res.json({
    message: 'Provisional agreement reached. Either party can confirm to create the order.',
    offer: result.offer,
    provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
  });
}

module.exports = { acceptOffer };
