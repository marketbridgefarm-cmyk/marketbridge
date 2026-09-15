-- This migration was missed: schema.prisma was updated with the Region enum
-- and region/latitude/longitude fields on User and Listing, but the
-- migration folder meant to carry these changes (202609150004_add_ethiopian_geography)
-- turned out to be a duplicate of 202609150003_sms_outbox_and_language_pref
-- instead. This adds the columns that were never actually created.

DO $$ BEGIN
  CREATE TYPE "Region" AS ENUM (
    'TIGRAY',
    'AFAR',
    'AMHARA',
    'OROMIA',
    'SOMALI',
    'BENISHANGUL_GUMUZ',
    'GAMBELA',
    'HARARI',
    'SIDAMA',
    'SOUTH_ETHIOPIA',
    'SOUTH_WEST_ETHIOPIA_PEOPLES',
    'CENTRAL_ETHIOPIA',
    'ADDIS_ABABA',
    'DIRE_DAWA'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "region" "Region",
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "region" "Region",
  ADD COLUMN IF NOT EXISTS "zone" TEXT,
  ADD COLUMN IF NOT EXISTS "woreda" TEXT,
  ADD COLUMN IF NOT EXISTS "kebele" TEXT,
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "User_region_idx" ON "User"("region");
CREATE INDEX IF NOT EXISTS "Listing_region_idx" ON "Listing"("region");
CREATE INDEX IF NOT EXISTS "Listing_latitude_longitude_idx" ON "Listing"("latitude", "longitude");
