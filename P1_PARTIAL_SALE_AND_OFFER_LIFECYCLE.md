# P1 — Partial-Sale Order Uniqueness + Offer Lifecycle Hardening

## Fixes

1. A listing can have one live/provisional order at a time, while historical COMPLETED orders no longer block future partial sales.
2. PENDING/COUNTERED offers that are expired cannot be selected, accepted, or countered at the transaction mutation point.
3. Waiting-buyer promotion expires stale PENDING offers before selecting the next valid buyer.
4. A provisional winner's ACCEPTED offer is changed to WITHDRAWN when its PENDING_PAYMENT order is cancelled, so the stale negotiation cannot block a new offer.
5. PRODUCT offers now enforce the same available-quantity check already used for AGRICULTURAL listings.

## Migration preflight

Run `backend/prisma/202610010005_partial_sale_order_uniqueness_preflight.sql` first. It must return zero rows.

The migration then replaces the old partial unique index with:

`WHERE status NOT IN ('CANCELLED', 'COMPLETED')`

This permits multiple historical completed partial-sale orders for the same listing while preserving one live/provisional order at a time.

## Verification

- `node --check backend/src/routes/offers.js` — passed.
- `node --check backend/src/services/orderCancellationService.js` — passed.
- Prisma CLI validation was not run because the extracted repository does not contain installed `node_modules`; the migration SQL is supplied separately for production preflight.
