-- Add missing Listing fields and PRODUCT category that were never migrated
ALTER TYPE "ListingCategory" ADD VALUE IF NOT EXISTS 'PRODUCT';
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "description" TEXT;
