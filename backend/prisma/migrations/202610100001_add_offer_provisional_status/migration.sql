-- Add PROVISIONAL to OfferStatus so an offer can sit in a provisional
-- agreement state (accepted by both sides but not yet converted to an order).
-- The value was already added manually on Neon via the SQL Editor, so this
-- migration is a no-op on that database; it exists to keep Prisma Migrate
-- history in sync with the schema and to make the change reproducible on
-- every other environment (fresh local DB, CI, preview branches).
--
-- Postgres does not allow dropping enum values, so this migration is
-- intentionally one-way. Rollbacks are not supported for this change.

ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'PROVISIONAL';
