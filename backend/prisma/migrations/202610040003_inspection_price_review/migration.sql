CREATE TABLE "PriceReview" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "proposedById" TEXT NOT NULL,
  "proposedPrice" DECIMAL(18,2) NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "parentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PriceReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PriceReview_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PriceReview_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PriceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PriceReview_orderId_createdAt_idx" ON "PriceReview"("orderId", "createdAt");
CREATE INDEX "PriceReview_status_idx" ON "PriceReview"("status");
CREATE INDEX "PriceReview_parentId_idx" ON "PriceReview"("parentId");
-- A single live proposal per order prevents concurrent buyer/seller requests.
CREATE UNIQUE INDEX "PriceReview_one_pending_per_order_idx"
  ON "PriceReview"("orderId") WHERE "status" = 'PENDING';
