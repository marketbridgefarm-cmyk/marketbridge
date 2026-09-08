-- schema.prisma has defined Payment.transportJobId, Payment.netAmount,
-- PaymentLedgerEntryType, PaymentLedgerEntry, and PaymentEvent since the
-- commission-tracking work, but migration 202609050001 only actually
-- created the inspectionRequestId/commissionRate/commissionAmount columns.
-- This migration fills in the rest of that gap. Guarded so it's safe to
-- re-run against a database that already has some of these pieces.

-- ============================================================================
-- Payment: missing columns
-- ============================================================================

ALTER TABLE "Payment"
ADD COLUMN IF NOT EXISTS "transportJobId" TEXT,
ADD COLUMN IF NOT EXISTS "netAmount" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "Payment_transportJobId_idx" ON "Payment"("transportJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Payment_transportJobId_fkey'
  ) THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_transportJobId_fkey"
        FOREIGN KEY ("transportJobId") REFERENCES "TransportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- PaymentLedgerEntryType enum
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentLedgerEntryType') THEN
    CREATE TYPE "PaymentLedgerEntryType" AS ENUM (
      'SELLER_EARNING',
      'TRANSPORTER_EARNING',
      'INSPECTOR_EARNING',
      'PLATFORM_COMMISSION',
      'PLATFORM_REVENUE',
      'REFUND'
    );
  END IF;
END $$;

-- ============================================================================
-- PaymentLedgerEntry table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "PaymentLedgerEntry" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "PaymentLedgerEntryType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaymentLedgerEntry_paymentId_idx" ON "PaymentLedgerEntry"("paymentId");
CREATE INDEX IF NOT EXISTS "PaymentLedgerEntry_userId_idx" ON "PaymentLedgerEntry"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLedgerEntry_paymentId_fkey'
  ) THEN
    ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_paymentId_fkey"
        FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLedgerEntry_userId_fkey'
  ) THEN
    ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- PaymentEvent table (idempotent provider/webhook event log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "PaymentEvent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaymentEvent_paymentId_idx" ON "PaymentEvent"("paymentId");
CREATE INDEX IF NOT EXISTS "PaymentEvent_provider_idx" ON "PaymentEvent"("provider");
CREATE INDEX IF NOT EXISTS "PaymentEvent_createdAt_idx" ON "PaymentEvent"("createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_provider_eventId_key" ON "PaymentEvent"("provider", "eventId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentEvent_paymentId_fkey'
  ) THEN
    ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey"
        FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
