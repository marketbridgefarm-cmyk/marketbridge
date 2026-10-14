'use strict';

const prisma = require('../config/db');

// ============================================================================
// ORDER HELPERS
// ============================================================================
//
// Extracted from routes/orders.js. Two helpers that operate on a full order
// payload just before it leaves the server, plus one that snapshots pending
// bidders before a cancel.
//
// Same behavior, same call sites. Pure relocation.
// ============================================================================

// ============================================================================
// SEALED-BID VISIBILITY
// ============================================================================
// Applied to the outbound HTTP response only. It never touches the DB and it
// never runs before workflow/state computations, so the server still sees the
// full dataset internally.
//
// Transport quotes:
//   - Admin or the arranging party sees the full quote list and can negotiate.
//   - The assigned transporter sees only their own quotes.
//   - The OTHER buyer/seller — the one who did NOT arrange the transport —
//     receives only an aggregate summary.
//   - Any other viewer gets no transport quote data at all.
//
// Inspection quotes:
//   - Admin or the requester sees the full quote list.
//   - The assigned inspector sees only their own quotes.
//   - Any other viewer sees an empty quote list.
//
// FIXED: This helper is async because it re-hydrates the transporter's phone
// number for the three roles that legitimately need it (seller, assigned
// transporter, admin). The base transportInclude intentionally omits phone
// from truckOwner so the buyer never receives it.
async function applySealedBidVisibility(order, viewerId, viewerRoles = []) {
  if (!order) return order;
  const isAdminUser = Array.isArray(viewerRoles) && viewerRoles.includes('ADMIN');

  // ---- Transport quotes ---------------------------------------------------
  const job = order.transportJob;

  // FIXED: re-add the transporter's phone number for the three roles that
  // legitimately need it. The buyer receives only the name.
  if (job && job.truckOwner) {
    const isSellerOfOrder = order.sellerId === viewerId;
    const isAssignedTransporter = job.truckOwnerId === viewerId;
    if (isSellerOfOrder || isAssignedTransporter || isAdminUser) {
      const owner = await prisma.user.findUnique({
        where: { id: job.truckOwner.id },
        select: { phone: true },
      }).catch(() => null);
      if (owner?.phone) job.truckOwner.phone = owner.phone;
    }
  }

  if (job) {
    const isBuyer = order.buyerId === viewerId;
    const isSeller = order.sellerId === viewerId;
    const isArranging =
      (job.arrangingParty === 'SELLER' && isSeller) ||
      (job.arrangingParty === 'BUYER' && isBuyer) ||
      (job.arrangingParty === 'JOINT' && (isBuyer || isSeller));
    const isAssignedTruckOwner = job.truckOwnerId === viewerId;
    const allTransportQuotes = Array.isArray(job.quotes) ? job.quotes : [];

    if (!isAdminUser && !isArranging) {
      if (isAssignedTruckOwner) {
        job.quotes = allTransportQuotes.filter((q) => q.truckOwnerId === viewerId);
      } else if (isBuyer || isSeller) {
        const leafQuotes = allTransportQuotes.filter(
          (q) => (q._count?.childQuotes || 0) === 0
        );
        const liveQuotes = leafQuotes.filter((q) =>
          ['PENDING', 'WAITING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
        );
        const acceptedCount = liveQuotes.filter((q) => q.status === 'ACCEPTED').length;
        const transportPaid = (order.payments || []).some(
          (p) => p.type === 'TRANSPORT' && p.status === 'PAID'
        );

        job.quotes = [];
        job.quoteSummary = {
          bidderCount: liveQuotes.length,
          acceptedCount,
          transportPaid,
          agreedAmount: acceptedCount > 0 ? job.agreedAmount : null,
        };
      } else {
        job.quotes = [];
      }
    }
  }

  // ---- Inspection quotes --------------------------------------------------
  const inspectionLists = [
    ...(Array.isArray(order.inspectionRequests) ? order.inspectionRequests : []),
    ...(Array.isArray(order.listing?.inspectionRequests) ? order.listing.inspectionRequests : []),
  ];
  for (const request of inspectionLists) {
    if (!request || !Array.isArray(request.quotes)) continue;
    const isRequester = request.requestedById === viewerId;
    if (isAdminUser || isRequester) continue;
    const isAssignedInspector = request.inspectorId === viewerId;
    request.quotes = isAssignedInspector
      ? request.quotes.filter((q) => q.inspectorId === viewerId)
      : [];
  }

  return order;
}

// ============================================================================
// CAPTURE PENDING BIDDERS
// ============================================================================
// Captures the still-PENDING waiting bidders across inspection and transport
// scopes before an order is cancelled. cancelOrderInTransaction moves every
// PENDING quote to REJECTED inside its own transaction, so this snapshot must
// be taken before that runs and used to notify the bidders after commit.
async function capturePendingBidders(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      listingId: true,
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        select: {
          id: true,
          quotes: {
            where: { status: 'PENDING', childQuotes: { none: {} } },
            select: { id: true, inspectorId: true },
          },
        },
      },
      transportJob: {
        select: {
          id: true,
          status: true,
          quotes: {
            where: { status: 'PENDING', childQuotes: { none: {} } },
            select: { id: true, truckOwnerId: true },
          },
        },
      },
    },
  }).catch(() => null);
  return order;
}

module.exports = {
  applySealedBidVisibility,
  capturePendingBidders,
};
