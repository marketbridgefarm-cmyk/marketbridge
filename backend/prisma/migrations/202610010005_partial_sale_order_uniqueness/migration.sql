-- P1: A listing may have one live/provisional order at a time, but it may
-- have many historical COMPLETED orders when inventory was sold in partial
-- quantities. CANCELLED orders are also historical and must not block future
-- sales.
DROP INDEX IF EXISTS "Order_listingId_active_unique";

CREATE UNIQUE INDEX "Order_listingId_active_unique"
ON "Order" ("listingId")
WHERE "status" NOT IN ('CANCELLED', 'COMPLETED');
