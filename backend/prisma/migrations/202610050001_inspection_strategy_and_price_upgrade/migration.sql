-- MarketBridge inspection strategy + advisory market-price upgrade.
-- Safe for the existing production database: all new scalar columns are nullable
-- or have defaults, and existing agricultural listings are explicitly migrated
-- to require inspection.

ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'STALLED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InspectionFeePayer') THEN
    CREATE TYPE "InspectionFeePayer" AS ENUM ('BUYER', 'SELLER', 'SPLIT');
  END IF;
END $$;

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "inspectionRequired" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Listing"
SET "inspectionRequired" = true
WHERE "category" = 'AGRICULTURAL';

ALTER TABLE "Offer"
  ADD COLUMN IF NOT EXISTS "negotiationDeadlineAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "marketReferenceUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketReferenceTotalPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketReferenceSource" TEXT,
  ADD COLUMN IF NOT EXISTS "marketReferenceDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "marketReferenceLocation" TEXT,
  ADD COLUMN IF NOT EXISTS "marketReferenceUnit" TEXT,
  ADD COLUMN IF NOT EXISTS "marketSampleSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "marketMinUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketMaxUnitPrice" DECIMAL(18,2);

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "originalFinalPrice" DECIMAL(18,2);

UPDATE "Order"
SET "originalFinalPrice" = "finalPrice"
WHERE "originalFinalPrice" IS NULL;

ALTER TABLE "InspectionRequest"
  ADD COLUMN IF NOT EXISTS "feePayer" "InspectionFeePayer" NOT NULL DEFAULT 'BUYER',
  ADD COLUMN IF NOT EXISTS "buyerFeeAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "sellerFeeAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "startDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completionDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Preserve the historical payer rule for existing requests.
UPDATE "InspectionRequest"
SET "feePayer" = CASE
  WHEN "mode" = 'SELLER_REQUESTED' THEN 'SELLER'::"InspectionFeePayer"
  ELSE 'BUYER'::"InspectionFeePayer"
END
WHERE "feePayer" = 'BUYER'::"InspectionFeePayer";

UPDATE "InspectionRequest"
SET "buyerFeeAmount" = CASE WHEN "feePayer" = 'BUYER'::"InspectionFeePayer" THEN "fee" ELSE NULL END,
    "sellerFeeAmount" = CASE WHEN "feePayer" = 'SELLER'::"InspectionFeePayer" THEN "fee" ELSE NULL END
WHERE "fee" IS NOT NULL;

ALTER TABLE "InspectionReport"
  ADD COLUMN IF NOT EXISTS "assessmentSummary" TEXT,
  ADD COLUMN IF NOT EXISTS "qualityFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "quantityVariancePercent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "reportLockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PriceReview"
  ADD COLUMN IF NOT EXISTS "marketReferenceUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketReferenceTotalPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketReferenceSource" TEXT,
  ADD COLUMN IF NOT EXISTS "marketReferenceDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "marketReferenceLocation" TEXT,
  ADD COLUMN IF NOT EXISTS "marketReferenceUnit" TEXT,
  ADD COLUMN IF NOT EXISTS "marketSampleSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "marketMinUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "marketMaxUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "originalUnitPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "inspectedQuantity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "quantityAdjustedPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "suggestedPrice" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "adjustmentAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "adjustmentPercent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "calculationVersion" TEXT;

CREATE TABLE IF NOT EXISTS "InspectionReportAddendum" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "videos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "gpsLocation" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InspectionReportAddendum_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InspectionReportAddendum_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "InspectionReport"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InspectionReportAddendum_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "InspectionReportAddendum_reportId_createdAt_idx"
  ON "InspectionReportAddendum"("reportId", "createdAt");
CREATE INDEX IF NOT EXISTS "InspectionReportAddendum_createdById_createdAt_idx"
  ON "InspectionReportAddendum"("createdById", "createdAt");

CREATE INDEX IF NOT EXISTS "InspectionRequest_startDueAt_idx"
  ON "InspectionRequest"("startDueAt");
CREATE INDEX IF NOT EXISTS "InspectionRequest_completionDueAt_idx"
  ON "InspectionRequest"("completionDueAt");
CREATE INDEX IF NOT EXISTS "Offer_negotiationDeadlineAt_idx"
  ON "Offer"("negotiationDeadlineAt");
