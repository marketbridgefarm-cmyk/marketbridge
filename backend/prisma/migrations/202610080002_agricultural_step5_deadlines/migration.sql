-- Step 5 workflow deadlines: buyer decision, seller preparation, loading approval.
ALTER TABLE "Order" ADD COLUMN "buyerDecisionDueAt" TIMESTAMP(3);
ALTER TABLE "TransportJob" ADD COLUMN "sellerPreparationDueAt" TIMESTAMP(3);
ALTER TABLE "TransportJob" ADD COLUMN "buyerLoadingDueAt" TIMESTAMP(3);

CREATE INDEX "Order_buyerDecisionDueAt_idx" ON "Order"("buyerDecisionDueAt");
CREATE INDEX "TransportJob_sellerPreparationDueAt_idx" ON "TransportJob"("sellerPreparationDueAt");
CREATE INDEX "TransportJob_buyerLoadingDueAt_idx" ON "TransportJob"("buyerLoadingDueAt");
