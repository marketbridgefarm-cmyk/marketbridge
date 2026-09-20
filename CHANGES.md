# MarketBridge — Complete Enhancements Patch

Date: 2026-09-20

This package consolidates the current MarketBridge enhancements into complete replacement files so they can be copied into the GitHub repository without merging fragments from earlier steps.

## Included fixes and enhancements

### 1. Seller payout protection / 3-day hold
- Seller payout is created when a verified MARKETPLACE payment settles PAID.
- Default hold is 3 days (`SELLER_PAYOUT_HOLD_DAYS=3`).
- `HELD -> RELEASED -> PAID_OUT` lifecycle is tracked.
- Disputes freeze the payout as `ON_HOLD_DISPUTE`.
- Seller-favorable dispute resolution restarts a fresh 3-day hold.
- Seller-unfavorable dispute resolution can permanently move the payout to `CANCELLED`.
- Admin payout completion requires `RELEASED` and records a payout reference.
- Maintenance scheduler automatically releases due holds.

### 2. Seller payout is visible on Order Details
- Order API now returns a controlled `sellerPayout` view.
- Seller/admin can see payout amount/reference.
- Buyer and other authorized participants can see hold/release status and timing without seeing the seller's net payout amount/reference.
- Order Details explicitly states the 3-day hold before payment, while HELD, dispute-held, RELEASED, CANCELLED and PAID_OUT states have separate messaging.
- Removed the unnecessary persistent red buyer-payment-control error banner.

### 3. Chapa checkout actually redirects
- Complete `chapaCheckout.js` is included.
- Payment creation is followed by `/payments/:id/chapa/initialize`.
- The returned hosted checkout URL is assigned to `window.location`.
- PROCESSING payments are treated as active duplicates so concurrent payment attempts cannot create a second checkout intent.

### 4. Payment/idempotency hardening
- Existing idempotency/P2002 handling remains in the central payment service.
- PROCESSING is included in duplicate-payment protection.
- Provider initialization claims the payment before contacting Chapa and returns it to PENDING if provider initialization fails.

### 5. Public listing privacy
- Public listing responses use an explicit allow-list.
- Seller minimum acceptable price is not exposed.
- Private negotiation/order/inspection information remains participant-controlled.
- Signed media URLs are used for public-approved media.
- Fixed the media-signing error path that referenced an out-of-scope `req` variable.

### 6. Inspector reputation
- Inspector ratings are accepted and validated against completed inspection participation.
- Inspector reputation endpoint is included.

### 7. Market price trends
- `GET /listings/market-trends` aggregates recent completed/delivered agricultural sale prices by crop, region and unit.

### 8. Transport backhaul matching
- Active route destinations can contribute a matching bonus when they align with a new pickup area.
- Only committed route states are considered.

### 9. SMS listing creation
- Inbound `LIST` and `ACTIVATE` commands are included.
- Inbound SMS is fail-closed behind `SMS_INBOUND_WEBHOOK_SECRET`.
- SMS-created listings start as DRAFT and require explicit activation.

### 10. Existing deployment protection
- `backend/src/utils/evidenceUpload.js` is included at the exact required path/case to prevent the previous Render module-not-found failure.
- Sidebar remains hidden for signed-out visitors.
- Negotiations remains a single hub for produce, transport and inspection negotiations.

## New migration

Apply both payout migrations in order:

1. `202609200001_seller_payouts`
2. `202609200002_seller_payout_dispute_outcome`

The second migration adds `CANCELLED` to `SellerPayoutStatus`.

## Environment

Set at least:

```text
SELLER_PAYOUT_HOLD_DAYS=3
MARKETBRIDGE_JOBS_ENABLED=true
SMS_INBOUND_WEBHOOK_SECRET=<strong-random-secret>
```

The existing Chapa variables must also be configured for live checkout:

```text
CHAPA_SECRET_KEY=<server-secret>
APP_BASE_URL=<frontend-url>
API_BASE_URL=<backend-url>
```

## Dispute resolution API change

When a dispute has a frozen seller payout, the admin resolution request must include one of:

```json
{"payoutDecision":"RELEASE"}
```

or

```json
{"payoutDecision":"CANCEL"}
```

`RELEASE` restarts the complete 3-day hold. `CANCEL` permanently prevents that payout record from being released.

## Deployment sequence

Backend:

```bash
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm test
```

Frontend:

```bash
cd frontend
npm ci
npm run build
```

The repository's Render build script already runs Prisma migration deployment.

## Verification performed in this environment

- Backend syntax checks passed for all touched backend files.
- Seller payout unit tests passed: 5/5.
- The full Node test suite was attempted. Tests that do not require external dependencies ran successfully; two existing test files could not load because `node_modules` is not installed in this working environment (`express-rate-limit` and `jsonwebtoken` were missing).
- Prisma validation/generation could not be completed here because the local Prisma executable/dependencies were unavailable; an attempted `npx prisma validate` timed out. Run `npm ci` followed by `npx prisma generate` and `npx prisma migrate deploy` in the repository/CI environment before production deployment.
- Frontend production build could not be executed here because `frontend/node_modules` is not installed.
