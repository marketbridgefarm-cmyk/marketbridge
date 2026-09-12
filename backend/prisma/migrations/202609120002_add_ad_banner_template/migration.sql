-- Adds a selectable visual layout template for BANNER campaigns
-- (CLASSIC/BOLD/MINIMAL/CARD). Non-BANNER campaign types simply carry the
-- default and ignore it. Idempotent, following the same guarded pattern as
-- the other backfill migrations in this project.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'BannerTemplate'
  ) THEN
    CREATE TYPE "BannerTemplate" AS ENUM ('CLASSIC', 'BOLD', 'MINIMAL', 'CARD');
  END IF;
END $$;

ALTER TABLE "Advertisement"
  ADD COLUMN IF NOT EXISTS "bannerTemplate" "BannerTemplate" NOT NULL DEFAULT 'CLASSIC';
