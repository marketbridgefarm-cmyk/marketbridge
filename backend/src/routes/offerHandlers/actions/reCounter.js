const prisma = require('../../../config/db');
const { getMarketPriceReference, marketSnapshotData } = require('../../../services/marketPriceService');
const {
  offerError,
  offerExpiry,
  validateNegotiationWindow,
  findLeafOffer,
  expireOfferIfNeeded,
} = require('../../../services/offers/offerHelpers');
const { recordAuditEvent } = require('../../../utils/audit');
const { AMOUNT_LIMITS, amountProblem } = require('../../../utils/contactGuard');

// BUYER RE-COUNTERS
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function reCounter(req, res, ctx) {
  const { action, offer, sellerId, isBuyer, admin } = ctx;
  const { counterAmount } = req.body;

  if (!isBuyer && !admin) {
    return res.status(403).json({
      error:
        'Only the buyer can respond with another counter-offer',
    });
  }

  if (!['SELECTED', 'COUNTERED'].includes(offer.status)) {
    return res.status(400).json({ error: `Offer must be SELECTED or COUNTERED before another counter-offer can be made (current: ${offer.status})` });
  }

  if (offer.status === 'COUNTERED' && offer.counteredBy !== 'SELLER') {
    return res.status(409).json({
      error:
        'The buyer cannot counter twice in a row. The seller must respond first.',
    });
  }

  const counterProblem = amountProblem(
    counterAmount,
    AMOUNT_LIMITS.offer
  );
  if (counterProblem) {
    return res.status(400).json({ error: counterProblem });
  }

  const numericCounter =
    Number(counterAmount);
  const marketReference = await getMarketPriceReference(prisma, offer.listing, { quantity: offer.quantity });

  const updated =
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

        if (
          !['SELECTED', 'COUNTERED'].includes(
            freshOffer.status
          )
        ) {
          throw offerError(
            `Offer cannot be re-countered because it is ${freshOffer.status}`,
            409
          );
        }

        if (
          freshOffer.status === 'COUNTERED' &&
          freshOffer.counteredBy !==
          'SELLER'
        ) {
          throw offerError(
            'The buyer cannot counter twice in a row. The seller must respond first.',
            409
          );
        }

        const negotiationWindowError = validateNegotiationWindow(freshOffer.listing);
        if (negotiationWindowError) {
          throw offerError(negotiationWindowError, 409);
        }

        const counterExpiresAt = offerExpiry(freshOffer.listing);
        if (counterExpiresAt && counterExpiresAt.getTime() <= Date.now()) {
          throw offerError('The agricultural pickup window is too close or has expired.', 409);
        }

        await tx.offer.update({
          where: { id: freshOffer.id },
          data: { status: 'COUNTERED' },
        });

        const counterOffer = await tx.offer.create({
          data: {
            listingId: freshOffer.listingId,
            buyerId: freshOffer.buyerId,
            sellerId: freshOffer.sellerId,
            amount: numericCounter,
            quantity: freshOffer.quantity,
            status: 'COUNTERED',
            counterAmount: numericCounter,
            counteredBy: 'BUYER',
            parentOfferId: freshOffer.id,
            expiresAt: counterExpiresAt,
            ...marketSnapshotData(marketReference, freshOffer.quantity),
            message: freshOffer.message,
          },
        });

        // [L] — persist the reason the buyer picked in the counter UI.
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'OFFER_COUNTERED',
          resourceType: 'Offer',
          resourceId: counterOffer.id,
          metadata: {
            counteredBy: 'BUYER',
            parentOfferId: freshOffer.id,
            previousAmount: freshOffer.counterAmount ?? freshOffer.amount,
            counterAmount: numericCounter,
            reasonCode: req.body.reasonCode || null,
          },
        });

        return counterOffer;
      },
      { maxWait: 10000, timeout: 15000 }
    );

  return res.json({
    message:
      'Buyer counter-offer submitted successfully. The seller must respond next.',

    offer: updated,
  });
}

module.exports = { reCounter };
