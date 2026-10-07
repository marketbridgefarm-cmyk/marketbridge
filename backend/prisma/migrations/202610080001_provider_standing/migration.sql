-- Provider standing: penalties for frequent cancellations of accepted deals,
-- with a suspension -> rejoin -> probation path. Bidding-only; the user's
-- account status is not changed.

DO $$ BEGIN
  CREATE TYPE "ProviderStandingStatus" AS ENUM ('GOOD', 'PROBATION', 'SUSPENDED', 'REJOIN_PENDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ProviderStanding" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "ProviderStandingStatus" NOT NULL DEFAULT 'GOOD',
  "suspensionCount" INTEGER NOT NULL DEFAULT 0,
  "suspendedAt" TIMESTAMP(3),
  "suspendedUntil" TIMESTAMP(3),
  "probationUntil" TIMESTAMP(3),
  "ratingPenalty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lastReason" TEXT,
  "appealMessage" TEXT,
  "appealedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderStanding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderStanding_userId_key" ON "ProviderStanding"("userId");
CREATE INDEX IF NOT EXISTS "ProviderStanding_status_suspendedUntil_idx" ON "ProviderStanding"("status", "suspendedUntil");
CREATE INDEX IF NOT EXISTS "ProviderStanding_status_probationUntil_idx" ON "ProviderStanding"("status", "probationUntil");

DO $$ BEGIN
  ALTER TABLE "ProviderStanding"
    ADD CONSTRAINT "ProviderStanding_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
