-- Add explicit ownership of the latest counter-offer.
-- This allows MarketBridge to enforce whose turn it is
-- during buyer <-> seller negotiations.

CREATE TYPE "OfferCounterParty" AS ENUM (
  'BUYER',
  'SELLER'
);

ALTER TABLE "Offer"
ADD COLUMN "counteredBy" "OfferCounterParty";

CREATE INDEX "Offer_counteredBy_idx"
ON "Offer"("counteredBy");
