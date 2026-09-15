-- Ethiopian Marketplace Advantage: hierarchical geography and geo-aware matching.
CREATE TYPE "LocationLevel" AS ENUM ('REGION', 'ZONE', 'WOREDA', 'KEBELE');

CREATE TABLE "EthiopiaLocation" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAm" TEXT,
  "nameOm" TEXT,
  "code" TEXT NOT NULL,
  "level" "LocationLevel" NOT NULL,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "parentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EthiopiaLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EthiopiaLocation_code_key" ON "EthiopiaLocation"("code");
CREATE INDEX "EthiopiaLocation_level_idx" ON "EthiopiaLocation"("level");
CREATE INDEX "EthiopiaLocation_parentId_idx" ON "EthiopiaLocation"("parentId");
CREATE INDEX "EthiopiaLocation_latitude_longitude_idx" ON "EthiopiaLocation"("latitude", "longitude");
ALTER TABLE "EthiopiaLocation" ADD CONSTRAINT "EthiopiaLocation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Listing" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Truck" ADD COLUMN "operatingLocationId" TEXT;
ALTER TABLE "TransportJob" ADD COLUMN "pickupLocationId" TEXT;
ALTER TABLE "TransportJob" ADD COLUMN "destinationLocationId" TEXT;

CREATE INDEX "User_locationId_idx" ON "User"("locationId");
CREATE INDEX "Listing_locationId_idx" ON "Listing"("locationId");
CREATE INDEX "Truck_operatingLocationId_idx" ON "Truck"("operatingLocationId");
CREATE INDEX "TransportJob_pickupLocationId_idx" ON "TransportJob"("pickupLocationId");
CREATE INDEX "TransportJob_destinationLocationId_idx" ON "TransportJob"("destinationLocationId");

ALTER TABLE "User" ADD CONSTRAINT "User_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_operatingLocationId_fkey" FOREIGN KEY ("operatingLocationId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportJob" ADD CONSTRAINT "TransportJob_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportJob" ADD CONSTRAINT "TransportJob_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "EthiopiaLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the top-level geography so the hierarchy is usable immediately. Lower
-- levels can be added progressively without changing the API contract.
INSERT INTO "EthiopiaLocation" ("id","name","code","level","updatedAt") VALUES
('10000000-0000-4000-8000-000000000001','Addis Ababa','ET-AA','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000002','Afar','ET-AF','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000003','Amhara','ET-AM','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000004','Benishangul-Gumuz','ET-BG','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000005','Central Ethiopia','ET-CE','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000006','Dire Dawa','ET-DD','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000007','Gambela','ET-GA','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000008','Harari','ET-HA','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000009','Oromia','ET-OR','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000010','Sidama','ET-SI','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000011','Somali','ET-SO','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000012','South Ethiopia','ET-SE','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000013','South West Ethiopia Peoples','ET-SW','REGION',CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000014','Tigray','ET-TI','REGION',CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
