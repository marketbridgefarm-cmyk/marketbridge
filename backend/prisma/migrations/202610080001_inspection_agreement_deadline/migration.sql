-- Provisional inspection agreements now carry their own deadline in
-- "workflowDueAt" (seller-confirmation window, then payment window).
-- Rows accepted before this release still hold the old REQUESTED-phase
-- deadline, which is usually in the past and would be mistaken for an expired
-- agreement. Give unpaid provisional agreements a fresh 24h window and clear
-- the field for agreements whose start clock is already running.
UPDATE "InspectionRequest"
   SET "workflowDueAt" = NOW() + INTERVAL '24 hours'
 WHERE "status" = 'ACCEPTED' AND "startDueAt" IS NULL;

UPDATE "InspectionRequest"
   SET "workflowDueAt" = NULL
 WHERE "status" = 'ACCEPTED' AND "startDueAt" IS NOT NULL;
