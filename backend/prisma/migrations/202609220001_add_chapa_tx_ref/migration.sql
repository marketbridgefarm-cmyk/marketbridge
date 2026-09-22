-- Preserve the exact Chapa checkout tx_ref used to initialize a payment.
-- This value must survive settlement because Chapa's v1 refund endpoint
-- requires the original transaction reference.
ALTER TABLE "Payment" ADD COLUMN "chapaTxRef" TEXT;

CREATE INDEX "Payment_chapaTxRef_idx" ON "Payment"("chapaTxRef");
