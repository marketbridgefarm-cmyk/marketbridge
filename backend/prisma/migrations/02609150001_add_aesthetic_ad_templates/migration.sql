-- Extend banner template enum for the new premium/aesthetic ad layouts.
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'SPLIT';
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'EDITORIAL';
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'FRESH';
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'DARK_LUXE';
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'MARKET';
ALTER TYPE "BannerTemplate" ADD VALUE IF NOT EXISTS 'GRADIENT';
