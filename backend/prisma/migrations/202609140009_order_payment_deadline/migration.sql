-- Step 14: automatic inventory release for abandoned/unpaid orders.
-- Adds a deadline column the maintenance scheduler uses to auto-cancel an
-- order (and return its reserved quantity to the listing) if it is still
-- PENDING_PAYMENT once the deadline passes. Existing orders get NULL, which
-- the scheduler treats as "no deadline" — it only acts on orders created
-- after this migration, which populate the column explicitly at creation.
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paymentDueAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Order_status_paymentDueAt_idx"
  ON "Order" ("status", "paymentDueAt");
