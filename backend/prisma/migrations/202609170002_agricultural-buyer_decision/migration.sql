-- Explicit buyer decision gate for agricultural orders.
-- NULL preserves existing orders until the buyer makes the decision.
CREATE TYPE "BuyerDecision" AS ENUM ('BUY', 'CANCEL');

ALTER TABLE "Order"
  ADD COLUMN "buyerDecision" "BuyerDecision",
  ADD COLUMN "buyerDecisionAt" TIMESTAMP(3);

CREATE INDEX "Order_buyerDecision_idx" ON "Order"("buyerDecision");
