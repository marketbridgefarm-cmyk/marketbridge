-- Step 12/13: operational and search indexes.
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE INDEX IF NOT EXISTS "Offer_expiry_status_idx" ON "Offer" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "Listing_agricultural_window_idx" ON "Listing" ("category", "status", "pickupWindowEnd");
CREATE INDEX IF NOT EXISTS "Advertisement_expiry_status_idx" ON "Advertisement" ("status", "endDate");
CREATE INDEX IF NOT EXISTS "Order_status_created_idx" ON "Order" ("status", "createdAt");

-- PostgreSQL full-text search index. This keeps search out of application-side
-- scanning as the listing table grows.
CREATE INDEX IF NOT EXISTS "Listing_search_tsv_idx"
ON "Listing"
USING GIN (
  to_tsvector('simple', concat_ws(' ', "title", "cropType", "description", "location"))
);
