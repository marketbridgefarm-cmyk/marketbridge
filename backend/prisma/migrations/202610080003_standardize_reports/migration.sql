-- Standardize inspection and loading reports around one buyer-review envelope.
CREATE TYPE "BuyerReportReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

ALTER TABLE "InspectionReport"
  ADD COLUMN "reportVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "buyerReviewStatus" "BuyerReportReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "buyerReviewedAt" TIMESTAMP(3),
  ADD COLUMN "buyerReviewedById" TEXT,
  ADD COLUMN "buyerReviewNotes" TEXT;

ALTER TABLE "TransportLoadingReport"
  ADD COLUMN "reportVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "buyerReviewStatus" "BuyerReportReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "buyerReviewedAt" TIMESTAMP(3),
  ADD COLUMN "buyerReviewedById" TEXT,
  ADD COLUMN "buyerReviewNotes" TEXT;

CREATE INDEX "InspectionReport_buyerReviewStatus_idx" ON "InspectionReport"("buyerReviewStatus");
CREATE INDEX "TransportLoadingReport_buyerReviewStatus_idx" ON "TransportLoadingReport"("buyerReviewStatus");
