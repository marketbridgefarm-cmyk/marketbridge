-- A truck owner must be able to bid again on the same job after their earlier
-- quote was withdrawn, rejected or expired (inspection quotes already allow this).
--
-- 202609030002 created this as a UNIQUE INDEX, and 202609110001 tried to remove it
-- with `DROP CONSTRAINT IF EXISTS`, which silently does nothing for a plain unique
-- index. The index therefore survived and made every re-bid with the same truck
-- fail with P2002 ("A quote for this truck and job already exists").
-- schema.prisma has no such unique, so this also removes real drift.
DROP INDEX IF EXISTS "TransportQuote_transportJobId_truckOwnerId_truckId_key";
ALTER TABLE "TransportQuote" DROP CONSTRAINT IF EXISTS "TransportQuote_transportJobId_truckOwnerId_truckId_key";
