-- Step 4: transport pickup/delivery evidence integrity.

CREATE TYPE "TransportEvidenceType" AS ENUM ('PICKUP', 'DELIVERY', 'INCIDENT');

CREATE TABLE "TransportEvidence" (
    "id" TEXT NOT NULL,
    "transportJobId" TEXT NOT NULL,
    "type" "TransportEvidenceType" NOT NULL,
    "photos" TEXT[] NOT NULL,
    "videos" TEXT[] NOT NULL,
    "gpsLocation" TEXT,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "TransportEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TransportEvidence_transportJobId_type_idx"
  ON "TransportEvidence"("transportJobId", "type");

CREATE INDEX "TransportEvidence_createdById_capturedAt_idx"
  ON "TransportEvidence"("createdById", "capturedAt");

ALTER TABLE "TransportEvidence"
  ADD CONSTRAINT "TransportEvidence_transportJobId_fkey"
  FOREIGN KEY ("transportJobId") REFERENCES "TransportJob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TransportEvidence"
  ADD CONSTRAINT "TransportEvidence_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
