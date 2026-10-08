-- Buyer approval of the pre-loading report is a distinct gate before pickup.
ALTER TABLE "TransportJob"
  ADD COLUMN IF NOT EXISTS "buyerLoadingConfirmedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TransportJob_buyerLoadingConfirmedAt_idx"
  ON "TransportJob"("buyerLoadingConfirmedAt");
