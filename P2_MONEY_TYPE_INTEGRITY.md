# MarketBridge P2 — Money Type Integrity

This package is the complete P2 replacement package for the MarketBridge money-type hardening step.

## Included

- `backend/prisma/schema.prisma` — complete Prisma schema from the current MarketBridge baseline.
- `backend/prisma/migrations/202610010006_money_type_integrity_hardening/migration.sql` — production migration.
- `backend/prisma/sql/p2_money_preflight.sql` — read-only production preflight.
- `backend/prisma/sql/p2_money_verify.sql` — post-deployment verification.

## Money policy

All currency amounts represented by the Prisma schema are `Decimal @db.Decimal(18, 2)` and therefore map to PostgreSQL `NUMERIC(18,2)`.

The following are deliberately **not** money and remain floating point:

- geographic latitude/longitude
- product/listing quantities
- inspection moisture
- truck capacity/required capacity
- ratings
- `Payment.commissionRate`, which is a percentage/rate rather than a currency amount

## Covered monetary columns

Listing, Offer, InspectionRequest, InspectionQuote, Order, TransportJob, TransportQuote, DigitalProduct, PaymentObligation, Payment, PaymentLedgerEntry, PaymentRefund, PaymentReconciliation, Advertisement and Payout monetary amounts are covered.

## Deployment

1. Back up production PostgreSQL.
2. Run `p2_money_preflight.sql` against the target database.
3. Confirm there are no non-finite legacy floating-point values.
4. Commit this package to the repository.
5. Run:

```bash
cd backend
npx prisma validate
npx prisma migrate deploy
```

6. Run `p2_money_verify.sql`.
7. Run the backend financial/payment test suite before opening production traffic.

Do **not** use `prisma db push` for this production migration.

## Important

This migration is designed to be safe when the columns are already `NUMERIC(18,2)`: those columns are not altered again. If a legacy column is still floating point, it is converted with two-decimal rounding. Non-finite legacy values are rejected before conversion so they cannot silently become invalid money values.
