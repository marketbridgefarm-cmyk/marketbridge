-- Adds platform commission tracking to Payment, and links Payment to
-- InspectionRequest so inspection fees can actually be paid/tracked
-- (previously InspectionRequest.fee existed but nothing ever set or
-- collected it). Guarded so it's safe to re-run.
ALTER TABLE "Payment"
ADD COLUMN IF NOT EXISTS "inspectionRequestId" TEXT,
ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "commissionAmount" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "Payment_inspectionRequestId_idx" ON "Payment"("inspectionRequestId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Payment_inspectionRequestId_fkey'
  ) THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_inspectionRequestId_fkey"
        FOREIGN KEY ("inspectionRequestId") REFERENCES "InspectionRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
