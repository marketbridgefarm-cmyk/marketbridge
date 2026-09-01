-- Move digital-product storage toward private object storage.
-- fileUrl is retained temporarily for legacy rows but is no longer used for downloads.
ALTER TABLE "DigitalProduct" ADD COLUMN "fileKey" TEXT;
ALTER TABLE "DigitalProduct" ADD COLUMN "fileName" TEXT;
ALTER TABLE "DigitalProduct" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "DigitalProduct" ADD COLUMN "fileSizeBytes" INTEGER;
