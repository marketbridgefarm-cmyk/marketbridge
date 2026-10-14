const prisma = require('../../../config/db');
const {
  offerError,
  releaseAvailableAt,
  provisionalReleaseAvailableAt,
  findLeafOffer,
} = require('../../../services/offers/offerHelpers');
const { parseReleaseReason, releaseAllowance, LIMIT_MESSAGE } = require('../../../services/releaseLimitsService');
const { noticeWaitingUnlocked, noticeBuyerReleased } = require('../../../services/waitingListService');
const { recordAuditEvent } = require('../../../utils/audit');

// RELEASE PROVISIONAL (24h cooldown + reason + cap for the seller)
// Called by routes/offerHandlers/respondToOffer.js; `ctx` carries the loaded offer
// and the caller's role flags (offer, sellerId, isSeller, isBuyer, admin).
async function releaseProvisional(req, res, ctx) {
  const { action, offer, sellerId, isSeller, isBuyer, admin } = ctx;

  if (!isBuyer && !isSeller && !admin) {
    return res.status(403).json({ error: 'Only a participant can release the provisional agreement' });
  }
  if (offer.status !== 'PROVISIONAL') {
    return res.status(400).json({ error: `Only a provisional agreement can be released (current: ${offer.status})` });
  }

  const availableAt = provisionalReleaseAvailableAt(offer);
  if (availableAt && !admin && availableAt.getTime() > Date.now()) {
    return res.status(409).json({
      error: `The provisional agreement was made recently. You can release it from ${availableAt.toISOString()}.`,
      releaseAvailableAt: availableAt,
    });
  }

  const isBuyerRelease = isBuyer;

  let releaseInfo;
  try {
    releaseInfo = parseReleaseReason(req.body, { provider: isBuyerRelease });
  } catch (limitErr) {
    return res.status(limitErr.statusCode || 400).json({ error: limitErr.message });
  }

  const released = await prisma.$transaction(async (tx) => {
    const lockedListings = await tx.$queryRaw`
      SELECT "id" FROM "Listing" WHERE "id" = ${offer.listingId} FOR UPDATE
    `;
    if (!lockedListings?.length) throw offerError('Listing not found', 404);

    let releaseNumber = null;
    if (isSeller && !admin) {
      const { used, allowed } = await releaseAllowance(tx, {
        action: 'OFFER_PROVISIONAL_RELEASED',
        metadataKey: 'listingId',
        jobId: offer.listingId,
      });
      if (used >= allowed) {
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'OFFER_RELEASE_BLOCKED_ADMIN_REVIEW',
          resourceType: 'Offer',
          resourceId: offer.id,
          metadata: {
            listingId: offer.listingId,
            sellerId: offer.sellerId,
            attemptedReason: releaseInfo.reason,
            releasesUsed: used,
            limit: allowed,
          },
        });
        return { blocked: true };
      }
      releaseNumber = used + 1;
    }

    const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
    if (!fresh || fresh.status !== 'PROVISIONAL') {
      throw offerError('This provisional agreement is no longer available', 409);
    }

    const freshAvailableAt = provisionalReleaseAvailableAt(fresh);
    if (freshAvailableAt && !admin && freshAvailableAt.getTime() > Date.now()) {
      throw offerError('This provisional agreement was made recently. Refresh and try again.', 409);
    }

    const updated = await tx.offer.update({
      where: { id: fresh.id },
      data: { status: 'WITHDRAWN' },
    });

    const remainingActiveLeafOffers = await tx.offer.count({
      where: {
        listingId: fresh.listingId,
        status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
        childOffers: { none: {} },
      },
    });
    if (remainingActiveLeafOffers === 0) {
      await tx.listing.update({ where: { id: fresh.listingId }, data: { status: 'ACTIVE' } });
    }

    await recordAuditEvent(tx, {
      actorId: req.user.id,
      action: isBuyerRelease
        ? 'OFFER_PROVISIONAL_RELEASED_BY_BUYER'
        : 'OFFER_PROVISIONAL_RELEASED',
      resourceType: 'Offer',
      resourceId: updated.id,
      metadata: {
        listingId: fresh.listingId,
        buyerId: fresh.buyerId,
        sellerId: fresh.sellerId,
        releasedBy: isBuyerRelease ? 'BUYER' : 'SELLER',
        reason: releaseInfo.reason,
        note: releaseInfo.note,
        releaseNumber,
        remainingActiveLeafOffers,
      },
    });

    return updated;
  }, { maxWait: 10000, timeout: 15000 });

  if (released && released.blocked) {
    return res.status(409).json({ error: LIMIT_MESSAGE, code: 'RELEASE_LIMIT_REACHED' });
  }

  await noticeBuyerReleased(prisma, {
    listingId: released.listingId,
    offerId: released.id,
    buyerId: released.buyerId,
  }).catch(() => {});
  await noticeWaitingUnlocked(prisma, {
    listingId: released.listingId,
    reason: 'PROVISIONAL_RELEASED',
  }).catch(() => {});

  return res.json({
    message: 'Provisional agreement released. Other waiting bids are available again.',
    offer: released,
  });
}

module.exports = { releaseProvisional };
