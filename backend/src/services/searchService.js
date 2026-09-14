'use strict';

const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');

function positiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

async function searchListings(params = {}) {
  const q = String(params.q || '').trim();
  const category = params.category ? String(params.category).toUpperCase() : null;
  const location = String(params.location || '').trim();
  const cropType = String(params.cropType || '').trim();
  const minPrice = params.minPrice === undefined ? null : Number(params.minPrice);
  const maxPrice = params.maxPrice === undefined ? null : Number(params.maxPrice);
  const page = positiveInt(params.page, 1, 1000000);
  const limit = positiveInt(params.limit, 20, 50);
  const offset = (page - 1) * limit;

  const clauses = [Prisma.sql`l.status IN ('ACTIVE', 'UNDER_NEGOTIATION')`];
  if (q) clauses.push(Prisma.sql`to_tsvector('simple', concat_ws(' ', l.title, l."cropType", l.description, l.location)) @@ websearch_to_tsquery('simple', ${q})`);
  if (category) clauses.push(Prisma.sql`l.category = ${category}::"ListingCategory"`);
  if (location) clauses.push(Prisma.sql`l.location ILIKE ${`%${location}%`}`);
  if (cropType) clauses.push(Prisma.sql`l."cropType" ILIKE ${`%${cropType}%`}`);
  if (Number.isFinite(minPrice)) clauses.push(Prisma.sql`l."askingPrice" >= ${minPrice}`);
  if (Number.isFinite(maxPrice)) clauses.push(Prisma.sql`l."askingPrice" <= ${maxPrice}`);

  const where = Prisma.join(clauses, ' AND ');
  const rank = q
    ? Prisma.sql`ts_rank(to_tsvector('simple', concat_ws(' ', l.title, l."cropType", l.description, l.location)), websearch_to_tsquery('simple', ${q})) DESC,`
    : Prisma.empty;

  const rows = await prisma.$queryRaw`
    SELECT l.id,
      count(*) OVER()::int AS total,
      CASE WHEN ${q !== ''} THEN ts_rank(to_tsvector('simple', concat_ws(' ', l.title, l."cropType", l.description, l.location)), websearch_to_tsquery('simple', ${q})) ELSE 0 END AS rank
    FROM "Listing" l
    WHERE ${where}
    ORDER BY ${rank} l."createdAt" DESC, l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const ids = rows.map((r) => r.id);
  if (!ids.length) return { listings: [], pagination: { page, limit, total: 0, totalPages: 0 } };
  const listings = await prisma.listing.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, sellerId: true, category: true, title: true, cropType: true, quantity: true, availableQuantity: true,
      unit: true, askingPrice: true, location: true, harvestedDate: true, readinessDate: true,
      pickupWindowStart: true, pickupWindowEnd: true, photos: true, videos: true, description: true,
      status: true, createdByInspectorId: true, createdAt: true, updatedAt: true,
    },
  });
  const byId = new Map(listings.map((l) => [l.id, l]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const total = Number(rows[0].total || 0);
  return { listings: ordered, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

module.exports = { searchListings };
