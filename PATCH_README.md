# MarketBridge recovery and offers patch

This ZIP contains complete replacement files for the three changed source files. Copy them over the same paths in the existing repository.

## Included changes

1. `backend/src/routes/recoveryRequests.js`
   - Recovery eligibility reads the authoritative `Dispute` record (`RESOLVED`) instead of relying on an OrderEvent that the dispute resolver does not currently create.
   - Recognizes a genuine service cancellation or relevant provider withdrawal, while avoiding resetting a live competition just because a losing bidder withdrew.
   - Blocks recovery eligibility while an inspection/transport payment is pending, processing, or paid; the service payment/refund must be resolved before a fresh competition can be released.
   - Keeps the admin approval step and existing audit/event logging in place.

2. `backend/src/routes/offers.js`
   - Adds authenticated `GET /api/offers/received` for the seller's own received offers, fixing the frontend's 404 request.
   - Returns paginated offers with buyer/listing summaries and does not expose other sellers' bids.

3. `frontend/src/pages/OrderDetail.jsx`
   - Shows the admin-reviewed fresh inspection form action when recovery is eligible.
   - Keeps cancelled transport jobs visible so the buyer/seller can request recovery rather than silently treating the job as absent.
   - Disables recovery actions when the backend says the service is not eligible or a request is already pending.
   - Explains that a new form requires a recorded cancellation/withdrawal/resolved dispute and that any service payment/refund must be settled first.
   - Derives the inspection form's released state from current recovery eligibility, avoiding a stale prior approval from hiding a later cancellation.

## Validation

- `node --check backend/src/routes/recoveryRequests.js` passed.
- `node --check backend/src/routes/offers.js` passed.
- The frontend production build could not be run in this environment because the dependency installation did not complete (`vite: not found`). Run `npm ci && npm run build` in `frontend`, and run backend tests/Prisma integration tests in CI or staging before deployment.
- No database migration is introduced by these changes.
