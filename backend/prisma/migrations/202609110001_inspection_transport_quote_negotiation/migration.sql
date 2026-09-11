-- Allow inspection and transport quotes to be negotiated back and forth
-- (buyer/seller <-> inspector, buyer/seller <-> truck owner), the same way
-- Offer already supports buyer <-> seller negotiation.

ALTER TYPE "InspectionQuoteStatus" ADD VALUE IF NOT EXISTS 'COUNTERED';
ALTER TYPE "InspectionQuoteStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "TransportQuoteStatus" ADD VALUE IF NOT EXISTS 'COUNTERED';
ALTER TYPE "TransportQuoteStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuoteCounterParty') THEN
    CREATE TYPE "QuoteCounterParty" AS ENUM ('REQUESTER', 'PROVIDER');
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- InspectionQuote
-- ----------------------------------------------------------------------

ALTER TABLE "InspectionQuote"
  ADD COLUMN IF NOT EXISTS "parentQuoteId" TEXT,
  ADD COLUMN IF NOT EXISTS "counterAmount" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "counteredBy" "QuoteCounterParty",
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- A negotiation chain reuses the same (inspectionRequestId, inspectorId)
-- pair across parent/child rows, so the old one-quote-per-inspector unique
-- constraint no longer holds. Active-quote uniqueness is now enforced in
-- application code, the same way Offer enforces one active negotiation
-- per buyer/listing.
ALTER TABLE "InspectionQuote" DROP CONSTRAINT IF EXISTS "InspectionQuote_inspectionRequestId_inspectorId_key";

CREATE INDEX IF NOT EXISTS "InspectionQuote_parentQuoteId_idx" ON "InspectionQuote"("parentQuoteId");
CREATE INDEX IF NOT EXISTS "InspectionQuote_expiresAt_idx" ON "InspectionQuote"("expiresAt");

ALTER TABLE "InspectionQuote"
  ADD CONSTRAINT "InspectionQuote_parentQuoteId_fkey"
  FOREIGN KEY ("parentQuoteId") REFERENCES "InspectionQuote"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------
-- TransportQuote
-- ----------------------------------------------------------------------

ALTER TABLE "TransportQuote"
  ADD COLUMN IF NOT EXISTS "parentQuoteId" TEXT,
  ADD COLUMN IF NOT EXISTS "counterAmount" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "counteredBy" "QuoteCounterParty",
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

ALTER TABLE "TransportQuote" DROP CONSTRAINT IF EXISTS "TransportQuote_transportJobId_truckOwnerId_truckId_key";

CREATE INDEX IF NOT EXISTS "TransportQuote_parentQuoteId_idx" ON "TransportQuote"("parentQuoteId");
CREATE INDEX IF NOT EXISTS "TransportQuote_expiresAt_idx" ON "TransportQuote"("expiresAt");

ALTER TABLE "TransportQuote"
  ADD CONSTRAINT "TransportQuote_parentQuoteId_fkey"
  FOREIGN KEY ("parentQuoteId") REFERENCES "TransportQuote"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
