# Step 2 Changes

- Added persistent request-level idempotency for critical marketplace mutations.
- Added request fingerprinting so an idempotency key cannot be reused with different request data.
- Added replay of successful responses for safe client retries.
- Added recovery of expired in-progress idempotency records.
- Applied the protection to buy-now, order receipt/cancel, produce offers, and transport quotes.
- Preserved existing payment-specific idempotency handling.
- Failed requests release their idempotency record so clients can retry after correcting the request.

## Validation

All modified JavaScript files pass `node --check`. Prisma validation requires the project dependencies (`npm ci` / Prisma CLI) to be installed in the build environment.

## Step 4 — Durable OrderEvent notifications

- Added a durable `Notification` model linked to `User`, `Order`, and
  `OrderEvent`.
- `recordOrderEvent()` now creates user-facing notifications in the same
  database transaction as the workflow event, preventing the notification
  inbox from drifting away from the durable order history.
- Added actionable notification templates for order creation/cancellation,
  inspection acceptance/start/completion, payment status changes, transport
  status changes, and receipt confirmation.
- Notifications are recipient-aware: buyers, sellers, inspectors, and assigned
  transporters receive only relevant workflow updates, and the actor does not
  receive an echo of their own action.
- Added authenticated notification list, unread-count, mark-read, and
  mark-all-read endpoints.
- Offer acceptance now records the missing `ORDER_CREATED` customer workflow
  event, so negotiated agricultural orders enter the same notification flow as
  Buy Now orders without removing or weakening negotiations.
- Added a frontend notification center with unread badge, 30-second polling,
  actionable order navigation, and mark-all-read support.
- Extended the opt-in marketplace E2E test and added notification integration
  coverage.


## Step 5 — Persistent refresh-session security

- Added `RefreshSession` persistence with hashed refresh tokens, expiry, session families, rotation metadata and revocation state.
- Login/register now create a persistent refresh session and bind access/refresh JWTs to that session.
- Refresh tokens rotate on every successful refresh; replay/reuse detection revokes the entire session family.
- Logout revokes the current session family; `POST /api/auth/logout-all` revokes all active sessions.
- Authenticated requests carrying a session-bound access token now fail immediately after that session is revoked.
- Suspending an account revokes its active refresh sessions inside the same admin transaction.
- Updated frontend logout to call the backend revocation endpoint while retaining local cleanup fallback.
- Added opt-in integration tests in `backend/test/auth.sessions.test.js`.

## Step 6 — Admin Control Center / Operational Maturity

Implemented the next operational-maturity layer without replacing existing marketplace functionality:

- Added admin-only `GET /api/admin/operations/summary` for live operational queue counts (pending payments, reconciliation-required payments, open disputes, active orders, active transport jobs) plus a small recent-event snapshot.
- Added admin-only `GET /api/admin/order-events` to expose the durable customer-facing `OrderEvent` stream for operational monitoring.
- Extended the existing Admin Control Center with an **Operations & Audit** tab.
- The tab shows workflow events and the internal audit trail separately, preserving the distinction between customer-facing workflow history and internal security/admin records.
- Existing user, verification, suspension, role, dispute, fraud, advertising, order, payment and commission controls remain intact.
- No negotiation functionality was removed or changed.
