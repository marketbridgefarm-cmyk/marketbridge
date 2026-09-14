-- A listing may have at most one non-cancelled order.
--
-- This is intentionally a PostgreSQL partial unique index because Prisma's
-- schema-level @@unique cannot express the business rule "unique unless the
-- order is CANCELLED". It is the database backstop for the application-level
-- ACTIVE -> SOLD atomic sale claim.
CREATE UNIQUE INDEX "Order_listingId_active_unique"
ON "Order" ("listingId")
WHERE "status" <> 'CANCELLED';
