CREATE TYPE "RecoveryRequestType" AS ENUM ('INSPECTION', 'TRANSPORT');
CREATE TYPE "RecoveryRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "RecoveryTargetParty" AS ENUM ('BUYER', 'SELLER');

CREATE TABLE "RecoveryRequest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "approvedById" TEXT,
  "type" "RecoveryRequestType" NOT NULL,
  "status" "RecoveryRequestStatus" NOT NULL DEFAULT 'PENDING',
  "targetParties" "RecoveryTargetParty"[] NOT NULL,
  "reason" TEXT,
  "adminNote" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "formReleasedAt" TIMESTAMP(3),
  CONSTRAINT "RecoveryRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecoveryRequest_orderId_type_status_idx" ON "RecoveryRequest"("orderId", "type", "status");
CREATE INDEX "RecoveryRequest_requestedById_status_idx" ON "RecoveryRequest"("requestedById", "status");
CREATE INDEX "RecoveryRequest_status_requestedAt_idx" ON "RecoveryRequest"("status", "requestedAt");

ALTER TABLE "RecoveryRequest" ADD CONSTRAINT "RecoveryRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryRequest" ADD CONSTRAINT "RecoveryRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryRequest" ADD CONSTRAINT "RecoveryRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
