-- Step 12/13: operational and search indexes.
-- Corrected for PostgreSQL IMMUTABLE index-expression requirements.
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE INDEX IF NOT EXISTS "Offer_expiry_status_idx" ON "Offer" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "Listing_agricultural_window_idx" ON "Listing" ("category", "status", "pickupWindowEnd");
CREATE INDEX IF NOT EXISTS "Advertisement_expiry_status_idx" ON "Advertisement" ("status", "endDate");
CREATE INDEX IF NOT EXISTS "Order_status_created_idx" ON "Order" ("status", "createdAt");

-- PostgreSQL full-text search index.
-- Do not use concat_ws() here: PostgreSQL does not consider it immutable,
-- so it cannot be used in an index expression. COALESCE + || is immutable
-- for the text operations used by this expression.
CREATE INDEX IF NOT EXISTS "Listing_search_tsv_idx"
ON "Listing"
USING GIN (
  to_tsvector(
    'simple',
    COALESCE("title", '') || ' ' ||
    COALESCE("cropType", '') || ' ' ||
    COALESCE("description", '') || ' ' ||
    COALESCE("location", '')
  )
);
