-- Seller payout hold/release/pay-out lifecycle.
-- See backend/src/services/sellerPayoutService.js for the full explanation.
-- One row per order's MARKETPLACE payment; created the moment that payment
-- settles PAID (see paymentService.js settlePayment). Existing orders that
-- already settled before this migration will not retroactively get a row
-- (nothing to backfill from — money already moved outside this system).

DO $$ BEGIN
  CREATE TYPE "SellerPayoutStatus" AS ENUM ('HELD', 'ON_HOLD_DISPUTE', 'RELEASED', 'PAID_OUT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SellerPayout" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ETB',
  "status" "SellerPayoutStatus" NOT NULL DEFAULT 'HELD',
  "releaseAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "paidOutAt" TIMESTAMP(3),
  "paidOutById" TEXT,
  "payoutReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SellerPayout_orderId_key" ON "SellerPayout"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "SellerPayout_paymentId_key" ON "SellerPayout"("paymentId");
CREATE INDEX IF NOT EXISTS "SellerPayout_sellerId_status_idx" ON "SellerPayout"("sellerId", "status");
CREATE INDEX IF NOT EXISTS "SellerPayout_status_releaseAt_idx" ON "SellerPayout"("status", "releaseAt");

DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_paidOutById_fkey"
    FOREIGN KEY ("paidOutById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
