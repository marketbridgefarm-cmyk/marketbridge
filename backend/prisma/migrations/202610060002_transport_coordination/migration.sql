-- ============================================================================
-- TRANSPORT COORDINATION (seller <-> transporter operational handoff)
-- ----------------------------------------------------------------------------
-- Contact data is deliberately NOT stored on TransportJob (which is read by
-- buyer-facing endpoints). It lives here, gated by the transport status, so
-- no order, listing, or public endpoint can leak it accidentally.
--
-- Access rule (enforced server-side, not in this schema):
--   • Visible only to the seller of the listing and the assigned transporter.
--   • Visible only once the transport job is ACCEPTED (payment settled).
--   • NEVER visible to the buyer, even though the buyer pays the transport fee.
--   • Admin override for support, always audited.
--
-- One row per transport job. Both parties write into the same row using their
-- own field prefix. On transporter reassignment the row is superseded rather
-- than deleted, so the previous driver's phone number does not leak to the
-- next one.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TransportCoordination" (
  "id" TEXT NOT NULL,
  "transportJobId" TEXT NOT NULL,

  -- ── Seller-side operational handoff (party hosting the pickup site) ──────
  "sellerContactName"      TEXT,
  "sellerPhone"            TEXT,
  "sellerAlternativePhone" TEXT,
  "sellerEmail"            TEXT,
  "sellerPreferredContact" TEXT,   -- "PHONE" | "EMAIL" | "IN_APP" | free text
  "pickupSite"             TEXT,
  "meetingPoint"           TEXT,
  "accessInstructions"     TEXT,
  "sellerPrepNotes"        TEXT,

  -- Prep evidence the seller wants the driver to see before arrival.
  -- Private object-storage keys; the buyer never receives these.
  "sellerSitePhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sellerPrepPhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "sellerSubmittedAt" TIMESTAMP(3),

  -- ── Transporter-side operational handoff (party arriving at the site) ────
  "driverContactName"      TEXT,
  "driverPhone"            TEXT,
  "driverAlternativePhone" TEXT,
  "driverEmail"            TEXT,
  "driverPreferredContact" TEXT,
  "driverArrivalEta"       TIMESTAMP(3),
  "driverArrivalNotes"     TEXT,
  "driverEquipment"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "driverNotes"            TEXT,

  "driverSubmittedAt" TIMESTAMP(3),

  -- ── Reassignment lifecycle ───────────────────────────────────────────────
  -- Set when an accepted transporter is released, admin reopens bidding, or a
  -- recovery request is approved. A superseded row is never returned to the
  -- next driver — otherwise the previous driver's phone would leak.
  "supersededAt" TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TransportCoordination_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportCoordination_transportJobId_key"
    UNIQUE ("transportJobId"),
  CONSTRAINT "TransportCoordination_transportJobId_fkey"
    FOREIGN KEY ("transportJobId")
    REFERENCES "TransportJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TransportCoordination_transportJobId_idx"
  ON "TransportCoordination"("transportJobId");

CREATE INDEX IF NOT EXISTS "TransportCoordination_supersededAt_idx"
  ON "TransportCoordination"("supersededAt");

-- ============================================================================
-- TRANSPORT AVAILABILITY (repeatable date/time slots per party)
-- ----------------------------------------------------------------------------
-- One row per window. Separate rows (rather than a single text blob) so the
-- schedule can be queried, matched, edited, and conflict-checked later.
--
-- party = 'SELLER' | 'TRANSPORTER' — the party the slot belongs to.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TransportAvailability" (
  "id" TEXT NOT NULL,
  "transportJobId" TEXT NOT NULL,
  "party" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "startTime" TEXT NOT NULL,   -- "HH:MM" 24h, local
  "endTime"   TEXT NOT NULL,   -- "HH:MM" 24h, local
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TransportAvailability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransportAvailability_party_check"
    CHECK ("party" IN ('SELLER', 'TRANSPORTER')),
  CONSTRAINT "TransportAvailability_time_check"
    CHECK ("startTime" < "endTime"),
  CONSTRAINT "TransportAvailability_transportJobId_fkey"
    FOREIGN KEY ("transportJobId")
    REFERENCES "TransportJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TransportAvailability_job_party_idx"
  ON "TransportAvailability"("transportJobId", "party");

CREATE INDEX IF NOT EXISTS "TransportAvailability_job_date_idx"
  ON "TransportAvailability"("transportJobId", "date");
