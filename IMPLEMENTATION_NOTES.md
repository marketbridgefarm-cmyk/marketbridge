# MarketBridge — Step 7 Remaining: Database Sale Invariants & Concurrency Tests

## Implemented

1. Added PostgreSQL partial unique index `Order_listingId_active_unique` so a listing can have at most one non-cancelled order.
2. Documented the invariant in `backend/prisma/schema.prisma`.
3. Added opt-in concurrency E2E coverage for:
   - simultaneous Buy Now requests from two different buyers;
   - simultaneous acceptance of two competing agricultural offers.
4. Tests use different idempotency keys so they exercise the database/workflow concurrency guard rather than idempotency deduplication.

## Migration

Run the normal production/staging migration process:

    npx prisma migrate deploy

Do not manually delete or rewrite previously applied migrations.

## Validation

JavaScript syntax checks passed. The concurrency test passes its default opt-in skip when no E2E database is configured.

To execute it against a disposable PostgreSQL database:

    MARKETBRIDGE_E2E=1 E2E_DATABASE_URL="<disposable-postgres-url>" npm test -- --test-name-pattern="concurrency"

The current execution environment does not have the backend `node_modules` installed, so dependency-backed execution against PostgreSQL could not be performed here.
