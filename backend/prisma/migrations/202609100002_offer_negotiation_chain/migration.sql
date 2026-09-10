-- Harden agricultural negotiations without breaking existing offers.
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "Offer"
  ADD COLUMN IF NOT EXISTS "sellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "quantity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "parentOfferId" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Existing offers inherit the listing's seller. New offers are written with
-- sellerId by the API, so the relation can safely become required.
UPDATE "Offer" o
SET "sellerId" = l."sellerId"
FROM "Listing" l
WHERE o."listingId" = l."id"
  AND o."sellerId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Offer" WHERE "sellerId" IS NULL) THEN
    RAISE EXCEPTION 'Cannot make Offer.sellerId required: orphaned offers exist';
  END IF;
END $$;

ALTER TABLE "Offer"
  ALTER COLUMN "sellerId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Offer_sellerId_idx" ON "Offer"("sellerId");
CREATE INDEX IF NOT EXISTS "Offer_parentOfferId_idx" ON "Offer"("parentOfferId");
CREATE INDEX IF NOT EXISTS "Offer_expiresAt_idx" ON "Offer"("expiresAt");

ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_parentOfferId_fkey"
  FOREIGN KEY ("parentOfferId") REFERENCES "Offer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
