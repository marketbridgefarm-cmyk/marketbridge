-- Must return zero rows before applying migration
-- 202610010004_bind_transport_payment_to_quote.
SELECT
  "transportJobId",
  COUNT(*) AS active_payment_count
FROM "Payment"
WHERE "transportJobId" IS NOT NULL
  AND "type" = 'TRANSPORT'
  AND "status" IN ('PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED')
GROUP BY "transportJobId"
HAVING COUNT(*) > 1;
