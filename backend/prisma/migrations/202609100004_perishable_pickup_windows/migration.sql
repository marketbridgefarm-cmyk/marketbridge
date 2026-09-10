ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "pickupWindowStart" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pickupWindowEnd" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Listing_pickupWindowStart_pickupWindowEnd_idx"
  ON "Listing"("pickupWindowStart", "pickupWindowEnd");
