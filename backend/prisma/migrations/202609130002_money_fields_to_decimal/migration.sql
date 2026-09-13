-- PDF recommendation #12 (Financial Data Type): avoid floating-point money
-- fields. Every column here represents a currency amount (prices, offer
-- amounts, fees, order/payment totals, commissions, ad spend) and is moved
-- from double precision to numeric(18,2). Columns that are NOT money
-- (ratings, quantities, truck capacity, moisture, commissionRate as a
-- percentage) are intentionally left as double precision.
--
-- `USING <col>::numeric(18,2)` explicitly rounds any existing
-- floating-point drift (e.g. 19.990000000000002) to a clean 2-decimal
-- value as part of the type change, rather than just reinterpreting the
-- raw bytes. Existing NULLs are preserved. Guarded with a column-type
-- check so this is safe to re-run and safe to run against a database that
-- already has these as numeric (e.g. a fresh `prisma migrate deploy` from
-- scratch, where schema.prisma already reflects this change).

DO $$
DECLARE
  col RECORD;
BEGIN
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
      ('Payment', 'amount'),
      ('Payment', 'commissionAmount'),
      ('Payment', 'netAmount'),
      ('PaymentLedgerEntry', 'amount'),
      ('Advertisement', 'priceQuoted'),
      ('Advertisement', 'amountPaid')
    ) AS t(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = col.table_name
        AND column_name = col.column_name
        AND data_type = 'double precision'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE numeric(18,2) USING %I::numeric(18,2)',
        col.table_name, col.column_name, col.column_name
      );
    END IF;
  END LOOP;
END $$;
