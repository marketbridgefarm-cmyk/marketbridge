-- Private object-storage keys for the seller-supplied preview images shown on digital product cards.
ALTER TABLE "DigitalProduct" ADD COLUMN "previewKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
