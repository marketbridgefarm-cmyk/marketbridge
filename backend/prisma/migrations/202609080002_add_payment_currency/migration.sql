-- schema.prisma has defined Payment.currency (default 'ETB') since the
-- Chapa/commission work, and paymentService.js + payments.js read/write
-- payment.currency extensively (settlement, webhook currency-mismatch
-- validation, Chapa initialize/verify, admin views). This migration folder
-- existed but was never filled in, so the column was never created on the
-- live database -- same missing-migration gap as TransportQuote,
-- Dispute.previousOrderStatus, and the payment-ledger tables before it.
-- Guarded so it's safe to re-run against a database that already has it.

ALTER TABLE "Payment"
ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ETB';
