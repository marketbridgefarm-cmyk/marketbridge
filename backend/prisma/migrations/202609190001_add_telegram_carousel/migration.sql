-- Adds the CAROUSEL Telegram promotion template and the column that stores
-- its uploaded photos (private object-storage keys, in slide order).
-- Idempotent, following the same guarded pattern as the other ad-template
-- migrations. Existing rows are untouched: they keep their current template
-- and get an empty image list.
ALTER TYPE "TelegramTemplate" ADD VALUE IF NOT EXISTS 'CAROUSEL';

ALTER TABLE "Advertisement"
  ADD COLUMN IF NOT EXISTS "telegramImageKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
