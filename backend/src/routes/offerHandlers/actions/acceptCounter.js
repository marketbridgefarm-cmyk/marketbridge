const prisma = require('../../../config/db');
const {
  isPositiveNumber,
  offerError,
  provisionalReleaseAvailableAt,
  findLeafOffer,
  expireOfferIfNeeded,
} = require('../../../services/offers/offerHelpers');
const { moveOfferToProvisional } = require('../../../services/offers/offerOrderService');

// BUYER ACCEPTS SELLER COUNTER  →  PROVISIONAL
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function acceptCounter(req, res, ctx) {
  const { offer, isBuyer, admin } = ctx;

  if (!isBuyer && !admin) {
    return res.status(403).json({
      error:
        'Only the buyer can accept a seller counter-offer',
    });
  }

  if (offer.status !== 'COUNTERED') {
    return res.status(400).json({
      error:
        `Offer must be COUNTERED before acceptance (current: ${offer.status})`,
    });
  }

  if (
    offer.counteredBy !==
    'SELLER'
  ) {
    return res.status(409).json({
      error:
        'The buyer can only accept a counter-offer made by the seller',
    });
  }

  if (
    !isPositiveNumber(
      offer.counterAmount
    )
  ) {
    return res.status(400).json({
      error:
        'Counter-offer has no valid counter amount',
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
          throw offerError('Offer has expired and can no longer be acted on', 409);
        }

        if (!['SELECTED', 'COUNTERED'].includes(freshOffer.status)) {
          throw offerError(
            `Offer cannot be accepted because it is ${freshOffer.status}`,
            409
          );
        }

        if (freshOffer.status === 'COUNTERED' && freshOffer.counteredBy !== 'SELLER') {
          throw offerError(
            'The buyer can only accept a seller counter-offer',
            409
          );
        }

        if (
          !isPositiveNumber(
            freshOffer.counterAmount
          )
        ) {
          throw offerError(
            'Counter-offer has no valid counter amount',
            400
          );
        }

        return moveOfferToProvisional(tx, freshOffer, Number(freshOffer.counterAmount), req.user.id);
      },
      { maxWait: 10000, timeout: 15000 }
    );

  return res.json({
    message: 'Provisional agreement reached. Either party can confirm to create the order.',
    offer: result.offer,
    provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
  });
}

module.exports = { acceptCounter };
