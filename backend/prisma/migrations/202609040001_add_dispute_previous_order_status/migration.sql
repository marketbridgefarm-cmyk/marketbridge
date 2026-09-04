-- Store the order's status at the moment a dispute is raised, so it can be
-- restored on resolution instead of leaving the order stuck at DISPUTED
-- forever. Guarded so it's safe to re-run.
ALTER TABLE "Dispute"
ADD COLUMN IF NOT EXISTS "previousOrderStatus" "OrderStatus";
