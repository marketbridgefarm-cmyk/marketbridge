'use strict';

/**
 * Waiting list = PENDING (leaf) bids on a listing.
 *
 * Rules (product decision):
 *  - While one buyer is in exclusive negotiation, or an order exists that is not
 *    yet paid, the waiting list is LOCKED: the seller can neither select nor
 *    reject waiting bids. Waiting bidders may withdraw themselves.
 *  - The list unlocks when the buyer rejects, the seller releases a silent
 *    buyer, or the order is cancelled; the seller then selects another bidder.
 *  - When goods are paid/committed, remaining waiting bids are RELEASED
 *    (status WITHDRAWN, shown as "Released") and bidders are notified.
 *
 * Notices are best-effort. Call these helpers AFTER the main transaction has
 * committed (pass the normal prisma client) so that a notice failure can never
 * roll back or abort a negotiation/payment.
 */

const { recordAuditEvent } = require('../utils/audit');

async function listingLabel(db, listingId) {
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    select: { title: true, cropType: true },
  }).catch(() => null);
  return listing?.title || listing?.cropType || 'the listing';
}

async function waitingBids(db, listingId, exceptBuyerId = null) {
  return db.offer.findMany({
    where: {
      listingId,
      status: 'PENDING',
      childOffers: { none: {} },
      ...(exceptBuyerId ? { buyerId: { not: exceptBuyerId } } : {}),
    },
    select: { id: true, buyerId: true },
  });
}

async function createNotices(db, rows) {
  if (!rows.length) return;
  await db.offerNotification.createMany({ data: rows });
}

async function noticeWaitingLocked(db, { listingId, selectedOfferId, selectedBuyerId }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingBids(db, listingId, selectedBuyerId);
    const rows = [
      {
        userId: selectedBuyerId,
        listingId,
        offerId: selectedOfferId,
        type: 'BID_SELECTED',
        title: 'Your bid was selected',
        body: `The seller selected your bid on ${label}. You can now negotiate the price.`,
      },
      ...waiting.map((bid) => ({
        userId: bid.buyerId,
        listingId,
        offerId: bid.id,
        type: 'WAITING_LOCKED',
        title: 'Seller is negotiating with another buyer',
        body: `Your bid on ${label} stays on the waiting list. You will be notified if the listing opens up again. You can withdraw at any time.`,
      })),
    ];
    await createNotices(db, rows);
  } catch (error) {
    console.error('WAITING LIST LOCK NOTICE FAILED', error);
  }
}

async function noticeBuyerReleased(db, { listingId, offerId, buyerId }) {
  try {
    const label = await listingLabel(db, listingId);
    await createNotices(db, [{
      userId: buyerId,
      listingId,
      offerId,
      type: 'BUYER_RELEASED',
      title: 'The seller released your negotiation',
      body: `You did not respond in time, so the seller released your negotiation on ${label}. You can place a new bid if the listing is still open.`,
    }]);
  } catch (error) {
    console.error('BUYER RELEASE NOTICE FAILED', error);
  }
}

async function noticeWaitingUnlocked(db, { listingId, reason }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingBids(db, listingId);
    await createNotices(db, waiting.map((bid) => ({
      userId: bid.buyerId,
      listingId,
      offerId: bid.id,
      type: 'WAITING_UNLOCKED',
      title: 'The seller can select a new bid',
      body: `The previous negotiation on ${label} ended. The seller may now select a bid from the waiting list, including yours.`,
      metadata: { reason: reason || null },
    })));
  } catch (error) {
    console.error('WAITING LIST UNLOCK NOTICE FAILED', error);
  }
}

/**
 * Goods paid / purchase committed: release every waiting bid and notify.
 * Idempotent. Returns the number of released bids.
 */
async function releaseWaitingBidders(db, { listingId, actorId = null, reason = 'LISTING_COMMITTED' }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingBids(db, listingId);
    if (!waiting.length) return 0;

    await db.offer.updateMany({
      where: { id: { in: waiting.map((bid) => bid.id) }, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });

    await createNotices(db, waiting.map((bid) => ({
      userId: bid.buyerId,
      listingId,
      offerId: bid.id,
      type: 'WAITING_RELEASED',
      title: 'Your bid was released',
      body: `The goods on ${label} were paid for by another buyer, so your bid has been released. You can browse other listings.`,
      metadata: { reason },
    })));

    await recordAuditEvent(db, {
      actorId,
      action: 'WAITING_BIDS_RELEASED',
      resourceType: 'Listing',
      resourceId: listingId,
      metadata: { reason, releasedOfferIds: waiting.map((bid) => bid.id) },
    });
    return waiting.length;
  } catch (error) {
    console.error('WAITING LIST RELEASE FAILED', error);
    return 0;
  }
}

module.exports = { noticeWaitingLocked, noticeWaitingUnlocked, noticeBuyerReleased, releaseWaitingBidders };
