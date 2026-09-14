'use strict';

const prisma = require('../config/db');

async function getRecommendations(userId, { limit = 12 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 12, 1), 30);
  const [orders, offers, ownListings] = await Promise.all([
    prisma.order.findMany({ where: { buyerId: userId }, orderBy: { createdAt: 'desc' }, take: 20, select: { listing: { select: { category: true, cropType: true, location: true } } } }),
    prisma.offer.findMany({ where: { buyerId: userId }, orderBy: { createdAt: 'desc' }, take: 20, select: { listing: { select: { category: true, cropType: true, location: true } } } }),
    prisma.listing.findMany({ where: { sellerId: userId }, select: { id: true } }),
  ]);

  const signals = new Map();
  const add = (value, weight) => { if (!value) return; const key = String(value).trim().toLowerCase(); if (!key) return; signals.set(key, (signals.get(key) || 0) + weight); };
  [...orders, ...offers].forEach((x) => { add(x.listing?.cropType, 5); add(x.listing?.location, 3); add(x.listing?.category, 2); });
  const cropSignals = [...signals.entries()].filter(([k]) => k && !['agricultural', 'product', 'digital'].includes(k)).sort((a,b) => b[1]-a[1]).slice(0, 5).map(([k]) => k);
  const locationSignals = [...new Set([...orders, ...offers].map(x => x.listing?.location).filter(Boolean))].slice(0, 5);

  const where = { status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] }, id: { notIn: ownListings.map(x => x.id) } };
  const candidates = await prisma.listing.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, sellerId: true, category: true, title: true, cropType: true, quantity: true, availableQuantity: true, unit: true, askingPrice: true, location: true, harvestedDate: true, readinessDate: true, pickupWindowStart: true, pickupWindowEnd: true, photos: true, videos: true, description: true, status: true, createdByInspectorId: true, createdAt: true, updatedAt: true } });
  const score = (l) => {
    let s = 0;
    const crop = String(l.cropType || '').toLowerCase(); const loc = String(l.location || '').toLowerCase(); const cat = String(l.category || '').toLowerCase();
    cropSignals.forEach((v, i) => { if (crop.includes(v)) s += 20 - i * 2; });
    locationSignals.forEach((v, i) => { if (loc.toLowerCase().includes(String(v).toLowerCase())) s += 10 - i; });
    if (signals.has(cat)) s += signals.get(cat);
    if (l.availableQuantity > 0) s += 2;
    return s;
  };
  candidates.sort((a,b) => score(b) - score(a) || new Date(b.createdAt) - new Date(a.createdAt));
  return { listings: candidates.slice(0, take), basedOn: { cropTypes: cropSignals, locations: locationSignals } };
}

module.exports = { getRecommendations };
