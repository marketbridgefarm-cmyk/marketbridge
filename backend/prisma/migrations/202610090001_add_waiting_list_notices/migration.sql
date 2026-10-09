-- Save as: prisma/migrations/202610090001_add_waiting_list_notices/migration.sql

-- CreateTable
CREATE TABLE "InspectionNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inspectionRequestId" TEXT NOT NULL,
    "quoteId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transportJobId" TEXT NOT NULL,
    "quoteId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionNotification_userId_readAt_createdAt_idx" ON "InspectionNotification"("userId", "readAt", "createdAt");
CREATE INDEX "InspectionNotification_inspectionRequestId_idx" ON "InspectionNotification"("inspectionRequestId");
CREATE INDEX "TransportNotification_userId_readAt_createdAt_idx" ON "TransportNotification"("userId", "readAt", "createdAt");
CREATE INDEX "TransportNotification_transportJobId_idx" ON "TransportNotification"("transportJobId");

-- AddForeignKey
ALTER TABLE "InspectionNotification" ADD CONSTRAINT "InspectionNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
