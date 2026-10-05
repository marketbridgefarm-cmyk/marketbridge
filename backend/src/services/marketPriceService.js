'use strict';

const COMPLETED_ORDER_STATUSES = ['DELIVERED', 'COMPLETED'];
const CALCULATION_VERSION = 'market-price-v2';
const DEFAULT_SAMPLE_SIZE = 30;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roundMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function identityWhere(listing) {
  if (listing.category === 'AGRICULTURAL' && listing.cropType) {
    return { cropType: { equals: listing.cropType, mode: 'insensitive' } };
  }
  if (listing.category === 'PRODUCT' && listing.title) {
    return { title: { equals: listing.title, mode: 'insensitive' } };
  }
  return {};
}

async function findCompletedComparables(prisma, listing, { locationOnly = false } = {}) {
  const identity = identityWhere(listing);
  const location = locationOnly && listing.region
    ? { region: listing.region }
    : {};

  return prisma.order.findMany({
    where: {
      status: { in: COMPLETED_ORDER_STATUSES },
      quantity: { gt: 0 },
      finalPrice: { gt: 0 },
      listing: {
        category: listing.category,
        unit: listing.unit,
        ...identity,
        ...location,
      },
    },
    select: {
      id: true,
      finalPrice: true,
      quantity: true,
      createdAt: true,
      listing: {
        select: {
          id: true,
          title: true,
          cropType: true,
          unit: true,
          location: true,
          region: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_SAMPLE_SIZE,
  });
}

async function findActiveComparables(prisma, listing) {
  const identity = identityWhere(listing);
  return prisma.listing.findMany({
    where: {
      id: { not: listing.id },
      category: listing.category,
      unit: listing.unit,
      status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] },
      askingPrice: { gt: 0 },
      quantity: { gt: 0 },
      ...identity,
    },
    select: {
      id: true,
      askingPrice: true,
      quantity: true,
      unit: true,
      location: true,
      region: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_SAMPLE_SIZE,
  });
}

function comparableRows(orders) {
  return orders.map((order) => {
    const quantity = finitePositive(order.quantity);
    const total = finitePositive(order.finalPrice);
    if (!quantity || !total) return null;
    return {
      orderId: order.id,
      listingId: order.listing?.id || null,
      unitPrice: roundMoney(total / quantity),
      totalPrice: roundMoney(total),
      quantity,
      createdAt: order.createdAt,
      location: order.listing?.location || null,
      region: order.listing?.region || null,
    };
  }).filter(Boolean).filter((row) => row.unitPrice != null);
}

function activeRows(listings) {
  return listings.map((listing) => {
    const quantity = finitePositive(listing.quantity);
    const total = finitePositive(listing.askingPrice);
    if (!quantity || !total) return null;
    return {
      listingId: listing.id,
      unitPrice: roundMoney(total / quantity),
      totalPrice: roundMoney(total),
      quantity,
      createdAt: listing.createdAt,
      location: listing.location || null,
      region: listing.region || null,
    };
  }).filter(Boolean).filter((row) => row.unitPrice != null);
}

function buildReference(rows, listing, source, targetQuantity = null) {
  const prices = rows.map((row) => row.unitPrice).filter(Number.isFinite);
  if (!prices.length) return null;
  const unitPrice = roundMoney(median(prices));
  const quantity = finitePositive(targetQuantity) || finitePositive(listing.quantity) || 1;
  return {
    unitPrice,
    totalPrice: roundMoney(unitPrice * quantity),
    source,
    observedAt: new Date(),
    location: listing.location || null,
    unit: listing.unit || null,
    sampleSize: prices.length,
    minUnitPrice: roundMoney(Math.min(...prices)),
    maxUnitPrice: roundMoney(Math.max(...prices)),
    samples: rows,
    calculationVersion: CALCULATION_VERSION,
  };
}

/**
 * Calculates a market reference without ever mutating the listing/order price.
 * Completed transactions are preferred; active comparable listings are only a
 * fallback. For agricultural goods the crop type is matched; for products the
 * product title is matched.
 */
async function getMarketPriceReference(prisma, listing, options = {}) {
  if (!listing || !['AGRICULTURAL', 'PRODUCT'].includes(listing.category)) return null;

  let completed = [];
  if (listing.region) completed = await findCompletedComparables(prisma, listing, { locationOnly: true });
  if (!completed.length) completed = await findCompletedComparables(prisma, listing);

  const completedRows = comparableRows(completed);
  if (completedRows.length) return buildReference(completedRows, listing, 'RECENT_COMPLETED_ORDERS', options.quantity);

  const active = await findActiveComparables(prisma, listing);
  const activeRowsData = activeRows(active);
  if (activeRowsData.length) return buildReference(activeRowsData, listing, 'ACTIVE_COMPARABLE_LISTINGS', options.quantity);

  const ownQuantity = finitePositive(listing.quantity);
  const ownPrice = finitePositive(listing.askingPrice);
  if (ownQuantity && ownPrice) {
    const unitPrice = roundMoney(ownPrice / ownQuantity);
    return {
      unitPrice,
      totalPrice: roundMoney(unitPrice * (finitePositive(options.quantity) || ownQuantity)),
      source: 'CURRENT_LISTING_ASKING_PRICE',
      observedAt: new Date(),
      location: listing.location || null,
      unit: listing.unit || null,
      sampleSize: 1,
      minUnitPrice: unitPrice,
      maxUnitPrice: unitPrice,
      samples: [{ listingId: listing.id, unitPrice, totalPrice: ownPrice, quantity: ownQuantity, location: listing.location || null, region: listing.region || null }],
      calculationVersion: CALCULATION_VERSION,
    };
  }

  return null;
}

function reasonForAdjustment(currentPrice, suggestedPrice, inspectedQuantity, orderedQuantity) {
  if (orderedQuantity && inspectedQuantity && Math.abs(orderedQuantity - inspectedQuantity) > 1e-9) {
    return 'QUALITY_OR_QUANTITY_CHANGE';
  }
  if (suggestedPrice > currentPrice) return 'MARKET_PRICE_RISE';
  if (suggestedPrice < currentPrice) return 'MARKET_PRICE_FALL';
  return null;
}

/**
 * Builds a non-binding post-inspection price suggestion. Quantity is objective;
 * market price is a reference. Grade/damage are deliberately not converted to
 * an arbitrary percentage because MarketBridge has no universal grading tariff.
 */
async function getInspectionPriceSuggestion(prisma, order) {
  if (!order?.listing || !order?.quantity) return null;
  const inspection = (order.inspectionRequests || []).find((r) => r.status === 'COMPLETED' && r.report) || null;
  if (!inspection?.report) return null;

  const report = inspection.report;
  const inspectedQuantity = finitePositive(report.quantity);
  const orderedQuantity = finitePositive(order.quantity);
  const originalTotal = finitePositive(order.originalFinalPrice ?? order.finalPrice);
  if (!inspectedQuantity || !orderedQuantity || !originalTotal) return null;

  const originalUnitPrice = originalTotal / orderedQuantity;
  const quantityAdjustedPrice = roundMoney(originalUnitPrice * inspectedQuantity);
  const market = await getMarketPriceReference(prisma, {
    ...order.listing,
    quantity: inspectedQuantity,
  });

  const marketBasedPrice = market?.unitPrice ? roundMoney(market.unitPrice * inspectedQuantity) : null;
  const suggestedPrice = marketBasedPrice != null && (market.sampleSize || 0) >= 2
    ? marketBasedPrice
    : quantityAdjustedPrice;
  const adjustmentAmount = roundMoney(suggestedPrice - Number(order.finalPrice));
  const adjustmentPercent = Number(order.finalPrice) > 0
    ? Math.round((adjustmentAmount / Number(order.finalPrice)) * 10000) / 100
    : null;

  return {
    calculationVersion: CALCULATION_VERSION,
    currentAgreedPrice: Number(order.finalPrice),
    originalAgreedPrice: Number(originalTotal),
    originalUnitPrice: roundMoney(originalUnitPrice),
    orderedQuantity,
    inspectedQuantity,
    quantityAdjustedPrice,
    marketReference: market,
    marketBasedPrice,
    suggestedPrice,
    adjustmentAmount,
    adjustmentPercent,
    suggestedReasonCode: reasonForAdjustment(Number(order.finalPrice), suggestedPrice, inspectedQuantity, orderedQuantity),
    qualityFinding: {
      grade: report.grade || null,
      moisture: report.moisture ?? null,
      visibleDefects: report.visibleDefects || null,
      damageNotes: report.damageNotes || null,
      packagingNotes: report.packagingNotes || null,
    },
    requiresReview: Math.abs(adjustmentAmount || 0) >= 0.01,
  };
}

function marketSnapshotData(reference, quantity) {
  if (!reference) return {
    marketReferenceUnitPrice: null,
    marketReferenceTotalPrice: null,
    marketReferenceSource: null,
    marketReferenceDate: null,
    marketReferenceLocation: null,
    marketReferenceUnit: null,
    marketSampleSize: null,
    marketMinUnitPrice: null,
    marketMaxUnitPrice: null,
  };
  return {
    marketReferenceUnitPrice: reference.unitPrice,
    marketReferenceTotalPrice: reference.unitPrice && quantity ? roundMoney(reference.unitPrice * Number(quantity)) : reference.totalPrice,
    marketReferenceSource: reference.source,
    marketReferenceDate: reference.observedAt,
    marketReferenceLocation: reference.location,
    marketReferenceUnit: reference.unit,
    marketSampleSize: reference.sampleSize,
    marketMinUnitPrice: reference.minUnitPrice,
    marketMaxUnitPrice: reference.maxUnitPrice,
  };
}

module.exports = {
  CALCULATION_VERSION,
  getMarketPriceReference,
  getInspectionPriceSuggestion,
  marketSnapshotData,
};
