DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InspectionQuoteStatus') THEN
    CREATE TYPE "InspectionQuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "InspectionQuote" (
  "id" TEXT NOT NULL,
  "inspectionRequestId" TEXT NOT NULL,
  "inspectorId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" "InspectionQuoteStatus" NOT NULL DEFAULT 'PENDING',
  "message" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectionQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InspectionQuote_inspectionRequestId_inspectorId_key"
  ON "InspectionQuote"("inspectionRequestId", "inspectorId");
CREATE INDEX IF NOT EXISTS "InspectionQuote_inspectionRequestId_idx"
  ON "InspectionQuote"("inspectionRequestId");
CREATE INDEX IF NOT EXISTS "InspectionQuote_inspectorId_idx"
  ON "InspectionQuote"("inspectorId");
CREATE INDEX IF NOT EXISTS "InspectionQuote_status_idx"
  ON "InspectionQuote"("status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'InspectionQuote_inspectionRequestId_fkey') THEN
    ALTER TABLE "InspectionQuote"
      ADD CONSTRAINT "InspectionQuote_inspectionRequestId_fkey"
      FOREIGN KEY ("inspectionRequestId") REFERENCES "InspectionRequest"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'InspectionQuote_inspectorId_fkey') THEN
    ALTER TABLE "InspectionQuote"
      ADD CONSTRAINT "InspectionQuote_inspectorId_fkey"
      FOREIGN KEY ("inspectorId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
