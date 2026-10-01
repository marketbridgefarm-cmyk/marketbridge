# P0 — Bind Transport Payments to the Exact Negotiated Quote

## What changed

A hired-transporter payment is now bound to the exact `TransportQuote` that was accepted before checkout.

The invariant is:

```text
ACCEPTED TransportQuote
        ↓
Transport Payment
        ↓
provider settlement
        ↓
same quote's truck + transporter + amount
```

A later quote cannot replace the commercial terms underneath an existing payment.

## Updated files

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/202610010004_bind_transport_payment_to_quote/migration.sql`
- `backend/src/routes/payments.js`
- `backend/src/routes/transport.js`
- `backend/src/services/paymentService.js`

## Migration pre-check

Before applying the migration in production, run:

```sql
SELECT
  "transportJobId",
  COUNT(*) AS active_payment_count
FROM "Payment"
WHERE "transportJobId" IS NOT NULL
  AND "type" = 'TRANSPORT'
  AND "status" IN ('PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED')
GROUP BY "transportJobId"
HAVING COUNT(*) > 1;
```

This must return **zero rows** before the new partial unique index is applied.

## Deployment

1. Back up the production database.
2. Run the migration with `prisma migrate deploy`.
3. Regenerate Prisma Client during the normal backend build/deploy.
4. Verify that a new hired-transport payment contains `transportQuoteId`.
5. Verify that changing/selecting another transporter is rejected while that payment is `PENDING`, `PROCESSING`, `PAID`, or `RECONCILIATION_REQUIRED`.
6. Verify that payment settlement creates the transporter ledger/payout for the quote stored on the payment.

## Backward compatibility

Existing historical payments may have `transportQuoteId = NULL`. The new strict quote-binding requirement applies to newly created hired-transporter payments. Legacy settlement continues to use the existing job assignment where no quote binding exists.
