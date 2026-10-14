const prisma = require('../../../config/db');
const {
  offerError,
  provisionalReleaseAvailableAt,
  findLeafOffer,
  expireOfferIfNeeded,
} = require('../../../services/offers/offerHelpers');
const { moveOfferToProvisional } = require('../../../services/offers/offerOrderService');

// BUYER ACCEPTS SELECTED BID  →  PROVISIONAL
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function acceptSelected(req, res, ctx) {
  const { offer, isBuyer, admin } = ctx;

  if (!isBuyer && !admin) return res.status(403).json({ error: 'Only the buyer can accept a selected bid' });
  if (offer.status !== 'SELECTED') return res.status(400).json({ error: `Offer must be SELECTED before acceptance (current: ${offer.status})` });
  const result = await prisma.$transaction(async (tx) => {
    const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
    if (!fresh) throw offerError('This selected bid is no longer available', 409);
    if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
      throw offerError('This selected bid has expired and can no longer be accepted', 409);
    }
    if (fresh.status !== 'SELECTED') throw offerError('This selected bid is no longer available', 409);
    return moveOfferToProvisional(tx, fresh, Number(fresh.amount), req.user.id);
  }, { maxWait: 10000, timeout: 15000 });
  return res.json({
    message: 'Provisional agreement reached. Either party can confirm to create the order.',
    offer: result.offer,
    provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
  });
}

module.exports = { acceptSelected };
