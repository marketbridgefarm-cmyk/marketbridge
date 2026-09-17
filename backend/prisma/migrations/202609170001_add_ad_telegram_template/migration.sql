-- Adds a selectable message-tone template for TELEGRAM_PROMOTION campaigns
-- (CLASSIC/HOT_DEAL/FRESH_HARVEST/FARM_TO_TABLE/FLASH_SALE/TRUSTED_SELLER).
-- This is a copy/tone preset only -- MarketBridge staff still write and
-- publish the actual Telegram post, and unlike bannerTemplate it never
-- changes price. Idempotent, following the same guarded pattern as the
-- banner template migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'TelegramTemplate'
  ) THEN
    CREATE TYPE "TelegramTemplate" AS ENUM (
      'CLASSIC', 'HOT_DEAL', 'FRESH_HARVEST', 'FARM_TO_TABLE', 'FLASH_SALE', 'TRUSTED_SELLER'
    );
  END IF;
END $$;

ALTER TABLE "Advertisement"
  ADD COLUMN IF NOT EXISTS "telegramTemplate" "TelegramTemplate" NOT NULL DEFAULT 'CLASSIC';
