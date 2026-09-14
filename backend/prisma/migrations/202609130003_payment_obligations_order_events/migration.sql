-- Create durable payment obligations and customer-facing order events.

CREATE TYPE "PaymentObligationStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

CREATE TABLE "PaymentObligation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "obligationKey" TEXT NOT NULL,
    "inspectionRequestId" TEXT,
    "transportJobId" TEXT,
    "payerId" TEXT NOT NULL,
    "beneficiaryId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "status" "PaymentObligationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentObligation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentObligation_obligationKey_key" ON "PaymentObligation"("obligationKey");
CREATE INDEX "PaymentObligation_orderId_status_idx" ON "PaymentObligation"("orderId", "status");
CREATE INDEX "PaymentObligation_payerId_status_idx" ON "PaymentObligation"("payerId", "status");
CREATE INDEX "PaymentObligation_beneficiaryId_idx" ON "PaymentObligation"("beneficiaryId");
CREATE INDEX "PaymentObligation_type_idx" ON "PaymentObligation"("type");
CREATE INDEX "PaymentObligation_inspectionRequestId_idx" ON "PaymentObligation"("inspectionRequestId");
CREATE INDEX "PaymentObligation_transportJobId_idx" ON "PaymentObligation"("transportJobId");

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");
CREATE INDEX "OrderEvent_actorId_createdAt_idx" ON "OrderEvent"("actorId", "createdAt");
CREATE INDEX "OrderEvent_type_createdAt_idx" ON "OrderEvent"("type", "createdAt");

ALTER TABLE "Payment" ADD COLUMN "obligationId" TEXT;
CREATE UNIQUE INDEX "Payment_obligationId_key" ON "Payment"("obligationId");

ALTER TABLE "PaymentObligation"
  ADD CONSTRAINT "PaymentObligation_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentObligation"
  ADD CONSTRAINT "PaymentObligation_inspectionRequestId_fkey"
  FOREIGN KEY ("inspectionRequestId") REFERENCES "InspectionRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentObligation"
  ADD CONSTRAINT "PaymentObligation_transportJobId_fkey"
  FOREIGN KEY ("transportJobId") REFERENCES "TransportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentObligation"
  ADD CONSTRAINT "PaymentObligation_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentObligation"
  ADD CONSTRAINT "PaymentObligation_beneficiaryId_fkey"
  FOREIGN KEY ("beneficiaryId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_obligationId_fkey"
  FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill one canonical goods-payment obligation per existing order.
INSERT INTO "PaymentObligation"
  ("id","orderId","type","obligationKey","payerId","beneficiaryId","amount","currency","status","createdAt","updatedAt")
SELECT
  gen_random_uuid()::text,
  o."id",
  'MARKETPLACE'::"PaymentType",
  'ORDER:' || o."id" || ':MARKETPLACE',
  o."buyerId",
  o."sellerId",
  o."finalPrice",
  'ETB',
  CASE WHEN EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."orderId" = o."id"
      AND p."type" = 'MARKETPLACE'::"PaymentType"
      AND p."status" = 'PAID'::"PaymentStatus"
  ) THEN 'PAID'::"PaymentObligationStatus" ELSE 'OPEN'::"PaymentObligationStatus" END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Order" o;

-- Backfill fee-bearing inspection obligations for inspections belonging to
-- an existing order's listing.
INSERT INTO "PaymentObligation"
  ("id","orderId","type","obligationKey","inspectionRequestId","payerId","beneficiaryId","amount","currency","status","createdAt","updatedAt")
SELECT
  gen_random_uuid()::text,
  o."id",
  'INSPECTOR'::"PaymentType",
  'ORDER:' || o."id" || ':INSPECTOR:' || ir."id",
  ir."id",
  o."buyerId",
  ir."inspectorId",
  ir."fee",
  'ETB',
  CASE WHEN EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."inspectionRequestId" = ir."id"
      AND p."type" = 'INSPECTOR'::"PaymentType"
      AND p."status" = 'PAID'::"PaymentStatus"
  ) THEN 'PAID'::"PaymentObligationStatus" ELSE 'OPEN'::"PaymentObligationStatus" END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Order" o
JOIN "InspectionRequest" ir ON ir."listingId" = o."listingId"
WHERE ir."fee" IS NOT NULL
  AND ir."fee" > 0
  AND ir."status" <> 'CANCELLED';

-- Backfill hired-transport obligations where a transporter and agreed amount
-- already exist.
INSERT INTO "PaymentObligation"
  ("id","orderId","type","obligationKey","transportJobId","payerId","beneficiaryId","amount","currency","status","createdAt","updatedAt")
SELECT
  gen_random_uuid()::text,
  o."id",
  'TRANSPORT'::"PaymentType",
  'ORDER:' || o."id" || ':TRANSPORT',
  tj."id",
  o."buyerId",
  tj."truckOwnerId",
  tj."agreedAmount",
  'ETB',
  CASE WHEN EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."transportJobId" = tj."id"
      AND p."type" = 'TRANSPORT'::"PaymentType"
      AND p."status" = 'PAID'::"PaymentStatus"
  ) THEN 'PAID'::"PaymentObligationStatus" ELSE 'OPEN'::"PaymentObligationStatus" END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Order" o
JOIN "TransportJob" tj ON tj."orderId" = o."id"
WHERE tj."method" = 'HIRE_TRANSPORTER'
  AND tj."agreedAmount" IS NOT NULL
  AND tj."agreedAmount" > 0
  AND tj."truckOwnerId" IS NOT NULL;

-- Link existing payments to the canonical obligation rows.
-- Rank candidate payments per obligation (PAID first, then most recently
-- created) and link only the top-ranked one, so a duplicate FAILED attempt
-- alongside a later retry can never collide on the unique obligationId index.
WITH ranked AS (
  SELECT
    p."id" AS payment_id,
    o."id" AS obligation_id,
    ROW_NUMBER() OVER (
      PARTITION BY o."id"
      ORDER BY
        CASE WHEN p."status" = 'PAID'::"PaymentStatus" THEN 0 ELSE 1 END,
        p."createdAt" DESC
    ) AS rn
  FROM "Payment" p
  JOIN "PaymentObligation" o
    ON o."type" = p."type"
    AND (
      (p."type" = 'MARKETPLACE'::"PaymentType" AND o."orderId" = p."orderId")
      OR
      (p."type" = 'TRANSPORT'::"PaymentType" AND o."transportJobId" = p."transportJobId")
      OR
      (p."type" = 'INSPECTOR'::"PaymentType" AND o."inspectionRequestId" = p."inspectionRequestId")
    )
  WHERE p."obligationId" IS NULL
)
UPDATE "Payment" p
SET "obligationId" = ranked.obligation_id
FROM ranked
WHERE p."id" = ranked.payment_id
  AND ranked.rn = 1;

-- Record the existing order creation as the first durable domain event.
INSERT INTO "OrderEvent"
  ("id","orderId","type","toStatus","metadata","createdAt")
SELECT
  gen_random_uuid()::text,
  o."id",
  'ORDER_CREATED',
  o."status"::text,
  jsonb_build_object('backfilled', true),
  o."createdAt"
FROM "Order" o;
