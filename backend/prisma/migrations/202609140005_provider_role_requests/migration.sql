-- Step 8: persist provider-role approval requests.
-- The Prisma schema and admin routes use ProviderRoleRequest, so the table
-- and enum must exist before those routes can be used.
CREATE TYPE "ProviderRoleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "ProviderRoleRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "status" "ProviderRoleRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderRoleRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderRoleRequest_userId_role_key"
  ON "ProviderRoleRequest"("userId", "role");

CREATE INDEX "ProviderRoleRequest_status_idx"
  ON "ProviderRoleRequest"("status");

CREATE INDEX "ProviderRoleRequest_userId_idx"
  ON "ProviderRoleRequest"("userId");

ALTER TABLE "ProviderRoleRequest"
  ADD CONSTRAINT "ProviderRoleRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
