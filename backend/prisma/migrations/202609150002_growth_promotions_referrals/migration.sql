CREATE TYPE "PromotionDiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

CREATE TABLE "PromotionCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "discountType" "PromotionDiscountType" NOT NULL,
  "discountValue" DECIMAL(18,2) NOT NULL,
  "maxDiscount" DECIMAL(18,2),
  "minimumSubtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "maxUses" INTEGER,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromotionCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromotionCode_code_key" ON "PromotionCode"("code");
CREATE INDEX "PromotionCode_active_startsAt_endsAt_idx" ON "PromotionCode"("active", "startsAt", "endsAt");

CREATE TABLE "PromotionRedemption" (
  "id" TEXT NOT NULL,
  "promotionCodeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT,
  "discountAmount" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromotionRedemption_promotionCodeId_userId_key" ON "PromotionRedemption"("promotionCodeId", "userId");
CREATE UNIQUE INDEX "PromotionRedemption_orderId_key" ON "PromotionRedemption"("orderId");
CREATE INDEX "PromotionRedemption_userId_createdAt_idx" ON "PromotionRedemption"("userId", "createdAt");
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionCodeId_fkey" FOREIGN KEY ("promotionCodeId") REFERENCES "PromotionCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "claimCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE UNIQUE INDEX "ReferralCode_ownerId_key" ON "ReferralCode"("ownerId");
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReferralClaim" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralClaim_referralCodeId_userId_key" ON "ReferralClaim"("referralCodeId", "userId");
CREATE INDEX "ReferralClaim_userId_createdAt_idx" ON "ReferralClaim"("userId", "createdAt");
ALTER TABLE "ReferralClaim" ADD CONSTRAINT "ReferralClaim_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralClaim" ADD CONSTRAINT "ReferralClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order" ADD COLUMN "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "promotionCodeId" TEXT;
CREATE INDEX "Order_promotionCodeId_idx" ON "Order"("promotionCodeId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_promotionCodeId_fkey" FOREIGN KEY ("promotionCodeId") REFERENCES "PromotionCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
