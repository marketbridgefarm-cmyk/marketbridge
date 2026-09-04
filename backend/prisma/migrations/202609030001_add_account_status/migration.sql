-- Idempotent: this was already applied by hand against Railway Postgres
-- (never went through `prisma migrate deploy`), so this file must be safe
-- to re-run without erroring if it's ever applied again.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'AccountStatus'
  ) THEN
    CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
  END IF;
END $$;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';
