-- Add durable deadlines for open inspection and transport workflows.
ALTER TABLE "InspectionRequest" ADD COLUMN "workflowDueAt" TIMESTAMP(3);
ALTER TABLE "TransportJob" ADD COLUMN "workflowDueAt" TIMESTAMP(3);
CREATE INDEX "InspectionRequest_workflowDueAt_idx" ON "InspectionRequest"("workflowDueAt");
CREATE INDEX "TransportJob_workflowDueAt_idx" ON "TransportJob"("workflowDueAt");
