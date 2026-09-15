'use strict';

const prisma = require('../config/db');

function money(value) { return Number(value || 0); }

async function getMarketplaceAnalytics(userId) {
  const [sales, purchases, listings, ratings, ads] = await Promise.all([
    prisma.order.findMany({ where: { sellerId: userId, status: { in: ['CONFIRMED','TRANSPORT_ARRANGED','IN_TRANSIT','DELIVERED','COMPLETED'] } }, select: { finalPrice: true, quantity: true, createdAt: true } }),
    prisma.order.findMany({ where: { buyerId: userId }, select: { finalPrice: true, status: true, createdAt: true } }),
    prisma.listing.findMany({ where: { sellerId: userId }, select: { status: true, askingPrice: true, availableQuantity: true, createdAt: true } }),
    prisma.rating.findMany({ where: { toUserId: userId }, select: { score: true } }),
    prisma.advertisement.findMany({ where: { advertiserId: userId }, include: { events: { select: { eventType: true } } } }),
  ]);

  const completedSales = sales.length;
  const grossSales = sales.reduce((sum, o) => sum + money(o.finalPrice), 0);
  const completedPurchases = purchases.filter(o => ['CONFIRMED','TRANSPORT_ARRANGED','IN_TRANSIT','DELIVERED','COMPLETED'].includes(o.status));
  const spend = completedPurchases.reduce((sum, o) => sum + money(o.finalPrice), 0);
  const activeListings = listings.filter(l => l.status === 'ACTIVE').length;
  const soldListings = listings.filter(l => l.status === 'SOLD').length;
  const averageRating = ratings.length ? ratings.reduce((s, r) => s + r.score, 0) / ratings.length : 0;
  const impressions = ads.reduce((s, ad) => s + ad.events.filter(e => e.eventType === 'IMPRESSION').length, 0);
  const clicks = ads.reduce((s, ad) => s + ad.events.filter(e => e.eventType === 'CLICK').length, 0);

  return {
    seller: { completedSales, grossSales, activeListings, soldListings, averageRating: Number(averageRating.toFixed(2)) },
    buyer: { completedPurchases: completedPurchases.length, spend },
    advertising: { campaigns: ads.length, impressions, clicks, ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0 },
  };
}

module.exports = { getMarketplaceAnalytics };
