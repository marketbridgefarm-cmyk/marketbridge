-- Installment payments for goods payments above the provider's
-- per-transaction limit. See src/services/installmentService.js.

ALTER TYPE "PaymentType" ADD VALUE IF NOT EXISTS 'MARKETPLACE_INSTALLMENT';

ALTER TABLE "Payment"
  ADD COLUMN "installmentCount" INTEGER,
  ADD COLUMN "installmentSequence" INTEGER,
  ADD COLUMN "parentPaymentId" TEXT;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_parentPaymentId_fkey"
  FOREIGN KEY ("parentPaymentId") REFERENCES "Payment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Payment_parentPaymentId_idx" ON "Payment"("parentPaymentId");

CREATE UNIQUE INDEX "Payment_parentPaymentId_installmentSequence_key"
  ON "Payment"("parentPaymentId", "installmentSequence");
