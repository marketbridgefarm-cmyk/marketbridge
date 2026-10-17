-- Inspection arrival proof (GPS + photo + handshake code), seller dispute window,
-- admin dispute path, report acceptance (fee release) and inspector reliability.

CREATE TYPE "InspectionArrivalStatus" AS ENUM (
  'PENDING_SELLER',
  'CONFIRMED',
  'AUTO_CONFIRMED',
  'DISPUTED',
  'RESOLVED_ARRIVED',
  'RESOLVED_NO_SHOW'
);

ALTER TABLE "InspectionRequest"
  ADD COLUMN IF NOT EXISTS "arrivalCodeSalt" TEXT,
  ADD COLUMN IF NOT EXISTS "arrivalCodeFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reportAcceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reportAcceptedById" TEXT;

CREATE TABLE "InspectionArrival" (
  "id" TEXT NOT NULL,
  "inspectionRequestId" TEXT NOT NULL,
  "inspectorId" TEXT NOT NULL,
  "status" "InspectionArrivalStatus" NOT NULL DEFAULT 'PENDING_SELLER',
  "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "accuracyMeters" DOUBLE PRECISION,
  "photoKeys" TEXT[],
  "codeVerified" BOOLEAN NOT NULL DEFAULT false,
  "distanceKm" DOUBLE PRECISION,
  "flagged" BOOLEAN NOT NULL DEFAULT false,
  "late" BOOLEAN NOT NULL DEFAULT false,
  "disputeWindowEndsAt" TIMESTAMP(3),
  "sellerRespondedAt" TIMESTAMP(3),
  "sellerRespondedById" TEXT,
  "disputeReason" TEXT,
  "disputedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "adminNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectionArrival_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InspectionArrival_inspectionRequestId_key" ON "InspectionArrival"("inspectionRequestId");
CREATE INDEX "InspectionArrival_status_disputeWindowEndsAt_idx" ON "InspectionArrival"("status", "disputeWindowEndsAt");
CREATE INDEX "InspectionArrival_inspectorId_idx" ON "InspectionArrival"("inspectorId");

ALTER TABLE "InspectionArrival"
  ADD CONSTRAINT "InspectionArrival_inspectionRequestId_fkey"
  FOREIGN KEY ("inspectionRequestId") REFERENCES "InspectionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionArrival"
  ADD CONSTRAINT "InspectionArrival_inspectorId_fkey"
  FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InspectorReliability" (
  "inspectorId" TEXT NOT NULL,
  "noShows" INTEGER NOT NULL DEFAULT 0,
  "lateArrivals" INTEGER NOT NULL DEFAULT 0,
  "onTimeArrivals" INTEGER NOT NULL DEFAULT 0,
  "reportsSubmitted" INTEGER NOT NULL DEFAULT 0,
  "totalReportMinutes" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectorReliability_pkey" PRIMARY KEY ("inspectorId")
);

ALTER TABLE "InspectorReliability"
  ADD CONSTRAINT "InspectorReliability_inspectorId_fkey"
  FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
