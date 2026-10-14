const prisma = require('../../../config/db');
const { offerError, releaseAvailableAt, findLeafOffer } = require('../../../services/offers/offerHelpers');
const { noticeWaitingUnlocked, noticeBuyerReleased } = require('../../../services/waitingListService');
const { recordAuditEvent } = require('../../../utils/audit');

// SELLER RELEASES A SILENT BUYER (during negotiation — 72h)
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function releaseBuyer(req, res, ctx) {
  const { action, offer, isSeller, admin } = ctx;

  if (!isSeller && !admin) {
    return res.status(403).json({ error: 'Only the seller can release a buyer' });
  }

  const availableAt = releaseAvailableAt(offer);
  if (!availableAt) {
    return res.status(409).json({
      error: 'You can release a buyer only while you are waiting for the buyer to respond. Accept or counter the buyer\'s latest price instead.',
    });
  }
  if (!admin && availableAt.getTime() > Date.now()) {
    return res.status(409).json({
      error: `The buyer has not been inactive long enough. You can release this buyer from ${availableAt.toISOString()}.`,
      releaseAvailableAt: availableAt,
    });
  }

  const released = await prisma.$transaction(
    async (tx) => {
      const freshOffer = await findLeafOffer(tx, offer.id);
      if (!freshOffer) throw offerError('This negotiation has moved on. Refresh and try again.', 409);

      const freshAvailableAt = releaseAvailableAt(freshOffer);
      if (!freshAvailableAt || (!admin && freshAvailableAt.getTime() > Date.now())) {
        throw offerError('This negotiation changed. Refresh and try again.', 409);
      }

      const superseded = await tx.offer.count({ where: { parentOfferId: freshOffer.id } });
      if (superseded > 0) {
        throw offerError('This offer was superseded by a newer counter. Refresh and try again.', 409);
      }

      const updatedOffer = await tx.offer.update({
        where: { id: freshOffer.id },
        data: { status: 'WITHDRAWN' },
      });

      const remainingActiveLeafOffers = await tx.offer.count({
        where: {
          listingId: freshOffer.listingId,
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
          childOffers: { none: {} },
        },
      });

      if (remainingActiveLeafOffers === 0) {
        await tx.listing.update({
          where: { id: freshOffer.listingId },
          data: { status: 'ACTIVE' },
        });
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'OFFER_RELEASED',
        resourceType: 'Offer',
        resourceId: updatedOffer.id,
        metadata: {
          listingId: freshOffer.listingId,
          buyerId: freshOffer.buyerId,
          previousStatus: freshOffer.status,
          inactiveSince: freshOffer.updatedAt,
          remainingActiveLeafOffers,
        },
      });

      return updatedOffer;
    },
    { maxWait: 10000, timeout: 15000 }
  );

  await noticeBuyerReleased(prisma, { listingId: released.listingId, offerId: released.id, buyerId: released.buyerId });
  await noticeWaitingUnlocked(prisma, { listingId: released.listingId, reason: 'SELLER_RELEASED' });

  return res.json({
    message: 'Buyer released. You can now select another waiting bid.',
    offer: released,
  });
}

module.exports = { releaseBuyer };
