CREATE TABLE "InspectionEvidence" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'REPORT',
    "photos" TEXT[] NOT NULL,
    "videos" TEXT[] NOT NULL,
    "gpsLocation" TEXT,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "InspectionEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InspectionEvidence_reportId_type_idx" ON "InspectionEvidence"("reportId", "type");
CREATE INDEX "InspectionEvidence_createdById_capturedAt_idx" ON "InspectionEvidence"("createdById", "capturedAt");
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "InspectionReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
