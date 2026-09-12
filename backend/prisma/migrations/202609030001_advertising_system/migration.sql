-- Advertising production hardening. The preceding migration adds and commits
-- all AdStatus enum values before this migration uses them.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'AdvertisementEventType'
  ) THEN
    CREATE TYPE "AdvertisementEventType" AS ENUM ('IMPRESSION', 'CLICK');
  END IF;
END $$;

ALTER TABLE "Advertisement"
  ADD COLUMN IF NOT EXISTS "priceQuoted" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN IF NOT EXISTS "campaignReference" TEXT,
  ADD COLUMN IF NOT EXISTS "headline" TEXT,
  ADD COLUMN IF NOT EXISTS "destinationUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "creativeImageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "telegramPostReference" TEXT;

-- Preserve existing paid amounts as quoted prices where possible.
UPDATE "Advertisement"
SET "priceQuoted" = COALESCE("priceQuoted", "amountPaid", 0)
WHERE "priceQuoted" IS NULL;

ALTER TABLE "Advertisement"
  ALTER COLUMN "priceQuoted" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

UPDATE "Advertisement"
SET "campaignReference" = 'MB-AD-LEGACY-' || "id"
WHERE "campaignReference" IS NULL;

ALTER TABLE "Advertisement"
  ALTER COLUMN "campaignReference" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Advertisement_campaignReference_key"
  ON "Advertisement"("campaignReference");

CREATE INDEX IF NOT EXISTS "Advertisement_type_status_startDate_endDate_idx"
  ON "Advertisement"("type", "status", "startDate", "endDate");

CREATE INDEX IF NOT EXISTS "Advertisement_createdAt_idx"
  ON "Advertisement"("createdAt");

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
