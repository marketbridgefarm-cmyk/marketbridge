ALTER TABLE "TransportJob"
  ADD COLUMN "sellerPickupConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "sellerPickupMessage" TEXT,
  ADD COLUMN "sellerPickupMessageAt" TIMESTAMP(3);
