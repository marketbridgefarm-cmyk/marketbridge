const prisma = require('../../../config/db');
const { offerError, findLeafOffer } = require('../../../services/offers/offerHelpers');
const { noticeWaitingUnlocked } = require('../../../services/waitingListService');
const { recordAuditEvent } = require('../../../utils/audit');

// REJECT (buyer only) / WITHDRAW (buyer only, waiting bid)
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function rejectOrWithdraw(req, res, ctx) {
  const { action, offer, isSeller, isBuyer, admin } = ctx;

  const isWithdraw = action === 'WITHDRAW';

  if (isSeller && !admin) {
    return res.status(403).json({
      error: 'Sellers cannot reject bids. Select, accept or counter. If a selected buyer stays silent you can release them after the inactivity period. Waiting bids stay locked until the negotiation or order ends.',
    });
  }

  if (!isBuyer && !admin) {
    return res.status(403).json({ error: 'Only the buyer can do this' });
  }

  const allowedStatuses = isWithdraw ? ['PENDING'] : ['SELECTED', 'COUNTERED'];
  if (!allowedStatuses.includes(offer.status)) {
    return res.status(400).json({
      error: isWithdraw
        ? `Only a waiting bid can be withdrawn (current: ${offer.status})`
        : `Offer cannot be rejected because it is ${offer.status}`,
    });
  }

  const terminalStatus = isWithdraw ? 'WITHDRAWN' : 'REJECTED';

  const result =
    await prisma.$transaction(
      async (tx) => {
        const freshOffer = await findLeafOffer(tx, offer.id, { include: { listing: true } });

        if (!freshOffer) {
          throw offerError('This negotiation has moved on. Refresh and try again.', 409);
        }

        if (!allowedStatuses.includes(freshOffer.status)) {
          throw offerError(
            `Offer is no longer ${allowedStatuses.join('/')} (current: ${freshOffer.status})`,
            409
          );
        }

        const superseded = await tx.offer.count({ where: { parentOfferId: freshOffer.id } });
        if (superseded > 0) {
          throw offerError('This offer was superseded by a newer counter. Refresh and try again.', 409);
        }

        const updatedOffer =
          await tx.offer.update({
            where: { id: freshOffer.id },
            data: { status: terminalStatus },
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
          action: isWithdraw ? 'OFFER_WITHDRAWN' : 'OFFER_REJECTED',
          resourceType: 'Offer',
          resourceId: updatedOffer.id,
          metadata: {
            listingId: freshOffer.listingId,
            buyerId: freshOffer.buyerId,
            previousStatus: freshOffer.status,
            remainingActiveLeafOffers,
          },
        });

        return updatedOffer;
      },
      { maxWait: 10000, timeout: 15000 }
    );

  if (!isWithdraw) {
    await noticeWaitingUnlocked(prisma, { listingId: result.listingId, reason: 'BUYER_REJECTED' });
  }

  return res.json({
    message: isWithdraw
      ? 'You left the waiting list.'
      : 'Offer rejected. The seller can now select another waiting bid.',
    offer: result,
  });
}

module.exports = { rejectOrWithdraw };
