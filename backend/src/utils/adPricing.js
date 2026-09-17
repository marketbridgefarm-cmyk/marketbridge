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

// BANNER-only visual layout templates. The dashboard markets several of
// these as "premium"/"high-end" (Dark Luxe, Editorial) versus "clean"/
// standard (Minimal, Classic) — the multiplier here is what actually backs
// that marketing claim up. Ignored entirely for every non-BANNER type.
const DEFAULT_BANNER_TEMPLATE_MULTIPLIERS = {
  CLASSIC: 1,
  BOLD: 1,
  MINIMAL: 1,
  CARD: 1.1,
  FRESH: 1.1,
  MARKET: 1.1,
  SPLIT: 1.25,
  GRADIENT: 1.25,
  EDITORIAL: 1.5,
  DARK_LUXE: 1.5,
};

const BANNER_TEMPLATES = Object.keys(DEFAULT_BANNER_TEMPLATE_MULTIPLIERS);

function rateFromEnv(type) {
  const raw = process.env[`AD_RATE_${type}`];
  if (raw == null || raw === '') return DEFAULT_DAILY_RATES_ETB[type];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_RATES_ETB[type];
}

function templateMultiplierFromEnv(template) {
  const raw = process.env[`AD_TEMPLATE_MULTIPLIER_${template}`];
  const fallback = DEFAULT_BANNER_TEMPLATE_MULTIPLIERS[template];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function dailyRatesEtb() {
  return Object.fromEntries(AD_TYPES.map((type) => [type, rateFromEnv(type)]));
}

function bannerTemplateMultipliers() {
  return Object.fromEntries(BANNER_TEMPLATES.map((template) => [template, templateMultiplierFromEnv(template)]));
}

function campaignDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
}

function quotePrice(type, startDate, endDate, bannerTemplate) {
  if (!AD_TYPES.includes(type)) throw new Error('Unsupported advertisement type');
  const days = campaignDays(startDate, endDate);
  if (!days) throw new Error('Invalid campaign dates');
  let multiplier = 1;
  if (type === 'BANNER') {
    const template = bannerTemplate || 'CLASSIC';
    if (!BANNER_TEMPLATES.includes(template)) throw new Error('Unsupported banner template');
    multiplier = templateMultiplierFromEnv(template);
  }
  return Math.round(days * rateFromEnv(type) * multiplier * 100) / 100;
}

module.exports = {
  AD_TYPES,
  DEFAULT_DAILY_RATES_ETB,
  BANNER_TEMPLATES,
  DEFAULT_BANNER_TEMPLATE_MULTIPLIERS,
  dailyRatesEtb,
  bannerTemplateMultipliers,
  campaignDays,
  quotePrice,
};
