-- TransportQuote was defined in schema.prisma but was never included in any
-- migration file (missing from the init migration). It was created by hand
-- against Railway Postgres to unblock production; this migration file
-- fills that gap so a fresh database build (new environment, disaster
-- recovery, a teammate's machine) actually creates this table. Guarded so
-- it's also safe to re-run against the already-patched Railway database.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'TransportQuoteStatus'
  ) THEN
    CREATE TYPE "TransportQuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "TransportQuote" (
    "id" TEXT NOT NULL,
    "transportJobId" TEXT NOT NULL,
    "truckOwnerId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "TransportQuoteStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransportQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TransportQuote_transportJobId_truckOwnerId_truckId_key"
    ON "TransportQuote"("transportJobId", "truckOwnerId", "truckId");

CREATE INDEX IF NOT EXISTS "TransportQuote_transportJobId_idx" ON "TransportQuote"("transportJobId");
CREATE INDEX IF NOT EXISTS "TransportQuote_truckOwnerId_idx" ON "TransportQuote"("truckOwnerId");
CREATE INDEX IF NOT EXISTS "TransportQuote_truckId_idx" ON "TransportQuote"("truckId");
CREATE INDEX IF NOT EXISTS "TransportQuote_status_idx" ON "TransportQuote"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TransportQuote_transportJobId_fkey'
  ) THEN
    ALTER TABLE "TransportQuote" ADD CONSTRAINT "TransportQuote_transportJobId_fkey"
        FOREIGN KEY ("transportJobId") REFERENCES "TransportJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TransportQuote_truckOwnerId_fkey'
  ) THEN
    ALTER TABLE "TransportQuote" ADD CONSTRAINT "TransportQuote_truckOwnerId_fkey"
        FOREIGN KEY ("truckOwnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TransportQuote_truckId_fkey'
  ) THEN
    ALTER TABLE "TransportQuote" ADD CONSTRAINT "TransportQuote_truckId_fkey"
        FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
