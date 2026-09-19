-- Adds PLATFORM_PENALTY to PaymentLedgerEntryType. Every completed refund
-- now also records a 0.7% penalty of the refunded amount as platform
-- revenue, on top of whatever commission was already taken on the
-- original payment. As with other enum backfills in this project, the
-- value must be committed in its own migration before any later
-- migration or application query can reference it.
ALTER TYPE "PaymentLedgerEntryType" ADD VALUE IF NOT EXISTS 'PLATFORM_PENALTY';
