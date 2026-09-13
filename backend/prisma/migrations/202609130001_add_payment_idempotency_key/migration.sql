-- PDF recommendation #14 (Idempotency & Concurrency): POST /payments
-- previously only defended against duplicates with an application-level
-- "find an active payment, then create" check, which is not atomic -- two
-- near-simultaneous requests (retry after a timeout, a double-tapped
-- button, a retried mobile-network request) could both pass the check
-- before either insert lands, creating two payment intents for the same
-- obligation. A client-supplied Idempotency-Key, enforced as a unique
-- column, closes that race at the database level: the second insert with
-- the same key fails the unique constraint and the route returns the
-- first payment instead. Guarded so it's safe to re-run.

ALTER TABLE "Payment"
ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'Payment' AND indexname = 'Payment_idempotencyKey_key'
  ) THEN
    CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
  END IF;
END $$;
