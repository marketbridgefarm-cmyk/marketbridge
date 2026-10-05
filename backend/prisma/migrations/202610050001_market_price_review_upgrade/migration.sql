-- Market-price evidence snapshots and immutable original order price.
ALTER TABLE "Offer"
  ADD COLUMN "marketReferenceUnitPrice" DECIMAL(18,2),
  ADD COLUMN "marketReferenceTotalPrice" DECIMAL(18,2),
  ADD COLUMN "marketReferenceSource" TEXT,
  ADD COLUMN "marketReferenceDate" TIMESTAMP(3),
  ADD COLUMN "marketReferenceLocation" TEXT,
  ADD COLUMN "marketReferenceUnit" TEXT,
  ADD COLUMN "marketSampleSize" INTEGER,
  ADD COLUMN "marketMinUnitPrice" DECIMAL(18,2),
  ADD COLUMN "marketMaxUnitPrice" DECIMAL(18,2);

ALTER TABLE "Order"
  ADD COLUMN "originalFinalPrice" DECIMAL(18,2);

UPDATE "Order"
SET "originalFinalPrice" = "finalPrice"
WHERE "originalFinalPrice" IS NULL;

ALTER TABLE "PriceReview"
  ADD COLUMN "marketReferenceUnitPrice" DECIMAL(18,2),
  ADD COLUMN "marketReferenceTotalPrice" DECIMAL(18,2),
  ADD COLUMN "marketReferenceSource" TEXT,
  ADD COLUMN "marketReferenceDate" TIMESTAMP(3),
  ADD COLUMN "marketReferenceLocation" TEXT,
  ADD COLUMN "marketReferenceUnit" TEXT,
  ADD COLUMN "marketSampleSize" INTEGER,
  ADD COLUMN "marketMinUnitPrice" DECIMAL(18,2),
  ADD COLUMN "marketMaxUnitPrice" DECIMAL(18,2),
  ADD COLUMN "originalUnitPrice" DECIMAL(18,2),
  ADD COLUMN "inspectedQuantity" DOUBLE PRECISION,
  ADD COLUMN "quantityAdjustedPrice" DECIMAL(18,2),
  ADD COLUMN "suggestedPrice" DECIMAL(18,2),
  ADD COLUMN "adjustmentAmount" DECIMAL(18,2),
  ADD COLUMN "adjustmentPercent" DOUBLE PRECISION,
  ADD COLUMN "calculationVersion" TEXT;

CREATE INDEX "PriceReview_marketReferenceDate_idx" ON "PriceReview"("marketReferenceDate");
