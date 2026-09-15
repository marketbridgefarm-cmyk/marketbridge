'use strict';
const prisma = require('../config/db');

const { haversineKm } = require('../utils/geo');

async function matchTrucks({ pickupLocationId, requiredCapacity = 0, limit = 20 }) {
  const pickup = pickupLocationId ? await prisma.ethiopiaLocation.findUnique({ where: { id: pickupLocationId } }) : null;
  const trucks = await prisma.truck.findMany({
    where: { availability: 'AVAILABLE', capacity: { gte: Number(requiredCapacity) || 0 } },
    include: { owner: { select: { id: true, name: true, rating: true, verificationStatus: true } }, operatingLocation: true },
    take: 100,
  });
  const ranked = trucks.map((truck) => {
    const distanceKm = pickup && truck.operatingLocation ? haversineKm(pickup.latitude, pickup.longitude, truck.operatingLocation.latitude, truck.operatingLocation.longitude) : null;
    const sameLocation = Boolean(pickup && truck.operatingLocation && pickup.id === truck.operatingLocation.id);
    const sameParent = Boolean(pickup && truck.operatingLocation && pickup.parentId && pickup.parentId === truck.operatingLocation.parentId);
    let score = 0;
    if (sameLocation) score += 50;
    else if (sameParent) score += 25;
    if (distanceKm !== null) score += Math.max(0, 30 - Math.min(distanceKm, 30));
    score += Math.min(15, Number(truck.rating) || 0) * 3;
    if (truck.verificationStatus === 'VERIFIED') score += 10;
    if (truck.owner.verificationStatus === 'VERIFIED') score += 5;
    if (Number(truck.capacity) >= Number(requiredCapacity || 0)) score += 5;
    return { ...truck, matchScore: Math.round(score * 100) / 100, distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10 };
  }).sort((a, b) => b.matchScore - a.matchScore);
  return ranked.slice(0, Math.min(Number(limit) || 20, 50));
}
module.exports = { matchTrucks };
