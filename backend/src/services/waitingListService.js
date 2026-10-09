'use strict';

/**
 * Waiting list = PENDING (leaf) bids on a listing, an inspection request, or
 * a transport job.
 *
 * Rules (unified across all three flows):
 *  - While one bidder is in exclusive negotiation, or a provisional deal is
 *    live, the waiting list is LOCKED: the requester cannot select another
 *    waiting bid until the provisional deal is released/rejected/withdrawn.
 *    Waiting bidders may withdraw themselves at any time.
 *  - The list UNLOCKS when the provisional deal collapses; the requester may
 *    then select another waiting bid.
 *  - The list is RELEASED (permanently) only at the flow's terminal event:
 *        Offers      -> goods committed (MARKETPLACE paid)
 *        Inspections -> report submitted (INSPECTION_COMPLETED)
 *        Transport   -> goods delivered (DELIVERED)
 *    Remaining waiting bids become WITHDRAWN ("Released") and bidders are
 *    notified.
 *
 * Notices are best-effort. Call these helpers AFTER the main transaction has
 * committed (pass the normal prisma client) so that a notice failure can never
 * roll back or abort a negotiation/payment.
 *
 * Caller list (authoritative — keep in sync with the routes):
 *   - inspections.js: select, withdraw (silent + accepted), report, cancel
 *   - transport.js:   select, withdraw (silent + accepted), DELIVERED, reopen-bidding
 *   - recovery-requests.js: admin approve
 *   - orders.js:      cancel (fans out to all three scopes)
 *   - paymentService.js: MARKETPLACE PAID (releases offers)
 */

const { recordAuditEvent } = require('../utils/audit');

// ============================================================================
// LABEL HELPERS (per scope, so each notice reads naturally)
// ============================================================================

async function listingLabel(db, listingId) {
  const listing = await db.listing
    .findUnique({
      where: { id: listingId },
      select: { title: true, cropType: true },
    })
    .catch(() => null);
  return listing?.title || listing?.cropType || 'the listing';
}

async function inspectionLabel(db, inspectionRequestId) {
  const request = await db.inspectionRequest
    .findUnique({
      where: { id: inspectionRequestId },
      select: {
        listing: { select: { title: true, cropType: true } },
        location: true,
      },
    })
    .catch(() => null);
  return (
    request?.listing?.title ||
    request?.listing?.cropType ||
    request?.location ||
    'the inspection request'
  );
}

async function transportLabel(db, transportJobId) {
  const job = await db.transportJob
    .findUnique({
      where: { id: transportJobId },
      select: { load: true, pickupLocation: true, destination: true },
    })
    .catch(() => null);
  if (job?.load) return job.load;
  if (job?.pickupLocation && job?.destination) {
    return `${job.pickupLocation} → ${job.destination}`;
  }
  return 'the transport job';
}

// ============================================================================
// WAITING BIDDER QUERIES (leaf-only, per scope)
// ============================================================================

async function waitingOffers(db, listingId, exceptBuyerId = null) {
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

async function waitingInspectionQuotes(db, inspectionRequestId, exceptInspectorId = null) {
  return db.inspectionQuote.findMany({
    where: {
      inspectionRequestId,
      status: 'PENDING',
      childQuotes: { none: {} },
      ...(exceptInspectorId ? { inspectorId: { not: exceptInspectorId } } : {}),
    },
    select: { id: true, inspectorId: true },
  });
}

async function waitingTransportQuotes(db, transportJobId, exceptTruckOwnerId = null) {
  return db.transportQuote.findMany({
    where: {
      transportJobId,
      status: 'PENDING',
      childQuotes: { none: {} },
      ...(exceptTruckOwnerId ? { truckOwnerId: { not: exceptTruckOwnerId } } : {}),
    },
    select: { id: true, truckOwnerId: true },
  });
}

// ============================================================================
// NOTICE WRITERS
// ============================================================================

async function createOfferNotices(db, rows) {
  if (!rows.length) return;
  await db.offerNotification.createMany({ data: rows });
}

async function createInspectionNotices(db, rows) {
  if (!rows.length) return;
  await db.inspectionNotification.createMany({ data: rows });
}

async function createTransportNotices(db, rows) {
  if (!rows.length) return;
  await db.transportNotification.createMany({ data: rows });
}

// ============================================================================
// OFFERS — LOCK / UNLOCK / RELEASE  (existing signatures preserved)
// ============================================================================

async function noticeWaitingLocked(db, { listingId, selectedOfferId, selectedBuyerId }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingOffers(db, listingId, selectedBuyerId);
    await createOfferNotices(db, [
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
    ]);
  } catch (error) {
    console.error('WAITING LIST LOCK NOTICE FAILED', error);
  }
}

async function noticeWaitingUnlocked(db, { listingId, reason }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingOffers(db, listingId);
    await createOfferNotices(db, waiting.map((bid) => ({
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

async function noticeBuyerReleased(db, { listingId, offerId, buyerId }) {
  try {
    const label = await listingLabel(db, listingId);
    await createOfferNotices(db, [{
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

async function releaseWaitingBidders(db, { listingId, actorId = null, reason = 'LISTING_COMMITTED' }) {
  try {
    const label = await listingLabel(db, listingId);
    const waiting = await waitingOffers(db, listingId);
    if (!waiting.length) return 0;

    await db.offer.updateMany({
      where: { id: { in: waiting.map((bid) => bid.id) }, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });

    await createOfferNotices(db, waiting.map((bid) => ({
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

// ============================================================================
// INSPECTIONS — LOCK / UNLOCK / RELEASE
// ============================================================================

async function noticeInspectionWaitingLocked(db, { inspectionRequestId, selectedQuoteId, selectedInspectorId }) {
  try {
    const label = await inspectionLabel(db, inspectionRequestId);
    const waiting = await waitingInspectionQuotes(db, inspectionRequestId, selectedInspectorId);
    await createInspectionNotices(db, [
      {
        userId: selectedInspectorId,
        inspectionRequestId,
        quoteId: selectedQuoteId,
        type: 'BID_SELECTED',
        title: 'Your inspection quote was selected',
        body: `The requester selected your quote on ${label}. You can now negotiate the fee.`,
      },
      ...waiting.map((q) => ({
        userId: q.inspectorId,
        inspectionRequestId,
        quoteId: q.id,
        type: 'WAITING_LOCKED',
        title: 'Another inspector is negotiating',
        body: `Your quote on ${label} stays on the waiting list. You will be notified if the requester returns to your bid. You can withdraw at any time.`,
      })),
    ]);
  } catch (error) {
    console.error('INSPECTION WAITING LIST LOCK NOTICE FAILED', error);
  }
}

async function noticeInspectionWaitingUnlocked(db, { inspectionRequestId, reason }) {
  try {
    const label = await inspectionLabel(db, inspectionRequestId);
    const waiting = await waitingInspectionQuotes(db, inspectionRequestId);
    if (!waiting.length) return;
    await createInspectionNotices(db, waiting.map((q) => ({
      userId: q.inspectorId,
      inspectionRequestId,
      quoteId: q.id,
      type: 'WAITING_UNLOCKED',
      title: 'The requester can select a new inspector',
      body: `The previous inspection negotiation on ${label} ended. The requester may now select another quote, including yours.`,
      metadata: { reason: reason || null },
    })));
  } catch (error) {
    console.error('INSPECTION WAITING LIST UNLOCK NOTICE FAILED', error);
  }
}

async function releaseWaitingInspectors(db, { inspectionRequestId, actorId = null, reason = 'INSPECTION_COMPLETED' }) {
  try {
    const label = await inspectionLabel(db, inspectionRequestId);
    const waiting = await waitingInspectionQuotes(db, inspectionRequestId);
    if (!waiting.length) return 0;

    await db.inspectionQuote.updateMany({
      where: { id: { in: waiting.map((q) => q.id) }, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });

    await createInspectionNotices(db, waiting.map((q) => ({
      userId: q.inspectorId,
      inspectionRequestId,
      quoteId: q.id,
      type: 'WAITING_RELEASED',
      title: 'Your inspection quote was released',
      body: `The inspection on ${label} was completed by another inspector, so your quote has been released.`,
      metadata: { reason },
    })));

    await recordAuditEvent(db, {
      actorId,
      action: 'WAITING_INSPECTION_QUOTES_RELEASED',
      resourceType: 'InspectionRequest',
      resourceId: inspectionRequestId,
      metadata: { reason, releasedQuoteIds: waiting.map((q) => q.id) },
    });
    return waiting.length;
  } catch (error) {
    console.error('INSPECTION WAITING LIST RELEASE FAILED', error);
    return 0;
  }
}

// ============================================================================
// TRANSPORT — LOCK / UNLOCK / RELEASE
// ============================================================================

async function noticeTransportWaitingLocked(db, { transportJobId, selectedQuoteId, selectedTruckOwnerId }) {
  try {
    const label = await transportLabel(db, transportJobId);
    const waiting = await waitingTransportQuotes(db, transportJobId, selectedTruckOwnerId);
    await createTransportNotices(db, [
      {
        userId: selectedTruckOwnerId,
        transportJobId,
        quoteId: selectedQuoteId,
        type: 'BID_SELECTED',
        title: 'Your transport bid was selected',
        body: `The arranger selected your bid on ${label}. You can now negotiate the fee.`,
      },
      ...waiting.map((q) => ({
        userId: q.truckOwnerId,
        transportJobId,
        quoteId: q.id,
        type: 'WAITING_LOCKED',
        title: 'Another transporter is negotiating',
        body: `Your bid on ${label} stays on the waiting list. You will be notified if the arranger returns to your bid. You can withdraw at any time.`,
      })),
    ]);
  } catch (error) {
    console.error('TRANSPORT WAITING LIST LOCK NOTICE FAILED', error);
  }
}

async function noticeTransportWaitingUnlocked(db, { transportJobId, reason }) {
  try {
    const label = await transportLabel(db, transportJobId);
    const waiting = await waitingTransportQuotes(db, transportJobId);
    if (!waiting.length) return;
    await createTransportNotices(db, waiting.map((q) => ({
      userId: q.truckOwnerId,
      transportJobId,
      quoteId: q.id,
      type: 'WAITING_UNLOCKED',
      title: 'The arranger can select a new transporter',
      body: `The previous transport negotiation on ${label} ended. The arranger may now select another bid, including yours.`,
      metadata: { reason: reason || null },
    })));
  } catch (error) {
    console.error('TRANSPORT WAITING LIST UNLOCK NOTICE FAILED', error);
  }
}

async function releaseWaitingTransporters(db, { transportJobId, actorId = null, reason = 'TRANSPORT_DELIVERED' }) {
  try {
    const label = await transportLabel(db, transportJobId);
    const waiting = await waitingTransportQuotes(db, transportJobId);
    if (!waiting.length) return 0;

    await db.transportQuote.updateMany({
      where: { id: { in: waiting.map((q) => q.id) }, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });

    await createTransportNotices(db, waiting.map((q) => ({
      userId: q.truckOwnerId,
      transportJobId,
      quoteId: q.id,
      type: 'WAITING_RELEASED',
      title: 'Your transport bid was released',
      body: `The transport on ${label} was delivered by another transporter, so your bid has been released.`,
      metadata: { reason },
    })));

    await recordAuditEvent(db, {
      actorId,
      action: 'WAITING_TRANSPORT_QUOTES_RELEASED',
      resourceType: 'TransportJob',
      resourceId: transportJobId,
      metadata: { reason, releasedQuoteIds: waiting.map((q) => q.id) },
    });
    return waiting.length;
  } catch (error) {
    console.error('TRANSPORT WAITING LIST RELEASE FAILED', error);
    return 0;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Offers (existing signatures preserved — no call-site breakage)
  noticeWaitingLocked,
  noticeWaitingUnlocked,
  noticeBuyerReleased,
  releaseWaitingBidders,

  // Inspections
  noticeInspectionWaitingLocked,
  noticeInspectionWaitingUnlocked,
  releaseWaitingInspectors,

  // Transport
  noticeTransportWaitingLocked,
  noticeTransportWaitingUnlocked,
  releaseWaitingTransporters,
};
