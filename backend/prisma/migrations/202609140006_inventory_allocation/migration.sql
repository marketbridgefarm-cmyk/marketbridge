-- Step 9: quantity allocation for agricultural listings.
-- Agricultural listings may have multiple partial orders, so the Step 7
-- listing-wide non-cancelled order uniqueness constraint is removed.
DROP INDEX IF EXISTS "Order_listingId_active_unique";

ALTER TABLE "Listing"
  ADD COLUMN "availableQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Existing listings are treated as fully available before this migration,
-- except listings with an existing non-cancelled order, which were sold as a
-- whole listing under the previous model.
UPDATE "Listing" l
SET "availableQuantity" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "Order" o
    WHERE o."listingId" = l.id AND o."status" <> 'CANCELLED'
  ) THEN 0
  ELSE l.quantity
END;

ALTER TABLE "Order"
  ADD COLUMN "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "Order" o
SET quantity = l.quantity
FROM "Listing" l
WHERE l.id = o."listingId";

CREATE INDEX IF NOT EXISTS "Listing_availableQuantity_status_idx"
  ON "Listing" ("status", "availableQuantity");

CREATE INDEX IF NOT EXISTS "Order_listingId_status_idx"
  ON "Order" ("listingId", "status");
