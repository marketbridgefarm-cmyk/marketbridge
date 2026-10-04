-- Structured requirements let inspectors and transporters price a clearly defined scope.
ALTER TABLE "InspectionRequest" ADD COLUMN "workDetails" JSONB;
ALTER TABLE "TransportJob" ADD COLUMN "workDetails" JSONB;
