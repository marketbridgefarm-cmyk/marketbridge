-- Listing-level notices for waiting bidders.
CREATE TABLE "OfferNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "offerId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "metadata" JSONB,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfferNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OfferNotification_userId_readAt_createdAt_idx" ON "OfferNotification"("userId", "readAt", "createdAt");
CREATE INDEX "OfferNotification_listingId_idx" ON "OfferNotification"("listingId");

ALTER TABLE "OfferNotification"
  ADD CONSTRAINT "OfferNotification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
