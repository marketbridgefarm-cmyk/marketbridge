ALTER TABLE "InspectionRequest"
  ADD COLUMN IF NOT EXISTS "location" TEXT;

CREATE INDEX IF NOT EXISTS "InspectionRequest_location_idx"
  ON "InspectionRequest"("location");

UPDATE "InspectionRequest" ir
SET "location" = l."location"
FROM "Listing" l
WHERE ir."listingId" = l."id"
  AND ir."location" IS NULL;
