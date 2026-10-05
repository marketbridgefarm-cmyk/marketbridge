'use strict';

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const middle = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[middle] : (nums[middle - 1] + nums[middle]) / 2;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/**
 * Advisory market reference only.
 * It is deliberately independent from the buyer's selectable offer amount.
 * Recent completed MarketBridge transactions are preferred; active comparable
 * listings are a fallback when there is insufficient transaction history.
 */
async function getMarketReference(prisma, listing, { days = 180, sampleLimit = 50 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const comparableWhere = {
    category: listing.category,
    unit: listing.unit,
    ...(listing.category === 'AGRICULTURAL'
      ? { cropType: listing.cropType || null }
      : { title: listing.title || null }),
  };

  const completedOrders = await prisma.order.findMany({
    where: {
      status: 'COMPLETED',
      createdAt: { gte: since },
      listing: comparableWhere,
    },
    orderBy: { createdAt: 'desc' },
    take: sampleLimit,
    select: {
      finalPrice: true,
      quantity: true,
      createdAt: true,
      listing: { select: { location: true, unit: true } },
    },
  });

  const transactionPrices = completedOrders
    .map((o) => {
      const total = Number(o.finalPrice);
      const quantity = Number(o.quantity);
      return quantity > 0 && total > 0 ? total / quantity : null;
    })
    .filter((v) => Number.isFinite(v) && v > 0);

  let source = 'RECENT_COMPLETED_ORDERS';
  let prices = transactionPrices;
  let referenceDate = completedOrders[0]?.createdAt || null;

  if (!prices.length) {
    source = 'ACTIVE_COMPARABLE_LISTINGS';
    const listings = await prisma.listing.findMany({
      where: {
        category: listing.category,
        unit: listing.unit,
        status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] },
        ...(listing.category === 'AGRICULTURAL'
          ? { cropType: listing.cropType || null }
          : { title: listing.title || null }),
        id: { not: listing.id },
      },
      orderBy: { updatedAt: 'desc' },
      take: sampleLimit,
      select: { askingPrice: true, updatedAt: true },
    });
    prices = listings.map((l) => Number(l.askingPrice)).filter((v) => Number.isFinite(v) && v > 0);
    referenceDate = listings[0]?.updatedAt || null;
  }

  const unitPrice = median(prices);
  if (unitPrice == null) return null;

  return {
    unitPrice: roundMoney(unitPrice),
    totalPrice: roundMoney(unitPrice * Number(listing.quantity || 0)),
    source,
    sampleSize: prices.length,
    minUnitPrice: roundMoney(Math.min(...prices)),
    maxUnitPrice: roundMoney(Math.max(...prices)),
    referenceDate,
    location: listing.location || null,
    unit: listing.unit || null,
  };
}

module.exports = { getMarketReference, roundMoney };
