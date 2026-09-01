-- MarketBridge security and digital purchase hardening
ALTER TYPE "PaymentType" ADD VALUE IF NOT EXISTS 'DIGITAL';
CREATE TYPE "DigitalPurchaseStatus" AS ENUM ('PENDING','COMPLETED','REFUNDED','CANCELLED');
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "digitalProductId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "advertisementId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "providerTransactionId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE IF NOT EXISTS "DigitalPurchase" (
  "id" TEXT NOT NULL, "productId" TEXT NOT NULL, "buyerId" TEXT NOT NULL, "paymentId" TEXT NOT NULL,
  "status" "DigitalPurchaseStatus" NOT NULL DEFAULT 'PENDING', "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DigitalPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DigitalPurchase_paymentId_key" ON "DigitalPurchase"("paymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "DigitalPurchase_productId_buyerId_key" ON "DigitalPurchase"("productId","buyerId");
CREATE INDEX IF NOT EXISTS "DigitalPurchase_buyerId_idx" ON "DigitalPurchase"("buyerId");
CREATE INDEX IF NOT EXISTS "DigitalPurchase_productId_idx" ON "DigitalPurchase"("productId");
CREATE INDEX IF NOT EXISTS "DigitalPurchase_status_idx" ON "DigitalPurchase"("status");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_digitalProductId_fkey" FOREIGN KEY ("digitalProductId") REFERENCES "DigitalProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DigitalPurchase" ADD CONSTRAINT "DigitalPurchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DigitalProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DigitalPurchase" ADD CONSTRAINT "DigitalPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DigitalPurchase" ADD CONSTRAINT "DigitalPurchase_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_provider_providerTransactionId_key" ON "Payment"("provider","providerTransactionId");
CREATE INDEX IF NOT EXISTS "Payment_createdById_idx" ON "Payment"("createdById");
CREATE INDEX IF NOT EXISTS "Payment_digitalProductId_idx" ON "Payment"("digitalProductId");
CREATE INDEX IF NOT EXISTS "Payment_advertisementId_idx" ON "Payment"("advertisementId");
DELETE FROM "Rating" a USING "Rating" b
WHERE a.id > b.id
  AND a."orderId" = b."orderId"
  AND a."fromUserId" = b."fromUserId"
  AND a."toUserId" = b."toUserId"
  AND a.role = b.role;
CREATE UNIQUE INDEX IF NOT EXISTS "Rating_orderId_fromUserId_toUserId_role_key" ON "Rating"("orderId","fromUserId","toUserId","role");
