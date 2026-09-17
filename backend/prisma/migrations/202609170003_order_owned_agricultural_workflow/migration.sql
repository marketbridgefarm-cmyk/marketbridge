-- Bind agricultural inspections to the exact order/agreement they belong to.
-- Existing rows are backfilled to the current non-cancelled order for the listing
-- where one exists. orderId remains nullable for legacy pre-order inspections;
-- all new application-created inspections require orderId.
ALTER TABLE "InspectionRequest" ADD COLUMN "orderId" TEXT;

CREATE INDEX "InspectionRequest_orderId_idx" ON "InspectionRequest"("orderId");

UPDATE "InspectionRequest" ir
SET "orderId" = x."id"
FROM (
  SELECT DISTINCT ON (o."listingId") o."id", o."listingId"
  FROM "Order" o
  WHERE o."status" <> 'CANCELLED'
  ORDER BY o."listingId", o."createdAt" DESC
) x
WHERE ir."orderId" IS NULL
  AND ir."listingId" = x."listingId";

ALTER TABLE "InspectionRequest"
  ADD CONSTRAINT "InspectionRequest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exact accepted negotiation that created an order.
ALTER TABLE "Order" ADD COLUMN "agreedOfferId" TEXT;
ALTER TABLE "Order" ADD COLUMN "agreedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Order_agreedOfferId_key" ON "Order"("agreedOfferId");
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_agreedOfferId_fkey"
  FOREIGN KEY ("agreedOfferId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Recover the accepted offer for existing orders where the audit trail records it.
UPDATE "Order" o
SET "agreedOfferId" = e.offer_id
FROM (
  SELECT DISTINCT ON (oe."orderId") oe."orderId", (oe."metadata"->>'offerId') AS offer_id
  FROM "OrderEvent" oe
  WHERE oe."type" = 'ORDER_CREATED'
    AND (oe."metadata"->>'offerId') IS NOT NULL
  ORDER BY oe."orderId", oe."createdAt" ASC
) e
WHERE o."id" = e."orderId"
  AND o."agreedOfferId" IS NULL;

UPDATE "Order" o
SET "agreedAt" = o."createdAt"
WHERE o."agreedOfferId" IS NOT NULL
  AND o."agreedAt" IS NULL;
