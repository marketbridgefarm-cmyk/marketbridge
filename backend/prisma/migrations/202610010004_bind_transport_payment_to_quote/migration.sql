-- Bind hired-transport payments to the exact negotiated quote that created them.
-- This prevents a later quote selection from changing who/what an existing
-- payment settles against. Existing historical payments remain nullable.
ALTER TABLE "Payment"
ADD COLUMN "transportQuoteId" TEXT;

CREATE INDEX "Payment_transportQuoteId_idx"
ON "Payment"("transportQuoteId");

ALTER TABLE "Payment"
ADD CONSTRAINT "Payment_transportQuoteId_fkey"
FOREIGN KEY ("transportQuoteId") REFERENCES "TransportQuote"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

-- At most one live hired-transport payment may exist for a transport job.
-- Failed/refunded attempts can be replaced; pending/processing/paid and
-- reconciliation-required payments remain the commercial payment attempt.
CREATE UNIQUE INDEX "Payment_transportJob_active_unique"
ON "Payment"("transportJobId")
WHERE "transportJobId" IS NOT NULL
  AND "type" = 'TRANSPORT'
  AND "status" IN ('PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED');
