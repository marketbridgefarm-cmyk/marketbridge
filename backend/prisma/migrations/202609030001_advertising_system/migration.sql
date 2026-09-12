-- Advertising production hardening.
-- Existing enum values remain for backwards compatibility; new campaigns use
-- the explicit lifecycle below.
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PAID_PENDING_REVIEW';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';

CREATE TYPE "AdvertisementEventType" AS ENUM ('IMPRESSION', 'CLICK');

ALTER TABLE "Advertisement"
  ADD COLUMN "priceQuoted" DOUBLE PRECISION,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "campaignReference" TEXT,
  ADD COLUMN "headline" TEXT,
  ADD COLUMN "destinationUrl" TEXT,
  ADD COLUMN "creativeImageKey" TEXT,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "telegramPostReference" TEXT;

-- Preserve existing paid amounts as their quoted price where possible. For
-- old unpaid rows, amountPaid may remain NULL and admins can review them.
UPDATE "Advertisement"
SET "priceQuoted" = COALESCE("amountPaid", 0)
WHERE "priceQuoted" IS NULL;

ALTER TABLE "Advertisement"
  ALTER COLUMN "priceQuoted" SET NOT NULL;

UPDATE "Advertisement"
SET "campaignReference" = 'MB-AD-LEGACY-' || "id"
WHERE "campaignReference" IS NULL;

ALTER TABLE "Advertisement"
  ALTER COLUMN "campaignReference" SET NOT NULL;

CREATE UNIQUE INDEX "Advertisement_campaignReference_key"
  ON "Advertisement"("campaignReference");

CREATE INDEX "Advertisement_type_status_startDate_endDate_idx"
  ON "Advertisement"("type", "status", "startDate", "endDate");

CREATE INDEX "Advertisement_createdAt_idx"
  ON "Advertisement"("createdAt");

CREATE TABLE "AdvertisementEvent" (
  "id" TEXT NOT NULL,
  "advertisementId" TEXT NOT NULL,
  "eventType" "AdvertisementEventType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvertisementEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdvertisementEvent_advertisementId_fkey"
    FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AdvertisementEvent_advertisementId_eventType_createdAt_idx"
  ON "AdvertisementEvent"("advertisementId", "eventType", "createdAt");

