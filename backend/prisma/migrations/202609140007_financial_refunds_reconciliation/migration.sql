-- Step 10: durable refund instructions and reconciliation queue.
CREATE TYPE "PaymentRefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "PaymentReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "requestedById" TEXT,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ETB',
  "reason" TEXT,
  "status" "PaymentRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "provider" TEXT,
  "providerRefundId" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentRefund_paymentId_status_idx" ON "PaymentRefund"("paymentId", "status");
CREATE INDEX "PaymentRefund_status_createdAt_idx" ON "PaymentRefund"("status", "createdAt");
CREATE UNIQUE INDEX "PaymentRefund_provider_providerRefundId_key" ON "PaymentRefund"("provider", "providerRefundId");
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PaymentReconciliation" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "observedStatus" TEXT,
  "expectedAmount" DECIMAL(18,2) NOT NULL,
  "observedAmount" DECIMAL(18,2),
  "expectedCurrency" TEXT NOT NULL,
  "observedCurrency" TEXT,
  "reason" TEXT NOT NULL,
  "payload" JSONB,
  "status" "PaymentReconciliationStatus" NOT NULL DEFAULT 'OPEN',
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentReconciliation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentReconciliation_paymentId_status_idx" ON "PaymentReconciliation"("paymentId", "status");
CREATE INDEX "PaymentReconciliation_status_createdAt_idx" ON "PaymentReconciliation"("status", "createdAt");
CREATE INDEX "PaymentReconciliation_provider_createdAt_idx" ON "PaymentReconciliation"("provider", "createdAt");
ALTER TABLE "PaymentReconciliation" ADD CONSTRAINT "PaymentReconciliation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliation" ADD CONSTRAINT "PaymentReconciliation_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
