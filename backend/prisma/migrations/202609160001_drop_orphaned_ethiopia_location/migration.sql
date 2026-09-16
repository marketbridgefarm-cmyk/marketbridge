-- OPTIONAL CLEANUP — not required to fix any live bug. Review before running:
-- this DROPS objects and data.
--
-- 202609150002_ethiopian_marketplace_advantage created a hierarchical
-- EthiopiaLocation table (region/zone/woreda/kebele as a linked-parent
-- tree). That design was superseded by 202609150005_add_region_and_coordinates,
-- which added a flat Region enum plus zone/woreda/kebele text columns
-- directly on User and Listing instead (see that migration's own comment).
-- EthiopiaLocation was never added to schema.prisma, so it was never a
-- usable Prisma model, and src/routes/locations.js (the only code that
-- queried it) was never mounted in index.js — it's dead weight in the
-- database with no live code path.
--
-- Before running: confirm EthiopiaLocation is genuinely empty or contains
-- nothing you need, e.g.:
--   SELECT count(*) FROM "EthiopiaLocation";

DROP TABLE IF EXISTS "EthiopiaLocation";
DROP TYPE IF EXISTS "LocationLevel";
