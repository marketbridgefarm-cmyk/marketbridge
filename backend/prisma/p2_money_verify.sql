-- MarketBridge P2 — Post-migration verification
-- Run after: npx prisma migrate deploy

WITH expected(table_name, column_name) AS (
  VALUES
    ('Listing','askingPrice'),('Listing','minAcceptablePrice'),
    ('Offer','amount'),('Offer','counterAmount'),
    ('InspectionRequest','fee'),('InspectionQuote','amount'),('InspectionQuote','counterAmount'),
    ('Order','finalPrice'),('TransportJob','agreedAmount'),
    ('TransportQuote','amount'),('TransportQuote','counterAmount'),
    ('DigitalProduct','price'),('PaymentObligation','amount'),
    ('Payment','amount'),('Payment','commissionAmount'),('Payment','netAmount'),
    ('PaymentLedgerEntry','amount'),('PaymentRefund','amount'),
    ('PaymentReconciliation','expectedAmount'),('PaymentReconciliation','observedAmount'),
    ('Advertisement','priceQuoted'),('Advertisement','amountPaid'),('Payout','amount')
)
SELECT
  e.table_name,
  e.column_name,
  c.data_type,
  c.numeric_precision,
  c.numeric_scale,
  CASE
    WHEN c.data_type='numeric' AND c.numeric_precision=18 AND c.numeric_scale=2 THEN 'PASS'
    ELSE 'FAIL'
  END AS verification
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema=current_schema()
 AND c.table_name=e.table_name
 AND c.column_name=e.column_name
ORDER BY e.table_name,e.column_name;

-- Prisma schema/migration state.
SELECT migration_name, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name = '202610010006_money_type_integrity_hardening';


-- Numeric non-finite scan. NUMERIC can represent special values on supported
-- PostgreSQL versions; money columns must never contain them.
DO $$
DECLARE
  r RECORD;
  n BIGINT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('Listing','askingPrice'),('Listing','minAcceptablePrice'),
      ('Offer','amount'),('Offer','counterAmount'),
      ('InspectionRequest','fee'),('InspectionQuote','amount'),('InspectionQuote','counterAmount'),
      ('Order','finalPrice'),('TransportJob','agreedAmount'),
      ('TransportQuote','amount'),('TransportQuote','counterAmount'),
      ('DigitalProduct','price'),('PaymentObligation','amount'),
      ('Payment','amount'),('Payment','commissionAmount'),('Payment','netAmount'),
      ('PaymentLedgerEntry','amount'),('PaymentRefund','amount'),
      ('PaymentReconciliation','expectedAmount'),('PaymentReconciliation','observedAmount'),
      ('Advertisement','priceQuoted'),('Advertisement','amountPaid'),('Payout','amount')
    ) AS t(table_name,column_name)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=r.table_name AND column_name=r.column_name) THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE %I::text IN (''NaN'',''Infinity'',''-Infinity'')', r.table_name,r.column_name) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'P2 verification failed: %.% contains % non-finite value(s)', r.table_name,r.column_name,n;
      END IF;
    END IF;
  END LOOP;
END $$;
