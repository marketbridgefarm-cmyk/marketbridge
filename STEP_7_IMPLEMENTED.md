# MarketBridge — Step 7 Implementation

## Implemented

1. **Buy Now concurrency hardening**
   - Uses a database-authoritative conditional `ACTIVE -> SOLD` claim.
   - Only the transaction that successfully claims the listing may create the order.
   - Preserves existing idempotency middleware and business rules.

2. **Negotiated-offer acceptance concurrency hardening**
   - Acceptance now conditionally claims the listing before creating the order.
   - Concurrent acceptance of different offers for the same listing cannot both create orders.
   - Cancelled historical orders do not block a new sale, while active/non-cancelled orders still do.

3. **Public advertisement media hardening**
   - Active-ad listing photos/videos are no longer returned as raw private storage keys.
   - Private object-storage references are converted to short-lived signed URLs.
   - Existing public HTTPS media URLs remain supported for backwards compatibility.

4. **Integration test corrections**
   - Notification fixture now matches the current Listing schema (`askingPrice`, `unit`).
   - Refresh-session integration test now imports the Express app using the actual module export.

## Files to replace

- `backend/src/routes/orders.js`
- `backend/src/routes/offers.js`
- `backend/src/routes/ads.js`
- `backend/test/notifications.test.js`
- `backend/test/auth.sessions.test.js`

## Validation

JavaScript syntax checks passed for all five changed files.

`npm test` was also attempted. The non-database tests reached the expected opt-in skips, but the security test could not load `jsonwebtoken` because dependencies were not installed in the extracted working copy. `npm ci` could not complete within the available execution window, so a full dependency-backed test run remains to be executed in the GitHub/Render environment.
