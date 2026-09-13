# Pass 4 — Money fields: Float → Decimal(18,2)

Implements PDF recommendation #12 (Financial Data Type).

## Schema

Every genuine currency field in `backend/prisma/schema.prisma` moved from
`Float` to `Decimal @db.Decimal(18, 2)`:

`Listing.askingPrice`/`minAcceptablePrice` · `Offer.amount`/`counterAmount`
· `InspectionRequest.fee` · `InspectionQuote.amount`/`counterAmount` ·
`Order.finalPrice` · `TransportJob.agreedAmount` ·
`TransportQuote.amount`/`counterAmount` · `DigitalProduct.price` ·
`Payment.amount`/`commissionAmount`/`netAmount` ·
`PaymentLedgerEntry.amount` · `Advertisement.priceQuoted`/`amountPaid`.

Left as `Float` on purpose, because they aren't currency: `User.rating`,
`Truck.rating`, `Listing.quantity`, `Offer.quantity`,
`InspectionReport.quantity`/`moisture`, `Truck.capacity`,
`TransportJob.requiredCapacity`, and `Payment.commissionRate` (a
percentage, 0–100, not an amount).

## Migration

`202609130002_money_fields_to_decimal` — a guarded `DO $$` block that
loops over the (table, column) pairs above and, only where the column is
still `double precision`, runs
`ALTER COLUMN ... TYPE numeric(18,2) USING ...::numeric(18,2)`. The
explicit `USING` cast rounds any existing floating-point drift (e.g.
`19.990000000000002`) to a clean 2-decimal value as part of the type
change, rather than reinterpreting raw bytes. Safe to re-run.

## Why this matters, concretely

Floats can't exactly represent most 2-decimal currency values in binary,
and repeated arithmetic (commission math, negotiation counters, refunds)
on them accumulates drift. `numeric(18,2)` stores and compares the exact
decimal value at the database layer — this is the literal ask in PDF
recommendation #12 ("avoid floating-point money fields... particularly
important for seller earnings, transporter payments, inspector fees,
commissions, refunds, advertising and reconciliation").

## The real risk of this change, and how it was handled

Prisma Client returns `Decimal` fields as `Decimal.js` instances at
runtime (not plain JS numbers), and serializes them to JSON as **strings**
(e.g. `"150.00"`, not `150`). Any code doing raw arithmetic or comparison
on these fields directly — `a + b`, `a > b` — silently breaks: string
concatenation instead of addition, lexicographic instead of numeric
comparison. `Number(x)` on a `Decimal` instance or a numeric string
always works correctly, though, since `Decimal.valueOf()` returns the
value as a string and `Number("150.00")` parses fine.

**Audited every money field across the whole repo** for this exact
pattern (`grep` for `+`/`-`/`*`/`/`/`>`/`<` directly adjacent to a money
field name, backend and frontend):

- **Backend was already almost entirely safe.** Every money computation
  goes through `Number(...)`-wrapping helpers — `moneyEqual`/`roundMoney`
  in `paymentService.js`, `money()` in `admin.js` (which wraps all the
  `_sum.amount`/`_sum.commissionAmount` aggregate results too — Prisma's
  `_sum` on a Decimal column also returns a `Decimal`, not a number, so
  this mattered). It looks like this was written anticipating a Decimal
  migration.
- **One real, live bug found and fixed:** `backend/src/routes/listings.js`
  — the "best offer" calculation on a listing did
  `offer.amount > (max?.amount || 0)` directly. Fixed to
  `Number(offer.amount || 0) > Number(max?.amount || 0)`.
- **Two more found and fixed in `frontend/src/pages/SellerDashboard.jsx`**
  (currently dead/unreachable code since the Pass 2 unified-dashboard
  migration, but fixed anyway to avoid a latent bug if it's ever
  resurrected): a `grossSales` reduce doing `sum + o.finalPrice`, and the
  same "best offer" `o.amount > (max?.amount || 0)` pattern as the
  listings.js one.
- Every other reduce/sort/comparison touching a money field anywhere in
  the frontend (`Dashboard.jsx`, `BuyerDashboard.jsx`, `OrderDetail.jsx`,
  `ListingDetail.jsx`, `InspectorDashboard.jsx`) was already wrapped in
  `Number(...)`.

## Verified this pass

- Every backend `.js` file: `node --check` — all pass.
- Every frontend `.jsx`/`.js` file: `esbuild --jsx=automatic` — all parse
  clean.
- `schema.prisma` brace-balance sanity check (53 open / 53 close,
  unchanged from before this pass's edits).
- Manually re-read every model touched to confirm the right fields moved
  and the right ones (ratings/quantities/capacity/rate) stayed `Float`.
- **Not run** (no network/DB in this environment, same limitation as
  every prior pass): `prisma validate`, `prisma migrate dev`/`deploy`
  against a real Postgres instance, `npm run build`, the Jest suite.
  Please run these — especially the migration itself — before merging.
  In particular, run `prisma migrate dev` (or apply the SQL directly and
  then `prisma db pull`/regenerate the client) so `@prisma/client` is
  regenerated against the new schema before deploying any code from this
  pass or Pass 3.

## Known gaps / explicitly deferred (still true after this pass)

- This migration fixes storage/comparison precision at the **database
  layer** (the literal PDF ask). It does not rewrite in-application
  arithmetic to use `Prisma.Decimal`/`decimal.js` throughout — commission
  math in `paymentService.js` still computes in JS `Number` space
  (`Math.round(value * 100) / 100`) before handing a plain number to
  Prisma to store as a `Decimal`. That's a smaller, separate precision
  concern (JS float arithmetic can still produce a value like
  `19.990000000000002` before the final rounding step) and a much larger
  refactor; out of scope here.
- No `OrderPaymentObligation` model (#13), no `OrderEvent` timeline model
  (#18), no automated E2E test suite (#15), Admin Control Center is still
  the existing dashboard rather than the fuller metrics/alerts surface
  (#17), Product marketplace still leans on agricultural listing fields
  (#10).

---

# Pass 3 — Dispute UI + Payment Idempotency-Key

## Backend

- **Schema:** `Payment.idempotencyKey String? @unique` added (migration
  `202609130001_add_payment_idempotency_key`, guarded/re-runnable like the
  other late-added-column migrations in this repo).
- **`backend/src/services/paymentService.js` — `createPayment`:** wraps
  the insert in a try/catch for `P2002` on `idempotencyKey` and returns
  the already-existing payment instead of throwing, mirroring the exact
  pattern `settlePayment` already used for `PaymentEvent.eventId`.
- **`backend/src/routes/orders.js` (via `orderWorkflowService.js`):**
  `RAISE_DISPUTE` now reports `viewerCanPerform: true` for the assigned
  truck owner too, not just buyer/seller — `POST /disputes` already
  accepted a truck owner as a participant, the workflow read-model just
  hadn't caught up.

### Why: `POST /payments` had a real TOCTOU race

The existing "duplicate payment protection" in `routes/payments.js` was a
find-then-create check — not atomic. Two near-simultaneous requests (a
retried request after a timeout, a double-tapped pay button, a mobile
network retry) could both pass the check before either insert landed,
creating two payment intents for the same obligation. This is exactly PDF
recommendation #14 ("Add Idempotency-Key support to payment creation").

`POST /payments` now reads an `Idempotency-Key` header (or
`body.idempotencyKey`). If a payment already exists for that key:
it's returned as-is (`200`, `replayed: true`) if it belongs to the same
user, or `409` if it doesn't. If two requests with the same brand-new key
race each other, the database's unique constraint lets exactly one insert
win and `createPayment` hands the loser the winner's row — so the
behavior is correct even in the exact race the app-level check couldn't
close. Sending the header is optional; requests without one behave
exactly as before.

- `frontend/src/utils/chapaCheckout.js` — `startChapaPayment`, the single
  shared entry point every payment flow in the app already goes through
  (goods, inspection, transport, digital, advertising), now generates one
  `crypto.randomUUID()` key per attempt and sends it as `Idempotency-Key`.
  No other frontend file calls `POST /payments` directly, so this one
  change covers every payment type without touching each page.

## Frontend

- **New:** a "Raise a dispute" form on `frontend/src/pages/OrderDetail.jsx`
  (`id="raise-dispute"`) — closes the gap flagged at the end of Pass 1:
  `POST /disputes` existed and the workflow engine already reported
  `RAISE_DISPUTE` as available, but there was no UI anywhere to actually
  raise one. Visible to the buyer, seller, or assigned truck owner on any
  order that isn't `COMPLETED`/`CANCELLED`/already `DISPUTED`. Lets the
  user pick which other participant it's against (buyer/seller/truck
  owner, whichever aren't themselves), a type, and a description; shows a
  "dispute open, an admin is reviewing it" notice instead once
  `order.status === 'DISPUTED'`.
- `frontend/src/components/WorkflowActions.jsx` — `RAISE_DISPUTE` now
  maps to a scroll-to-`raise-dispute` button, same as the other action
  codes.

## Verified this pass

- Every backend `.js` file: `node --check` — all pass.
- Every frontend `.jsx`/`.js` file: `esbuild --jsx=automatic` — all parse
  clean (used a bundled copy under `tsx`'s `node_modules` since this
  environment still has no registry access to install esbuild/Vite
  directly — same limitation as Pass 1/2).
- Manually traced `Payment.idempotencyKey` through schema → migration →
  `paymentService.createPayment` → `routes/payments.js` → the one
  frontend call site, and confirmed no other call site creates a payment
  directly (`grep`'d the whole frontend for `api.post` payment calls).
- **Not run** (no network/DB in this environment): `prisma validate` /
  `prisma migrate dev`, `npm run build`, the existing Jest suite
  (`backend/test/*.test.js`). Please run these — especially applying the
  new migration against a real Postgres instance — before merging.

## Known gaps / explicitly deferred (still true after this pass)

- Money is still `Float` everywhere in `schema.prisma`, not `Decimal`
  (PDF #12) — the highest-value remaining P0 item, and a schema-wide
  migration, so deliberately not attempted in this same pass as the
  idempotency-key migration.
- No `OrderPaymentObligation` model (#13), no `OrderEvent` timeline model
  (#18), no automated E2E test suite (#15), Admin Control Center is still
  the existing dashboard rather than the fuller metrics/alerts surface
  (#17), Product marketplace still leans on agricultural listing fields
  (#10).
- Idempotency-Key is now wired for `POST /payments` specifically, per the
  PDF's own top example — other financial mutations it also names
  ("offer acceptance, inspection assignment, transport quote acceptance,
  truck allocation, order creation") are already `$transaction`-wrapped
  in `offers.js`/`inspections.js`/`transport.js`/`orders.js` (verified via
  `grep -c '$transaction'` on each), so they don't have the same
  find-then-create race `POST /payments` had — a request-level
  Idempotency-Key for those routes would be a smaller, separate
  enhancement, not a race-condition fix.

---

# MarketBridge — Workflow Engine + Action Center pass

Implements PDF recommendation #4 (Server-Side Workflow Engine) and #5/#8
(Action Center, Order Timeline, Payment Status, Workflow Actions components).

## Backend

- **New:** `backend/src/services/orderWorkflowService.js`
  Pure function `computeOrderWorkflow(order, viewerUserId, viewerRoles)`.
  Given an order loaded with the existing `orderInclude` shape, returns:
  - `currentStage` — one of `PENDING_PAYMENT`, `ARRANGING_TRANSPORT`,
    `PAYMENT`, `PICKUP_READY`, `PICKED_UP`, `IN_TRANSIT`,
    `AWAITING_RECEIPT`, `COMPLETED`, `DISPUTED`, `CANCELLED`
  - `nextActor`, `viewerRole`
  - `payments` — goods / per-inspection / transport obligations, mirroring
    the same gate `getTransportPaymentGate()` in `routes/transport.js`
    already enforces before pickup
  - `timeline` — ordered progress steps with `completed`/`at`
  - `actions` — every action relevant to this order, each with `code`,
    `actorRole`, `ready` (state allows it), `viewerCanPerform`, `enabled`
    (both), `reason` (if not ready), and the exact `route` (method/path/body)
    to call

  This is a **read model only** — it does not replace or duplicate
  authorization; every route it references still enforces its own rules
  independently. Verified with `node --check` and manual mock-order runs
  covering fresh/PENDING_PAYMENT, PICKUP_READY (truck owner view), and
  AWAITING_RECEIPT (buyer view) — all matched expected output.

- **New route:** `GET /orders/:id/workflow` in `backend/src/routes/orders.js`
  Reuses the existing `orderInclude` and the same authorization check as
  `GET /orders/:id`.

## Frontend

- **New:** `frontend/src/components/ActionCenter.jsx`
  Top "what happens next" panel. Renders stage + who's currently blocking
  progress, and the signed-in user's own ready/pending actions.

- **New:** `frontend/src/components/WorkflowActions.jsx`
  Renders an `actions[]` array as buttons/links. Only action codes with a
  known safe destination are rendered (scroll to an existing working
  section, or link to an existing page) — anything else is silently
  omitted rather than pointing at a dead control.

- **New:** `frontend/src/components/OrderTimeline.jsx`
  Renders the `timeline` array as a vertical progress list.

- **New:** `frontend/src/components/PaymentStatus.jsx`
  Renders the `payments` snapshot (goods / inspection / transport) with
  paid/pending badges.

- **Modified:** `frontend/src/pages/OrderDetail.jsx`
  - Fetches `/orders/:id/workflow` alongside `/orders/:id` (in parallel via
    `Promise.allSettled`, so a workflow-endpoint failure never blocks the
    page — it just falls back to no Action Center/timeline/payment card).
  - Replaced the ~120-line hand-written per-role "what happens next" JSX
    block (which reconstructed backend rules client-side) with
    `<ActionCenter>`, plus a new two-column card row for
    `<OrderTimeline>` / `<PaymentStatus>`.
  - Everything else on the page (payment center, transport section,
    confirm-receipt button, cancel-order button, inspection request form)
    is untouched and still works exactly as before — the new components
    link/scroll into those existing, already-correct controls rather than
    reimplementing them.

- **Modified:** `frontend/src/styles.css`
  Appended styles for the new components only (`.order-timeline*`,
  `.payment-status*`, `.badge-success`/`.badge-pending`,
  `.card-grid.two-col`, `.workflow-action-pending`). Reused the existing
  `.next-action-buttons`, `.badge`, `.card`, `.muted` classes elsewhere
  rather than inventing new ones where one already fit.

## Verified this pass

- Every backend `.js` file: `node --check` — all pass.
- Every frontend `.jsx`/`.js` file: parsed with `esbuild --jsx=automatic`
  (no real JSX/JS transpiler was installable — no network access — so this
  is a syntax check, not a full Vite build/lint/type-check).
- `orderWorkflowService.js` exercised directly with three mock order shapes
  (fresh order, pickup-ready hired transport, delivered awaiting receipt)
  — stage/actor/actions all matched hand-computed expectations.
- Confirmed no dangling/orphaned variables were left in `OrderDetail.jsx`
  after removing the old next-action block.

## Known gaps / explicitly deferred

- **Not run:** `npm install` / `npm run build` / any real Vite build,
  ESLint, or the existing test suite (`backend/test/*.test.js`) — no
  network access in this environment to install dependencies. Please run
  these before merging.
- **RAISE_DISPUTE**: the workflow endpoint correctly reports this as an
  available action (backend `POST /disputes` already exists and works),
  but there is **no dispute-raising UI anywhere in this frontend today**.
  `WorkflowActions.jsx` deliberately does not render a button for it
  rather than link to a page that doesn't exist. This is a real gap worth
  a follow-up pass.
- Transport-quote negotiation ("whose turn" language, recommendation #7)
  is only surfaced as a count ("N quotes to review") that scrolls to the
  existing transport section — the section itself doesn't yet say whose
  turn it is inside the quote thread. That's recommendation #7, not
  attempted this pass.
- Everything else in the PDF (Decimal money types, payment obligations
  DB model, idempotency keys, E2E tests, admin Control Center, etc.) is
  untouched — out of scope for this pass.

---

# Pass 2 — Unified Buyer/Seller Dashboard (recommendation #2)

Implements the "highest-priority architecture issue" from the PDF: a
normal registered user is both a buyer and a seller by default
(`DEFAULT_ROLES = ['BUYER', 'SELLER']` in `backend/src/routes/auth.js`),
so they get one dashboard instead of two.

## New

- `frontend/src/pages/Dashboard.jsx` — the unified dashboard at
  `/dashboard`, with tabs: **Buying, Selling, My Listings, Offers,
  Orders, Messages, Payments, Earnings**. Built entirely on existing
  endpoints (`/offers/mine`, `/offers/listing/:id`, `/orders`,
  `/listings?sellerId=`, `/messages/thread/:userId`) — no backend
  changes were needed for this piece.
  - **Orders** and **Payments** are genuinely unified: `/orders` already
    returns every order where the user is buyer *or* seller, so this
    tab needed no per-role filtering — it just tags each row.
  - **Offers** merges offers sent (as buyer) and offers received (as
    seller, across all of the user's listings), tags each row's role,
    and wires Accept/Reject/Counter directly to the existing
    `PATCH /offers/:id` action endpoint.
  - **Messages** has no backend "inbox" endpoint to list conversations,
    so the conversation list is derived client-side from the
    counterparties (buyer/seller/truck owner) across the user's orders,
    then loads each thread via the existing `/messages/thread/:userId`.
  - **Earnings** reuses the same gross-sales calculation
    `SellerDashboard.jsx` already had.

## Modified

- `frontend/src/App.jsx` — added `/dashboard` route (any authenticated
  user, like `/orders`). `/dashboard/seller` and `/dashboard/buyer` now
  redirect to `/dashboard` (kept as routes, not deleted, so no old link
  or bookmark breaks). Inspector/Truck Owner/Admin/Advertiser routes are
  untouched, per the PDF's "keep specialized dashboards" guidance.
- `frontend/src/pages/Login.jsx` — post-login redirect sends
  BUYER-or-SELLER accounts to `/dashboard` instead of picking one of
  `/dashboard/buyer` / `/dashboard/seller`.
- `frontend/src/components/Navbar.jsx` — the single "Dashboard" nav
  link now resolves BUYER/SELLER to `/dashboard`.
- `frontend/src/components/RoleSwitchCTA.jsx` — the buy/sell cross-sell
  card (shown on the Inspector/Truck Owner/Admin dashboards) now points
  at `/dashboard` for both roles instead of the removed split paths.
- `frontend/src/styles.css` — appended `.sd-list`, `.sd-list-item`,
  `.sd-counter-input` (new to this dashboard); everything else reuses
  existing `.sd-*` classes (`.sd-tabs`, `.sd-tab`, `.sd-table`,
  `.sd-stat-grid`, `.sd-toast`, etc.) so the new page matches
  SellerDashboard's existing look exactly rather than inventing a new
  visual language.

## Verified this pass

- Every backend `.js` file: `node --check` — all pass (no backend files
  were touched this pass, re-verified anyway).
- Every frontend `.jsx`/`.js` file, including all newly modified ones:
  parsed clean with `esbuild --jsx=automatic`.
- Manually cross-checked every new CSS class name against
  `styles.css` before use, since a first draft used a few names
  (`.active`, `.sd-tab-badge`, `.sd-stats`, `.toast`) that didn't match
  this codebase's existing conventions (`.sd-active`, `.sd-tab-count`,
  `.sd-stat-grid` + `<b>`, `.sd-toast`) — corrected to match.
- Grepped the whole frontend for leftover `/dashboard/buyer` or
  `/dashboard/seller` references after the change; only the two
  intentional redirect routes in `App.jsx` remain.

## Known gaps / explicitly deferred

- **`BuyerDashboard.jsx` and `SellerDashboard.jsx` are now unreachable**
  (no route points to them) but were **not deleted** — they're dead
  code today, kept only so nothing is lost if you want to salvage any
  of their heavier UI (media-upload listing editor, full offer
  negotiation modal) into the unified page later.
- **"My Listings" is a summary, not the full editor.** Creating and
  editing a listing (with photo/video upload) still happens on
  `/create-listing` and the listing detail page — this pass did not
  port that modal-driven flow into the unified dashboard. Same for the
  full negotiation modal; the Offers tab's Counter action is a plain
  numeric input rather than the richer modal `SellerDashboard.jsx` had.
- **Messages tab sends under a "most recent shared order"** — since
  `POST /messages` requires an `orderId` and there's no cross-order
  inbox concept in the schema, replying to a counterpart uses whichever
  order most recently connected you to them. This is a reasonable
  default but not identical to a true unified inbox.
- No real Vite build/lint run — same network limitation as pass 1;
  please run `npm run build` before merging.

