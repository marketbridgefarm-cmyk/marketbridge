-- ============================================================================
-- TRANSPORT LOADING REPORT
-- ----------------------------------------------------------------------------
-- A structured record submitted by the truck owner at the pickup site, before
-- the truck may transition ACCEPTED -> PICKUP. Only reachable after every
-- payment on the order is settled (goods, inspection, transport), so the
-- photos and videos captured here are already post-payment.
--
-- The evidence itself lives in TransportEvidence (type = 'LOADING'); this
-- table stores the structured metadata that must be captured at the moment
-- of loading (what loaded, quantity, quality, timing, GPS).
-- ============================================================================

-- Add LOADING to the evidence type enum. PICKUP is kept for backward
-- compatibility with old rows that were uploaded before this change.
ALTER TYPE "TransportEvidenceType" ADD VALUE IF NOT EXISTS 'LOADING';

-- ---------------------------------------------------------------------------
-- TransportLoadingReport — one per transport job, immutable once submitted
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "TransportLoadingReport" (
  "id" TEXT NOT NULL,
  "transportJobId" TEXT NOT NULL,
  "submittedById" TEXT NOT NULL,

  -- What loaded: "As listed" | "Same product, different variety"
  --              | "Partial of listed product" | "Different product"
  --              | "Refused to load"
  "whatLoaded" TEXT NOT NULL,

  -- Quantity recorded by the driver at pickup. AmountPicker-only input.
  "quantityLoaded" DECIMAL(18,2) NOT NULL,
  "quantityUnit" TEXT,

  -- Quality snapshot: "As inspected" | "Minor variance" | "Major variance"
  --                   | "Damaged" | "Not inspected"
  "qualityAtLoading" TEXT,

  -- Multi-select issue flags. Same 8 values the driver ticks.
  "visibleIssues" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Time tracking. loadingFinishedAt >= loadingStartedAt >= arrivedAt enforced
  -- in the route handler, since Postgres CHECK cannot easily compare
  -- nullable columns without a full constraint rewrite.
  "arrivedAt" TIMESTAMP(3),
  "loadingStartedAt" TIMESTAMP(3),
  "loadingFinishedAt" TIMESTAMP(3),

  "gpsLocation" TEXT,
  "notes" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TransportLoadingReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportLoadingReport_transportJobId_key"
    UNIQUE ("transportJobId"),
  CONSTRAINT "TransportLoadingReport_transportJobId_fkey"
    FOREIGN KEY ("transportJobId") REFERENCES "TransportJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TransportLoadingReport_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TransportLoadingReport_transportJobId_idx"
  ON "TransportLoadingReport"("transportJobId");
CREATE INDEX IF NOT EXISTS "TransportLoadingReport_submittedById_idx"
  ON "TransportLoadingReport"("submittedById");
CREATE INDEX IF NOT EXISTS "TransportLoadingReport_createdAt_idx"
  ON "TransportLoadingReport"("createdAt");
