-- MarketBridge P2 — Money Type Integrity Hardening
--
-- Purpose:
--   Ensure every currency amount represented by the Prisma schema is stored
--   as PostgreSQL NUMERIC(18,2), with a deterministic conversion path from
--   any legacy floating-point column and explicit preflight protection for
--   NaN / Infinity values.
--
-- This migration is intentionally idempotent with respect to column type:
-- columns already stored as NUMERIC are left untouched.
--
-- IMPORTANT:
--   Run the companion preflight SQL against production before deployment.
--   Do not use prisma db push for production.

DO $$
DECLARE
  col RECORD;
  bad_count BIGINT;
BEGIN
  -- Detect non-finite legacy floating-point values before casting.
  FOR col IN
    SELECT * FROM (VALUES
      ('Listing', 'askingPrice'),
      ('Listing', 'minAcceptablePrice'),
      ('Offer', 'amount'),
      ('Offer', 'counterAmount'),
      ('InspectionRequest', 'fee'),
      ('InspectionQuote', 'amount'),
      ('InspectionQuote', 'counterAmount'),
      ('Order', 'finalPrice'),
      ('TransportJob', 'agreedAmount'),
      ('TransportQuote', 'amount'),
      ('TransportQuote', 'counterAmount'),
      ('DigitalProduct', 'price'),
      ('PaymentObligation', 'amount'),
      ('Payment', 'amount'),
      ('Payment', 'commissionAmount'),
      ('Payment', 'netAmount'),
      ('PaymentLedgerEntry', 'amount'),
      ('PaymentRefund', 'amount'),
      ('PaymentReconciliation', 'expectedAmount'),
      ('PaymentReconciliation', 'observedAmount'),
      ('Advertisement', 'priceQuoted'),
      ('Advertisement', 'amountPaid'),
      ('Payout', 'amount')
    ) AS t(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = col.table_name
        AND column_name = col.column_name
        AND data_type IN ('double precision', 'real')
    ) THEN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I::text IN (''NaN'', ''Infinity'', ''-Infinity'')',
        col.table_name,
        col.column_name
      ) INTO bad_count;

      IF bad_count > 0 THEN
        RAISE EXCEPTION
          'P2 money migration blocked: %.% contains % non-finite value(s). Clean these values before migrate deploy.',
          col.table_name, col.column_name, bad_count;
      END IF;
    END IF;
  END LOOP;

  -- Convert every monetary column that is still floating-point.
  FOR col IN
    SELECT * FROM (VALUES
      ('Listing', 'askingPrice'),
      ('Listing', 'minAcceptablePrice'),
      ('Offer', 'amount'),
      ('Offer', 'counterAmount'),
      ('InspectionRequest', 'fee'),
      ('InspectionQuote', 'amount'),
      ('InspectionQuote', 'counterAmount'),
      ('Order', 'finalPrice'),
      ('TransportJob', 'agreedAmount'),
      ('TransportQuote', 'amount'),
      ('TransportQuote', 'counterAmount'),
      ('DigitalProduct', 'price'),
      ('PaymentObligation', 'amount'),
      ('Payment', 'amount'),
      ('Payment', 'commissionAmount'),
      ('Payment', 'netAmount'),
      ('PaymentLedgerEntry', 'amount'),
      ('PaymentRefund', 'amount'),
      ('PaymentReconciliation', 'expectedAmount'),
      ('PaymentReconciliation', 'observedAmount'),
      ('Advertisement', 'priceQuoted'),
      ('Advertisement', 'amountPaid'),
      ('Payout', 'amount')
    ) AS t(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = col.table_name
        AND column_name = col.column_name
        AND data_type IN ('double precision', 'real')
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE numeric(18,2) USING round(%I::numeric, 2)',
        col.table_name,
        col.column_name,
        col.column_name
      );
    END IF;
  END LOOP;

  -- Explicitly verify the target type after conversion.
  FOR col IN
    SELECT * FROM (VALUES
      ('Listing', 'askingPrice'),
      ('Listing', 'minAcceptablePrice'),
      ('Offer', 'amount'),
      ('Offer', 'counterAmount'),
      ('InspectionRequest', 'fee'),
      ('InspectionQuote', 'amount'),
      ('InspectionQuote', 'counterAmount'),
      ('Order', 'finalPrice'),
      ('TransportJob', 'agreedAmount'),
      ('TransportQuote', 'amount'),
      ('TransportQuote', 'counterAmount'),
      ('DigitalProduct', 'price'),
      ('PaymentObligation', 'amount'),
      ('Payment', 'amount'),
      ('Payment', 'commissionAmount'),
      ('Payment', 'netAmount'),
      ('PaymentLedgerEntry', 'amount'),
      ('PaymentRefund', 'amount'),
      ('PaymentReconciliation', 'expectedAmount'),
      ('PaymentReconciliation', 'observedAmount'),
      ('Advertisement', 'priceQuoted'),
      ('Advertisement', 'amountPaid'),
      ('Payout', 'amount')
    ) AS t(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = col.table_name
        AND column_name = col.column_name
        AND data_type = 'numeric'
        AND numeric_precision = 18
        AND numeric_scale = 2
    ) THEN
      NULL;
    ELSIF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = col.table_name
        AND column_name = col.column_name
    ) THEN
      RAISE EXCEPTION
        'P2 money migration verification failed: %.% is not NUMERIC(18,2).',
        col.table_name, col.column_name;
    END IF;
  END LOOP;
END $$;
