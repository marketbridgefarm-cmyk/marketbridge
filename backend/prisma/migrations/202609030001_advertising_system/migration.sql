-- Step 2: Apply Hardened Schema Changes & Indexes

-- 1. Create AdvertisementEventType Enum including CONVERSION
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'AdvertisementEventType'
  ) THEN
    CREATE TYPE "AdvertisementEventType" AS ENUM ('IMPRESSION', 'CLICK', 'CONVERSION');
  END IF;
END $$;

-- 2. Expand Advertisement Table Structure
ALTER TABLE "Advertisement"
  ADD COLUMN IF NOT EXISTS "priceQuoted" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN IF NOT EXISTS "campaignReference" TEXT,
  ADD COLUMN IF NOT EXISTS "headline" TEXT,
  ADD COLUMN IF NOT EXISTS "destinationUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "creativeImageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "bannerTemplate" TEXT NOT NULL DEFAULT 'CLASSIC',
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "telegramPostReference" TEXT;

-- 3. Backfill Legacy Records
UPDATE "Advertisement"
SET "priceQuoted" = COALESCE("priceQuoted", "amountPaid", 0)
WHERE "priceQuoted" IS NULL;

UPDATE "Advertisement"
SET "campaignReference" = 'MB-AD-LEGACY-' || "id"
WHERE "campaignReference" IS NULL;

-- 4. Apply Schema Constraints and Default Enums
ALTER TABLE "Advertisement"
  ALTER COLUMN "priceQuoted" SET NOT NULL,
  ALTER COLUMN "campaignReference" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT'::"AdStatus";

-- 5. Performance and Lookup Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Advertisement_campaignReference_key"
  ON "Advertisement"("campaignReference");

CREATE INDEX IF NOT EXISTS "Advertisement_type_status_startDate_endDate_idx"
  ON "Advertisement"("type", "status", "startDate", "endDate");

CREATE INDEX IF NOT EXISTS "Advertisement_createdAt_idx"
  ON "Advertisement"("createdAt");

-- 6. Event Analytics Table Setup
CREATE TABLE IF NOT EXISTS "AdvertisementEvent" (
  "id" TEXT NOT NULL,
  "advertisementId" TEXT NOT NULL,
  "eventType" "AdvertisementEventType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvertisementEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdvertisementEvent_advertisementId_fkey"
    FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AdvertisementEvent_advertisementId_eventType_createdAt_idx"
  ON "AdvertisementEvent"("advertisementId", "eventType", "createdAt");
