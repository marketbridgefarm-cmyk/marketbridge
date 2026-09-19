'use strict';

/**
 * Pure unit tests for the server-owned advertising pricing logic
 * (backend/src/utils/adPricing.js). No database required — these run as
 * part of the normal `npm test` fast suite.
 *
 * This is a revenue-critical module: the frontend only ever *displays* a
 * price estimate (AdvertiserDashboard.jsx), and routes/ads.js recomputes
 * and stores the real price server-side via quotePrice() before a campaign
 * can be paid for. If this math drifts, every campaign is mispriced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AD_TYPES,
  DEFAULT_DAILY_RATES_ETB,
  BANNER_TEMPLATES,
  DEFAULT_BANNER_TEMPLATE_MULTIPLIERS,
  dailyRatesEtb,
  bannerTemplateMultipliers,
  campaignDays,
  quotePrice,
} = require('../src/utils/adPricing');

test('campaignDays rounds a partial day up to a full day', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-01T12:00:00Z');
  assert.equal(campaignDays(start, end), 1);
});

test('campaignDays counts whole days exactly', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-08T00:00:00Z');
  assert.equal(campaignDays(start, end), 7);
});

test('campaignDays returns 0 for an invalid or non-positive range', () => {
  const day = new Date('2026-01-01T00:00:00Z');
  assert.equal(campaignDays(day, day), 0);
  assert.equal(campaignDays(new Date('2026-01-08'), new Date('2026-01-01')), 0);
  assert.equal(campaignDays('not-a-date', new Date('2026-01-08')), 0);
});

test('quotePrice multiplies whole days by the configured daily rate', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-04T00:00:00Z'); // 3 days
  const price = quotePrice('FEATURED_LISTING', start, end);
  assert.equal(price, 3 * DEFAULT_DAILY_RATES_ETB.FEATURED_LISTING);
});

test('quotePrice rejects an unsupported campaign type', () => {
  assert.throws(() => quotePrice('NOT_A_REAL_TYPE', new Date(), new Date(Date.now() + 86400000)), /Unsupported advertisement type/);
});

test('quotePrice rejects a zero/negative-length window', () => {
  const now = new Date();
  assert.throws(() => quotePrice('BANNER', now, now), /Invalid campaign dates/);
});

test('every declared AD_TYPES entry has a positive default daily rate', () => {
  for (const type of AD_TYPES) {
    assert.ok(DEFAULT_DAILY_RATES_ETB[type] > 0, `${type} is missing a positive default rate`);
  }
});

test('dailyRatesEtb falls back to defaults for missing/invalid env overrides', () => {
  const key = 'AD_RATE_FEATURED_LISTING';
  const original = process.env[key];
  try {
    delete process.env[key];
    assert.equal(dailyRatesEtb().FEATURED_LISTING, DEFAULT_DAILY_RATES_ETB.FEATURED_LISTING);

    process.env[key] = '-5';
    assert.equal(dailyRatesEtb().FEATURED_LISTING, DEFAULT_DAILY_RATES_ETB.FEATURED_LISTING);

    process.env[key] = 'not-a-number';
    assert.equal(dailyRatesEtb().FEATURED_LISTING, DEFAULT_DAILY_RATES_ETB.FEATURED_LISTING);

    process.env[key] = '250';
    assert.equal(dailyRatesEtb().FEATURED_LISTING, 250);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test('quotePrice honors a valid env rate override', () => {
  const key = 'AD_RATE_BANNER';
  const original = process.env[key];
  try {
    process.env[key] = '1000';
    const start = new Date('2026-02-01T00:00:00Z');
    const end = new Date('2026-02-03T00:00:00Z'); // 2 days
    assert.equal(quotePrice('BANNER', start, end), 2000);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test('every declared BANNER_TEMPLATES entry has a positive default multiplier', () => {
  for (const template of BANNER_TEMPLATES) {
    assert.ok(DEFAULT_BANNER_TEMPLATE_MULTIPLIERS[template] > 0, `${template} is missing a positive default multiplier`);
  }
});

test('quotePrice defaults an unspecified BANNER template to CLASSIC (no surcharge)', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-02T00:00:00Z'); // 1 day
  assert.equal(quotePrice('BANNER', start, end), quotePrice('BANNER', start, end, 'CLASSIC'));
});

test('quotePrice applies a premium banner template multiplier on top of the daily rate', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-04T00:00:00Z'); // 3 days
  const base = 3 * DEFAULT_DAILY_RATES_ETB.BANNER;
  assert.equal(quotePrice('BANNER', start, end, 'DARK_LUXE'), base * DEFAULT_BANNER_TEMPLATE_MULTIPLIERS.DARK_LUXE);
  assert.equal(quotePrice('BANNER', start, end, 'EDITORIAL'), base * DEFAULT_BANNER_TEMPLATE_MULTIPLIERS.EDITORIAL);
  assert.ok(quotePrice('BANNER', start, end, 'DARK_LUXE') > quotePrice('BANNER', start, end, 'MINIMAL'), 'premium template should cost more than a standard one');
});

test('quotePrice ignores bannerTemplate entirely for non-BANNER types', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-04T00:00:00Z');
  assert.equal(
    quotePrice('FEATURED_LISTING', start, end, 'DARK_LUXE'),
    quotePrice('FEATURED_LISTING', start, end)
  );
});

test('quotePrice rejects an unsupported banner template', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-02T00:00:00Z');
  assert.throws(() => quotePrice('BANNER', start, end, 'NOT_A_REAL_TEMPLATE'), /Unsupported banner template/);
});

test('bannerTemplateMultipliers falls back to defaults for missing/invalid env overrides', () => {
  const key = 'AD_TEMPLATE_MULTIPLIER_DARK_LUXE';
  const original = process.env[key];
  try {
    delete process.env[key];
    assert.equal(bannerTemplateMultipliers().DARK_LUXE, DEFAULT_BANNER_TEMPLATE_MULTIPLIERS.DARK_LUXE);

    process.env[key] = '-2';
    assert.equal(bannerTemplateMultipliers().DARK_LUXE, DEFAULT_BANNER_TEMPLATE_MULTIPLIERS.DARK_LUXE);

    process.env[key] = 'not-a-number';
    assert.equal(bannerTemplateMultipliers().DARK_LUXE, DEFAULT_BANNER_TEMPLATE_MULTIPLIERS.DARK_LUXE);

    process.env[key] = '2';
    assert.equal(bannerTemplateMultipliers().DARK_LUXE, 2);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test('Telegram CAROUSEL is a selectable template and never changes the price', () => {
  const { TELEGRAM_TEMPLATES } = require('../src/utils/adPricing');
  assert.ok(TELEGRAM_TEMPLATES.includes('CAROUSEL'));
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-04T00:00:00Z');
  // quotePrice has no Telegram-template input by design: every template
  // costs the same flat daily rate.
  assert.equal(quotePrice('TELEGRAM_PROMOTION', start, end), 3 * DEFAULT_DAILY_RATES_ETB.TELEGRAM_PROMOTION);
});

test('telegramCarouselLimits enforces Telegram\'s 2–10 album size and honours config', () => {
  const { telegramCarouselLimits } = require('../src/utils/adPricing');
  const saved = process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES;
  try {
    delete process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES;
    assert.equal(telegramCarouselLimits().minImages, 2);
    assert.equal(telegramCarouselLimits().maxImages, 10);

    process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES = '6';
    assert.equal(telegramCarouselLimits().maxImages, 6);

    // Telegram cannot send more than 10 items in one album, so config can't raise it.
    process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES = '50';
    assert.equal(telegramCarouselLimits().maxImages, 10);

    // Nonsense or below-minimum values fall back to the safe default.
    process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES = '1';
    assert.equal(telegramCarouselLimits().maxImages, 10);
    process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES = 'lots';
    assert.equal(telegramCarouselLimits().maxImages, 10);
  } finally {
    if (saved === undefined) delete process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES;
    else process.env.AD_TELEGRAM_CAROUSEL_MAX_IMAGES = saved;
  }
});
