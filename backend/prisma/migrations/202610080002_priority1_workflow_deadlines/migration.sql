-- Priority 1 workflow deadlines: buyer BUY/CANCEL decision clock.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "buyerDecisionDueAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Order_buyerDecisionDueAt_idx" ON "Order"("buyerDecisionDueAt");

-- Existing orders already waiting for the buyer after seller
-- transporter-preparation confirmation receive a fresh 24-hour decision window.
UPDATE "Order" o
SET "buyerDecisionDueAt" = NOW() + INTERVAL '24 hours'
WHERE o."buyerDecision" IS NULL
  AND o."buyerDecisionDueAt" IS NULL
  AND o."status" NOT IN ('CANCELLED', 'COMPLETED', 'DISPUTED')
  AND EXISTS (
    SELECT 1 FROM "TransportJob" t
    WHERE t."orderId" = o."id"
      AND t."status" = 'ACCEPTED'
      AND t."sellerPickupConfirmedAt" IS NOT NULL
  );
