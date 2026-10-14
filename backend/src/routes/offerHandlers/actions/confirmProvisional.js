const prisma = require('../../../config/db');
const { offerError, findLeafOffer, expireOfferIfNeeded } = require('../../../services/offers/offerHelpers');
const { acceptOfferAndCreateOrder } = require('../../../services/offers/offerOrderService');

// CONFIRM PROVISIONAL → ORDER CREATED
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function confirmProvisional(req, res, ctx) {
  const { offer, isSeller, isBuyer, admin } = ctx;

  if (!isBuyer && !isSeller && !admin) {
    return res.status(403).json({ error: 'Only a participant can confirm the provisional agreement' });
  }
  if (offer.status !== 'PROVISIONAL') {
    return res.status(400).json({ error: `Offer must be PROVISIONAL before confirmation (current: ${offer.status})` });
  }

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
    if (!fresh) throw offerError('This provisional agreement is no longer available', 409);
    if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
      throw offerError('This provisional agreement has expired', 409);
    }
    if (fresh.status !== 'PROVISIONAL') {
      throw offerError('This provisional agreement is no longer available', 409);
    }

    const finalPrice =
      fresh.counteredBy != null && Number.isFinite(Number(fresh.counterAmount))
        ? Number(fresh.counterAmount)
        : Number(fresh.amount);

    return acceptOfferAndCreateOrder(tx, fresh, finalPrice, fresh.listing.sellerId, req.user.id);
  }, { maxWait: 10000, timeout: 15000 });

  return res.json({
    message: 'Provisional agreement confirmed and order created successfully',
    offer: result.offer,
    order: result.order,
    transportAutomaticallyAssigned: false,
  });
}

module.exports = { confirmProvisional };
