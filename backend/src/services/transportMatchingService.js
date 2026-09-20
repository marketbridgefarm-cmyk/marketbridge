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
// Job statuses where a truck is genuinely "out on the road right now" —
// used for backhaul/route matching below. REQUESTED/QUOTED jobs are excluded
// on purpose: they aren't committed yet, so treating them as a real route
// would suggest capacity that might not exist.
const ACTIVE_ROUTE_STATUSES = ['ACCEPTED', 'PICKUP', 'IN_TRANSIT'];

function normalizeLocation(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function locationsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return 'exact';
  if (a.includes(b) || b.includes(a)) return 'partial';
  return false;
}

/**
 * Backhaul opportunity check: is this truck owner already committed to a
 * job whose destination lands near the new job's pickup point? If so, the
 * truck will already be in the area around when the new job needs pickup,
 * instead of having to be dispatched empty from wherever it started. This
 * is the single biggest cost lever in ag logistics (empty return legs) and
 * previously had no signal in the matching at all — matchTrucks only ever
 * looked at where a truck's owner *says* they operate, never where their
 * current committed work is actually taking them.
 */
async function findRouteOpportunities(truckOwnerIds, pickupArea) {
  const normalizedPickup = normalizeLocation(pickupArea);
  if (!normalizedPickup || truckOwnerIds.length === 0) return new Map();

  const activeJobs = await prisma.transportJob.findMany({
    where: { truckOwnerId: { in: truckOwnerIds }, status: { in: ACTIVE_ROUTE_STATUSES } },
    select: { id: true, truckOwnerId: true, destination: true, status: true },
  });

  const byOwner = new Map();
  for (const job of activeJobs) {
    const matchKind = locationsMatch(normalizeLocation(job.destination), normalizedPickup);
    if (!matchKind) continue;
    // Keep the best (exact beats partial) opportunity per owner.
    const existing = byOwner.get(job.truckOwnerId);
    if (!existing || (matchKind === 'exact' && existing.matchKind !== 'exact')) {
      byOwner.set(job.truckOwnerId, { jobId: job.id, destination: job.destination, status: job.status, matchKind });
    }
  }
  return byOwner;
}

async function matchTrucks({ area, requiredCapacity = 0, limit = 20 }) {
  const trucks = await prisma.truck.findMany({
    where: { availability: 'AVAILABLE', capacity: { gte: Number(requiredCapacity) || 0 } },
    include: { owner: { select: { id: true, name: true, rating: true, verificationStatus: true } } },
    take: 100,
  });

  const normalizedArea = area ? String(area).trim().toLowerCase() : null;
  const routeOpportunities = await findRouteOpportunities(trucks.map((t) => t.ownerId), area);

  const ranked = trucks.map((truck) => {
    const truckArea = (truck.operatingArea || '').trim().toLowerCase();
    const exactAreaMatch = Boolean(normalizedArea && truckArea === normalizedArea);
    const partialAreaMatch = Boolean(
      normalizedArea && !exactAreaMatch && (truckArea.includes(normalizedArea) || normalizedArea.includes(truckArea))
    );
    const routeMatch = routeOpportunities.get(truck.ownerId) || null;

    let score = 0;
    if (exactAreaMatch) score += 50;
    else if (partialAreaMatch) score += 25;
    // A confirmed backhaul opportunity outranks a bare operating-area
    // match: it means the truck will provably be near the pickup point
    // around the right time, not just that the owner claims to work the
    // general area.
    if (routeMatch?.matchKind === 'exact') score += 60;
    else if (routeMatch?.matchKind === 'partial') score += 35;
    score += Math.min(15, Number(truck.rating) || 0) * 3;
    if (truck.verificationStatus === 'VERIFIED') score += 10;
    if (truck.owner.verificationStatus === 'VERIFIED') score += 5;
    if (Number(truck.capacity) >= Number(requiredCapacity || 0)) score += 5;

    return { ...truck, matchScore: Math.round(score * 100) / 100, routeMatch };
  }).sort((a, b) => b.matchScore - a.matchScore);

  return ranked.slice(0, Math.min(Number(limit) || 20, 50));
}
module.exports = { matchTrucks };
