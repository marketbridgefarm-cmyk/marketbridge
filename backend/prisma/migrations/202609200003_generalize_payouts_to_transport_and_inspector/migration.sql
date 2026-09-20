-- Generalizes SellerPayout into Payout, covering TRANSPORTER_EARNING and
-- INSPECTOR_EARNING alongside SELLER_EARNING. See
-- backend/src/services/payoutService.js for the lifecycle explanation.
--
-- Every existing row is a seller payout (this table previously only ever
-- held those), so the backfill below is exact: no data is guessed.
--
-- orderId stops being unique/required: an order can now carry up to three
-- payout rows (seller, transporter, inspector), and an inspector payout
-- may predate an order entirely (pre-order inspections).

-- --------------------------------------------------------------------------
-- New enum for who is owed the payout
-- --------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "PayoutPayeeRole" AS ENUM ('SELLER', 'TRANSPORTER', 'INSPECTOR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- Rename the status enum to match the generalized table
-- --------------------------------------------------------------------------

ALTER TYPE "SellerPayoutStatus" RENAME TO "PayoutStatus";

-- --------------------------------------------------------------------------
-- Rename table and columns
-- --------------------------------------------------------------------------

ALTER TABLE "SellerPayout" RENAME TO "Payout";
ALTER TABLE "Payout" RENAME COLUMN "sellerId" TO "payeeId";

-- --------------------------------------------------------------------------
-- Backfill payeeRole for existing (all-seller) rows, then make it required
-- --------------------------------------------------------------------------

ALTER TABLE "Payout" ADD COLUMN "payeeRole" "PayoutPayeeRole";
UPDATE "Payout" SET "payeeRole" = 'SELLER' WHERE "payeeRole" IS NULL;
ALTER TABLE "Payout" ALTER COLUMN "payeeRole" SET NOT NULL;

-- --------------------------------------------------------------------------
-- orderId: drop uniqueness and required-ness (see comment above)
-- --------------------------------------------------------------------------

DROP INDEX IF EXISTS "SellerPayout_orderId_key";
ALTER TABLE "Payout" ALTER COLUMN "orderId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "Payout_orderId_idx" ON "Payout"("orderId");

-- --------------------------------------------------------------------------
-- Rename remaining constraints/indexes for consistency with the new name
-- --------------------------------------------------------------------------

ALTER TABLE "Payout" RENAME CONSTRAINT "SellerPayout_pkey" TO "Payout_pkey";
ALTER TABLE "Payout" RENAME CONSTRAINT "SellerPayout_orderId_fkey" TO "Payout_orderId_fkey";
ALTER TABLE "Payout" RENAME CONSTRAINT "SellerPayout_sellerId_fkey" TO "Payout_payeeId_fkey";
ALTER TABLE "Payout" RENAME CONSTRAINT "SellerPayout_paymentId_fkey" TO "Payout_paymentId_fkey";
ALTER TABLE "Payout" RENAME CONSTRAINT "SellerPayout_paidOutById_fkey" TO "Payout_paidOutById_fkey";

ALTER INDEX "SellerPayout_paymentId_key" RENAME TO "Payout_paymentId_key";
ALTER INDEX "SellerPayout_sellerId_status_idx" RENAME TO "Payout_payeeId_status_idx";
ALTER INDEX "SellerPayout_status_releaseAt_idx" RENAME TO "Payout_status_releaseAt_idx";

CREATE INDEX IF NOT EXISTS "Payout_payeeRole_status_idx" ON "Payout"("payeeRole", "status");
