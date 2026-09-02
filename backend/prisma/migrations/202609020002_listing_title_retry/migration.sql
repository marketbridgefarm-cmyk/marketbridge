-- Retry: ensure Listing.title/description columns and PRODUCT enum value exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ListingCategory' AND e.enumlabel = 'PRODUCT'
  ) THEN
    ALTER TYPE "ListingCategory" ADD VALUE 'PRODUCT';
  END IF;
END $$;

ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "description" TEXT;
