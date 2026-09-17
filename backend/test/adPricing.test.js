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
const { AD_TYPES, DEFAULT_DAILY_RATES_ETB, dailyRatesEtb, campaignDays, quotePrice } = require('../src/utils/adPricing');

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
