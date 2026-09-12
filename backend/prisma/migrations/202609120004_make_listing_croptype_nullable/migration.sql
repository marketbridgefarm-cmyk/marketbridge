-- Product  listings do not use agricultural cropType.
-- The Prisma schema already declares cropType as nullable; this migration
-- reconciles the production database with that schema.

ALTER TABLE "Listing"
ALTER COLUMN "cropType" DROP NOT NULL;
