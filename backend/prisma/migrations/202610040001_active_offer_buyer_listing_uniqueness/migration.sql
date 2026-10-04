-- Enforce one live buyer offer per listing at the database boundary.
-- Historical negotiation rows may repeat the same buyer/listing, but only one
-- active leaf/provisional offer may exist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "Offer_active_buyer_listing_unique"
ON "Offer" ("listingId", "buyerId")
WHERE "status" IN (
  'PENDING'::"OfferStatus",
  'SELECTED'::"OfferStatus",
  'COUNTERED'::"OfferStatus",
  'ACCEPTED'::"OfferStatus"
);
