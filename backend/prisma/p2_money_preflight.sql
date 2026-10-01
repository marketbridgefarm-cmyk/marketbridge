-- MarketBridge P2 — Production money-type preflight
-- Read-only. Run this BEFORE prisma migrate deploy.

WITH expected(table_name, column_name) AS (
  VALUES
    ('Listing','askingPrice'),
    ('Listing','minAcceptablePrice'),
    ('Offer','amount'),
    ('Offer','counterAmount'),
    ('InspectionRequest','fee'),
    ('InspectionQuote','amount'),
    ('InspectionQuote','counterAmount'),
    ('Order','finalPrice'),
    ('TransportJob','agreedAmount'),
    ('TransportQuote','amount'),
    ('TransportQuote','counterAmount'),
    ('DigitalProduct','price'),
    ('PaymentObligation','amount'),
    ('Payment','amount'),
    ('Payment','commissionAmount'),
    ('Payment','netAmount'),
    ('PaymentLedgerEntry','amount'),
    ('PaymentRefund','amount'),
    ('PaymentReconciliation','expectedAmount'),
    ('PaymentReconciliation','observedAmount'),
    ('Advertisement','priceQuoted'),
    ('Advertisement','amountPaid'),
    ('Payout','amount')
)
SELECT
  e.table_name,
  e.column_name,
  c.data_type,
  c.numeric_precision,
  c.numeric_scale,
  CASE
    WHEN c.table_name IS NULL THEN 'MISSING_COLUMN'
    WHEN c.data_type = 'numeric' AND c.numeric_precision = 18 AND c.numeric_scale = 2 THEN 'OK'
    ELSE 'NEEDS_MIGRATION'
  END AS status
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = current_schema()
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY e.table_name, e.column_name;

-- Legacy floating-point non-finite scan.
-- Any returned row must be investigated before deployment.
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
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name=r.table_name AND column_name=r.column_name
        AND data_type IN ('double precision','real')
    ) THEN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I::text IN (''NaN'',''Infinity'',''-Infinity'')',
        r.table_name,r.column_name
      ) INTO n;
      IF n > 0 THEN
        RAISE NOTICE 'NON_FINITE %.% = % row(s)', r.table_name,r.column_name,n;
      END IF;
    END IF;
  END LOOP;
END $$;
