# MarketBridge — New Functionality Patch

Implements the five feature suggestions from the enhancement review, against
the marketbridge.zip codebase you last uploaded. Files here are a **patch**,
not a full repo — copy them over the matching paths and re-run
`prisma migrate deploy` (new migration `202609200001_seller_payouts`) before
starting the backend.

## 1. Seller payout hold / release / pay-out (escrow-style)
New: `services/sellerPayoutService.js`, `SellerPayout` model + migration.
Modified: `paymentService.js` (creates the hold the moment a MARKETPLACE
payment settles PAID), `disputes.js` (freezes the hold when a dispute is
raised, restarts the cool-off window when one resolves),
`maintenanceService.js` + `routes/maintenance.js` (auto-releases HELD
payouts past `releaseAt`, default 3 days — override with
`SELLER_PAYOUT_HOLD_DAYS`), `routes/admin.js` (`GET /admin/payouts`,
`PATCH /admin/payouts/:id/pay-out`).

This does **not** move money — there's no payout provider integration here.
It's an auditable worklist so your ops process has something to check
("who's safe to pay, who already got paid") instead of tracking it outside
the app entirely.

## 2. Market price trends
New: `GET /listings/market-trends?cropType=&region=&days=90` in
`routes/listings.js`. Aggregates completed-order prices (DELIVERED/COMPLETED)
by crop type/region/unit — average, median, min, max, sample size — computed
from existing Order/Listing data, no schema change. Flagged in-code: this
reduces in JS rather than a DB-side aggregate, which is fine at current
volume but is the first thing to revisit if it ever gets slow.

## 3. Transport backhaul/route matching
Modified: `services/transportMatchingService.js`. `matchTrucks()` (used by
the existing `GET /transport/match`) now also checks whether a candidate
truck's owner has an active job (ACCEPTED/PICKUP/IN_TRANSIT) whose
destination lands near the new job's pickup point — a real backhaul
opportunity, not just a claimed operating area — and scores those trucks
higher, with a `routeMatch` field on each result explaining why. No route
changes needed; this is transparent to the existing endpoint.

## 4. Inspector reputation
**Bug fixed along the way:** `routes/ratings.js`'s validation only ever
allowed BUYER/SELLER/TRUCK_OWNER as a valid rating target, even though
INSPECTOR was accepted by the request-body validator — meaning no inspector
could ever actually be rated; every attempt returned 400. Fixed by including
completed `inspectionRequests` on the order lookup and checking against
their `inspectorId`s.
New: `GET /ratings/inspector/:userId/reputation` — average INSPECTOR-role
rating, rating count, completed-inspection count, and a labeled-informational
"orders disputed after this inspector's report" rate (not a verdict on the
inspector — disputeType is free text and not every dispute is about
inspection quality; it's a prompt for a human reviewer to look closer).

## 5. SMS-based listing creation
New: `routes/sms.js` (`POST /sms/inbound`), `services/smsListingService.js`.
A registered seller can text `LIST <crop> <qty> <unit> <price> <location>`
to create a DRAFT listing (left as DRAFT on purpose — no photos, more room
for a mistyped number than the web form has, so it needs one more step
before going live), then `ACTIVATE <code>` (the code is the last 6
characters of the listing's id, sent back in the confirmation SMS) to
publish it. Requires `SMS_INBOUND_WEBHOOK_SECRET` to be set — the endpoint
fails closed (401) if it's missing, and checks it via constant-time
comparison against a header (`x-marketbridge-sms-secret`) or `?secret=`
query param, whichever your SMS provider's webhook config can send. No real
provider is wired up yet (mirrors the existing outbound `smsService.js`
situation) — this is provider-agnostic until one is chosen.

## Validation
`node --check` passed on every modified/new backend file. Schema brace
balance checked manually (no `prisma` CLI available in this environment to
run `prisma validate`/`generate` — please run that once before deploying).

## Not done / flagged for you
- No frontend UI for any of these five (payout admin screen, market-trends
  chart, inspector reputation display, SMS help text in onboarding). All
  five are usable via API today; happy to build the UI pieces next if
  useful.
- No automated tests added for any of the five.
- `openapi.json` was not regenerated to include the five new/changed
  endpoints — flag for your API-docs pass (this was priority #10 from the
  original enhancement list, already known to be behind).
- The four smaller patches from the earlier "check if important" review
  (Chapa webhook fallback fix, refund provider-reference requirement, admin
  reconciliation validation, CORS/video-signature hardening) are a separate,
  independent patch — not included here, still pending your go-ahead.
