# MarketBridge: audit and cumulative changes (this session)

Copy every file in this zip over the same path in your repo. Nothing here was run against a
database or the real Chapa API (the sandbox had no network and no node_modules).

## Changed / new files
| Area | Files |
|---|---|
| Backend wiring | `backend/src/index.js` mounts 6 previously unmounted routers (inspection + transport quotes, coordination, evidence) |
| Offers split | `backend/src/routes/offers.js` (thin router), `routes/offerHandlers/*`, `services/offers/*`; includes the new `GET /api/offers/received` |
| Inspection report | `services/orderIncludes.js` (adds addenda), `order-details/InspectionCard.jsx`, `components/EvidenceGallery.jsx` |
| Order page | `pages/OrderDetail.jsx`, `components/ActionCenter.jsx` (placement, props, status label) |
| Transport dashboard split | `pages/TruckOwnerDashboard.jsx`, `hooks/useTruckOwnerDashboard.js`, `components/truckOwner/*` |
| Admin MFA | `pages/AdminSecuritySettings.jsx` (endpoints and payloads fixed), `routes/auth.js` (new `POST /auth/mfa/backup-codes/regenerate`) |
| Prisma | `backend/prisma/schema.prisma` adds the growth models that the existing migration already creates |

## What the static audit checked
- `node --check` on every backend file: clean. Relative `require()`s all resolve (except the test issue below).
- TypeScript `checkJs` undefined-name pass over all of `backend/src`: clean.
- All 241 frontend `api.*` calls vs the 212 routes actually mounted: now every call has a matching route.
  Before these changes, 9+ did not (quotes/evidence/coordination, offers/received, admin MFA, ...).
- Payment webhooks (`/webhooks/chapa`, `/webhooks/generic`) verify an HMAC over the raw body with a constant-time
  compare, fail closed when the secret is missing, and re-verify with Chapa before marking paid.
  SMS inbound needs a shared secret. No hard-coded secret fallbacks found. Production env validation exists.
- Auth-less routes are only the expected public ones (login/register/refresh/reset, public listings, ads, webhooks).

## Fixed here
1. Six route files were never mounted, so their endpoints returned 404.
2. `GET /api/offers/received` was missing (seller dashboard showed no received offers).
3. Admin MFA page called endpoints/payloads the backend doesn't have; regenerate endpoint added
   (needs password + current authenticator code, rate limited).
4. `growth.js` uses `PromotionCode`, `PromotionRedemption`, `ReferralCode`, `ReferralClaim` and
   `Order.discountAmount/promotionCodeId`, which exist in a migration but not in `schema.prisma`, so the
   generated client lacked them and those endpoints would have thrown. Models added (pure additions).
5. Buyer saw only 3 of the inspection report fields; now sees all, plus evidence and addenda.

## Still open (not changed)
- **Delete `backend/test/installmentService.js`.** It is an identical copy of `src/services/installmentService.js`
  sitting in `test/`. `node --test` executes it and it fails on `require('../config/db')`, so `npm test` is red.
- Delete `backend/src/utils/chapaCheckout.js`: it is a browser/frontend file (imports `../api/client`), unused in the backend.
- `backend/src/middleware/offers.js` is an unused stale copy of the old router.
- The order API still returns raw report photo/video storage keys to buyers before payment unlocks media.
- `GET /offers/listing/:id` returns the buyer's phone number to the seller; check that against your contact-sharing policy.
- Refresh cookie is `SameSite=None; Secure` in production. I did not verify CSRF protection on `/auth/refresh`.
- Everything below under "Before real users" is still required.

## Before real users (you need to run these)
```bash
cd backend && npm ci && npx prisma validate && npx prisma generate
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DB"   # expect: no drift
npm test            # after deleting test/installmentService.js
cd ../frontend && npm ci && npm run build
```
Then: staging with Chapa test mode through every role's full path, an independent review of payment and
authorization code, backup/restore drill, legal/payment-licence review, and a small closed pilot with manual payout checks.
