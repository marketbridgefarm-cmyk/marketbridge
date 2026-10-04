# MarketBridge — Offers & Negotiation Enabled Package

This package enables the existing negotiation workflows without replacing the
underlying business architecture.

## Enabled workflows

### Marketplace Offers
- Buyer creates an offer.
- Seller selects a buyer offer.
- Seller accepts or rejects.
- Seller counters.
- Buyer re-counters.
- Buyer accepts seller counter.
- Every counter creates a new historical Offer row.
- `parentOfferId` preserves the complete negotiation chain.

### Inspection Quotes
- Buyer/requester can review/select quotes.
- Inspector/provider can accept/reject/counter.
- Requester/provider quote counters remain historical child rows.
- Multiple inspectors can compete on the same inspection request.

### Transport Quotes
- Requester can review/select competing transport quotes.
- Provider can accept/reject/counter.
- Requester/provider quote counters remain historical child rows.
- Multiple transport providers can compete on the same transport job.

## Critical database correction

The migration `202610040002_restore_offer_negotiation_history` removes the
incorrect `Offer_active_buyer_listing_unique` partial unique index introduced
by `202610040001`.

The application-level active-leaf check remains responsible for preventing a
buyer from opening two independent negotiations for the same listing.

Do NOT convert counter creation from `create()` to `update()` and do NOT remove
`parentOfferId`.

## Included files

Backend:
- `backend/prisma/schema.prisma`
- `backend/src/routes/offers.js`
- `backend/src/routes/inspections.js`
- `backend/src/routes/transport.js`
- `backend/prisma/migrations/202610040002_restore_offer_negotiation_history/migration.sql`

Frontend:
- `frontend/src/pages/Negotiations.jsx`
- `frontend/src/pages/ListingDetail.jsx`
- `frontend/src/pages/Dashboard.jsx`
- `frontend/src/pages/InspectorDashboard.jsx`
- `frontend/src/pages/TruckOwnerDashboard.jsx`
- `frontend/src/pages/OrderDetail.jsx`
- `frontend/src/pages/negotiations/Negotiations.css`

These are complete replacement files from the uploaded MarketBridge package,
with only the Offer P2002 handling and the new safe migration changed.
