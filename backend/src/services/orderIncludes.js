'use strict';

// ============================================================================
// ORDER PRISMA INCLUDES
// ============================================================================
//
// Shared `include` / `select` shapes used by routes/orders.js. Extracted so
// the same shapes can be reused from other files later without copy-paste.
//
// Same shape as before — pure relocation, no behavior change.
// ============================================================================

const userSelect = {
  id: true,
  name: true,
  phone: true,
  location: true,
  rating: true,
  verificationStatus: true,
};

// FIXED: truckOwner.phone is NOT selected here. Every viewer of the order
// page uses this include, and the buyer must never see the transporter's
// contact number. The seller needs it (physical handoff), the transporter
// obviously has their own, and admins need it for support — so it is added
// back per-request in applySealedBidVisibility() for those three roles only.
const transportInclude = {
  loadingReport: { include: { submittedBy: { select: { id: true, name: true } } } },
  truckOwner: { select: { id: true, name: true, rating: true, verificationStatus: true } },
  truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
  quotes: {
    include: {
      truckOwner: { select: { id: true, name: true, rating: true, verificationStatus: true } },
      truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
      _count: { select: { childQuotes: true } },
    },
    orderBy: { amount: 'asc' },
  },
};

// ============================================================================
// LIGHTWEIGHT include for the Orders list page (GET /)
// ============================================================================
const orderListInclude = {
  listing: {
    select: {
      id: true,
      cropType: true,
      title: true,
      photos: true,
    },
  },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: {
    select: {
      id: true,
      status: true,
      method: true,
    },
  },
  payments: {
    select: { id: true, type: true, status: true, amount: true, method: true },
  },
  _count: {
    select: { events: true, disputes: true, messages: true },
  },
};

// ============================================================================
// HEAVY include for the Order Detail page (GET /:id)
// ============================================================================
// Full inspection report for the order page, plus any addenda the inspector
// added after publishing (addendum media is not exposed here).
const REPORT_INCLUDE = {
  include: {
    addenda: {
      orderBy: { createdAt: 'asc' },
      select: { id: true, reason: true, notes: true, gpsLocation: true, createdAt: true },
    },
  },
};

const orderDetailInclude = {
  listing: {
    include: {
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        include: {
          report: REPORT_INCLUDE,
          inspector: { select: { id: true, name: true, phone: true } },
          payments: { select: { id: true, type: true, status: true, amount: true, method: true, reference: true } },
          quotes: {
            where: { status: { not: 'REJECTED' } },
            select: {
              id: true, inspectorId: true, amount: true, status: true, message: true,
              parentQuoteId: true, counterAmount: true, counteredBy: true, expiresAt: true, createdAt: true, updatedAt: true,
              inspector: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
              _count: { select: { childQuotes: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  },
  inspectionRequests: {
    where: { status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'desc' },
    include: {
      report: REPORT_INCLUDE,
      inspector: { select: { id: true, name: true, phone: true } },
      payments: { select: { id: true, type: true, status: true, amount: true, method: true, reference: true } },
      quotes: {
        where: { status: { not: 'REJECTED' } },
        select: {
          id: true, inspectorId: true, amount: true, status: true, message: true, parentQuoteId: true, counterAmount: true, counteredBy: true, expiresAt: true, createdAt: true, updatedAt: true,
          inspector: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
          _count: { select: { childQuotes: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
  agreedOffer: true,
  priceReviews: { include: { proposedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: { include: { ...transportInclude, loadingReport: true } },
  payments: {
    include: {
      ledgerEntries: true,
    },
  },
  paymentObligations: {
    include: {
      payment: { select: { id: true, status: true, amount: true, method: true, reference: true } },
      payer: { select: { id: true, name: true } },
      beneficiary: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    take: 50,
    include: { actor: { select: { id: true, name: true } } },
  },
  disputes: true,
  ratings: true,
  messages: { orderBy: { createdAt: 'asc' }, take: 50 },
  recoveryRequests: {
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
    take: 1,
    select: { id: true, type: true },
  },
};

module.exports = {
  userSelect,
  transportInclude,
  orderListInclude,
  orderDetailInclude,
};
