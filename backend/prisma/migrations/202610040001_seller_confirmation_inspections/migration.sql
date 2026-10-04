ALTER TABLE "InspectionRequest"
  ADD COLUMN "sellerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "sellerMessage" TEXT,
  ADD COLUMN "sellerMessageAt" TIMESTAMP(3);
