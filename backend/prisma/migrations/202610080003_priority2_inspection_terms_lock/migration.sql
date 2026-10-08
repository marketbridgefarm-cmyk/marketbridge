-- Priority 2: make seller-confirmed inspection commercial terms immutable by snapshot.
ALTER TABLE "InspectionRequest" ADD COLUMN "feeTermsLockedAt" TIMESTAMP(3);
ALTER TABLE "InspectionRequest" ADD COLUMN "lockedFee" DECIMAL(18,2);
ALTER TABLE "InspectionRequest" ADD COLUMN "lockedFeePayer" "InspectionFeePayer";
ALTER TABLE "InspectionRequest" ADD COLUMN "lockedBuyerFeeAmount" DECIMAL(18,2);
ALTER TABLE "InspectionRequest" ADD COLUMN "lockedSellerFeeAmount" DECIMAL(18,2);

CREATE INDEX "InspectionRequest_feeTermsLockedAt_idx" ON "InspectionRequest"("feeTermsLockedAt");

-- Backfill already-confirmed inspections from their existing negotiated terms.
UPDATE "InspectionRequest"
SET
  "feeTermsLockedAt" = COALESCE("sellerConfirmedAt", "updatedAt"),
  "lockedFee" = "fee",
  "lockedFeePayer" = "feePayer",
  "lockedBuyerFeeAmount" = "buyerFeeAmount",
  "lockedSellerFeeAmount" = "sellerFeeAmount"
WHERE "sellerConfirmedAt" IS NOT NULL
  AND "fee" IS NOT NULL
  AND "feeTermsLockedAt" IS NULL;
