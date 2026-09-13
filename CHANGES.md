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

