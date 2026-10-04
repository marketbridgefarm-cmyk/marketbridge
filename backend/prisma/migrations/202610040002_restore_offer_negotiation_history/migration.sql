-- Restore historical Offer negotiation chains.
--
-- Offer rows intentionally repeat the same (listingId, buyerId) pair because
-- every seller/buyer counter is a new child row linked by parentOfferId.
-- The application already prevents a buyer from opening a second independent
-- negotiation by checking for an active leaf offer.
--
-- The 202610040001 migration incorrectly introduced a partial unique index on
-- (listingId, buyerId). Drop it at the database boundary.
DROP INDEX IF EXISTS "Offer_active_buyer_listing_unique";

-- Keep lookup performance for the application-level active-leaf check.
CREATE INDEX IF NOT EXISTS "Offer_listingId_buyerId_status_idx"
  ON "Offer" ("listingId", "buyerId", "status");
