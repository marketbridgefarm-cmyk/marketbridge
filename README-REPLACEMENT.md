# MarketBridge — Steps 1–5 Replacement Files

This package contains the **complete replacement files** needed to bring the repository through Steps 1–5 of the current implementation sequence.

## How to use

1. Extract this ZIP into a temporary folder.
2. In GitHub, replace files using the **same repository paths** shown in the ZIP.
3. Do **not** delete unrelated project files.
4. Commit all replacements together.
5. On Render/production, run the normal deployment command so Prisma applies pending migrations.

## Included work

- Steps 1–4: public-data isolation, idempotency, E2E coverage, and event-driven in-app notifications.
- Step 5: persistent refresh sessions, refresh-token rotation, replay/reuse detection, logout/logout-all revocation, and suspension-triggered session invalidation.

## Important deployment note

Step 5 adds migration:

`backend/prisma/migrations/202609140003_add_refresh_sessions/migration.sql`

The backend start command already runs `prisma migrate deploy`, so the migration will be applied during deployment.

Existing access/refresh token storage in the frontend is retained for compatibility. New tokens are bound to persistent server-side sessions. Existing pre-Step-5 refresh tokens do not contain a session identifier and will require the user to sign in again after this deployment.

## Step 5 security behavior

- Successful refresh rotates the refresh token.
- Reuse of a rotated/expired/revoked refresh token revokes its entire session family.
- Logout revokes the current session family.
- Logout-all revokes every active session for the account.
- New session-bound access tokens are rejected immediately after their session is revoked.
- Suspending an account revokes its active refresh sessions.

## Step 6 additions

Replace these additional files from this package:

- `backend/src/routes/admin.js`
- `frontend/src/pages/AdminDashboard.jsx`
- `CHANGES.md`

Step 6 adds operational visibility to the existing Admin Control Center. It does not replace the existing admin controls.

New admin endpoints:

- `GET /api/admin/operations/summary`
- `GET /api/admin/order-events?limit=100`

Both endpoints require the existing `ADMIN` authorization middleware.
