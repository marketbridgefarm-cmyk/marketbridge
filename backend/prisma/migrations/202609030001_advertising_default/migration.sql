-- Advertising lifecycle enum values must be committed before a later migration
-- uses PENDING_PAYMENT as a column default. PostgreSQL does not allow a newly
-- added enum value to be used safely in the same transaction that adds it.
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PAID_PENDING_REVIEW';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
