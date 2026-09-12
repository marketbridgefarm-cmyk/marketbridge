'use strict';

const AD_TYPES = [
  'FEATURED_LISTING',
  'TOP_OF_CATEGORY',
  'SPONSORED_SEARCH',
  'BANNER',
  'TELEGRAM_PROMOTION',
];

const DEFAULT_DAILY_RATES_ETB = {
  FEATURED_LISTING: 100,
  TOP_OF_CATEGORY: 150,
  SPONSORED_SEARCH: 125,
  BANNER: 500,
  TELEGRAM_PROMOTION: 250,
};

function rateFromEnv(type) {
  const raw = process.env[`AD_RATE_${type}`];
  if (raw == null || raw === '') return DEFAULT_DAILY_RATES_ETB[type];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_RATES_ETB[type];
}

function dailyRatesEtb() {
  return Object.fromEntries(AD_TYPES.map((type) => [type, rateFromEnv(type)]));
}

function campaignDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
}

function quotePrice(type, startDate, endDate) {
  if (!AD_TYPES.includes(type)) throw new Error('Unsupported advertisement type');
  const days = campaignDays(startDate, endDate);
  if (!days) throw new Error('Invalid campaign dates');
  return Math.round(days * rateFromEnv(type) * 100) / 100;
}

module.exports = { AD_TYPES, DEFAULT_DAILY_RATES_ETB, dailyRatesEtb, campaignDays, quotePrice };
