-- ============================================================================
-- INSPECTION COORDINATION (seller <-> inspector operational handoff)
-- ----------------------------------------------------------------------------
-- Contact data is deliberately NOT stored on InspectionRequest (which is read
-- by buyer-facing endpoints). It lives here, gated by the inspection status,
-- so no public/order/inspection endpoint can leak it accidentally.
-- Safe on the existing production database: both tables are new.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "InspectionCoordination" (
  "id" TEXT NOT NULL,
  "inspectionRequestId" TEXT NOT NULL,

  -- Seller-side operational handoff (the party hosting the physical site).
  "sellerContactName"      TEXT,
  "sellerPhone"            TEXT,
  "sellerAlternativePhone" TEXT,
  "sellerEmail"            TEXT,
  "sellerPreferredContact" TEXT,
  "inspectionSite"         TEXT,
  "meetingPoint"           TEXT,
  "accessInstructions"     TEXT,
  "sellerNotes"            TEXT,
  "sellerSubmittedAt"      TIMESTAMP(3),

  -- Inspector-side operational handoff (the party travelling to the site).
  "inspectorContactName"      TEXT,
  "inspectorPhone"            TEXT,
  "inspectorAlternativePhone" TEXT,
  "inspectorEmail"            TEXT,
  "inspectorPreferredContact" TEXT,
  "inspectorArrivalNotes"     TEXT,
  "inspectorNotes"            TEXT,
  "inspectorSubmittedAt"      TIMESTAMP(3),

  -- Reassignment lifecycle: set when an accepted inspector withdraws, admin
  -- reopens bidding, or a recovery request is approved. A closed row is never
  -- returned to the next inspector — otherwise the previous inspector's
  -- phone number would leak on reassignment.
  "supersededAt" TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InspectionCoordination_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InspectionCoordination_inspectionRequestId_key"
    UNIQUE ("inspectionRequestId"),
  CONSTRAINT "InspectionCoordination_inspectionRequestId_fkey"
    FOREIGN KEY ("inspectionRequestId")
    REFERENCES "InspectionRequest"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "InspectionCoordination_inspectionRequestId_idx"
  ON "InspectionCoordination"("inspectionRequestId");

CREATE INDEX IF NOT EXISTS "InspectionCoordination_supersededAt_idx"
  ON "InspectionCoordination"("supersededAt");

-- ============================================================================
-- INSPECTION AVAILABILITY (repeatable date/time slots per party)
-- ----------------------------------------------------------------------------
-- One row per window. Separate rows (rather than a single text blob) so the
-- schedule can be queried, matched, edited, and conflict-checked later.
-- party = 'SELLER' | 'INSPECTOR' — the party the slot belongs to.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "InspectionAvailability" (
  "id" TEXT NOT NULL,
  "inspectionRequestId" TEXT NOT NULL,
  "party" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "startTime" TEXT NOT NULL,   -- "HH:MM" 24h, local
  "endTime"   TEXT NOT NULL,   -- "HH:MM" 24h, local
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InspectionAvailability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InspectionAvailability_party_check"
    CHECK ("party" IN ('SELLER', 'INSPECTOR')),
  CONSTRAINT "InspectionAvailability_time_check"
    CHECK ("startTime" < "endTime"),
  CONSTRAINT "InspectionAvailability_inspectionRequestId_fkey"
    FOREIGN KEY ("inspectionRequestId")
    REFERENCES "InspectionRequest"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "InspectionAvailability_request_party_idx"
  ON "InspectionAvailability"("inspectionRequestId", "party");

CREATE INDEX IF NOT EXISTS "InspectionAvailability_request_date_idx"
  ON "InspectionAvailability"("inspectionRequestId", "date");
