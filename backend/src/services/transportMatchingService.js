'use strict';
const prisma = require('../config/db');

// Location matching used to go through a dedicated EthiopiaLocation table
// (region/zone/woreda/kebele as a linked-parent tree), looked up by
// pickupLocationId and compared via lat/long distance to a Truck's
// operatingLocation relation. That table and relation were dropped when the
// schema moved to a flat design — Truck now just has a free-text
// `operatingArea` field, and callers (see routes/transport.js) pass a plain
// `area` string instead of a location id. This matches on that basis:
// exact (case-insensitive) area match scores highest, a partial/substring
// match scores lower, and no area filter just ranks by capacity/rating/
// verification.
async function matchTrucks({ area, requiredCapacity = 0, limit = 20 }) {
  const trucks = await prisma.truck.findMany({
    where: { availability: 'AVAILABLE', capacity: { gte: Number(requiredCapacity) || 0 } },
    include: { owner: { select: { id: true, name: true, rating: true, verificationStatus: true } } },
    take: 100,
  });

  const normalizedArea = area ? String(area).trim().toLowerCase() : null;

  const ranked = trucks.map((truck) => {
    const truckArea = (truck.operatingArea || '').trim().toLowerCase();
    const exactAreaMatch = Boolean(normalizedArea && truckArea === normalizedArea);
    const partialAreaMatch = Boolean(
      normalizedArea && !exactAreaMatch && (truckArea.includes(normalizedArea) || normalizedArea.includes(truckArea))
    );

    let score = 0;
    if (exactAreaMatch) score += 50;
    else if (partialAreaMatch) score += 25;
    score += Math.min(15, Number(truck.rating) || 0) * 3;
    if (truck.verificationStatus === 'VERIFIED') score += 10;
    if (truck.owner.verificationStatus === 'VERIFIED') score += 5;
    if (Number(truck.capacity) >= Number(requiredCapacity || 0)) score += 5;

    return { ...truck, matchScore: Math.round(score * 100) / 100 };
  }).sort((a, b) => b.matchScore - a.matchScore);

  return ranked.slice(0, Math.min(Number(limit) || 20, 50));
}
module.exports = { matchTrucks };
