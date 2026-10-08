'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timing = require('../src/utils/orderTiming');

test('Step 5 deadlines default to 24 hours', () => {
  const from = new Date('2026-10-08T00:00:00.000Z');
  assert.equal(timing.computeBuyerDecisionDueAt(from).toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(timing.computeSellerPreparationDueAt(from).toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(timing.computeBuyerLoadingDueAt(from).toISOString(), '2026-10-09T00:00:00.000Z');
});

test('Step 5 deadline hours are configurable independently', () => {
  const from = new Date('2026-10-08T00:00:00.000Z');
  const old = {
    buyer: process.env.BUYER_DECISION_TIMEOUT_HOURS,
    seller: process.env.SELLER_PREPARATION_TIMEOUT_HOURS,
    loading: process.env.BUYER_LOADING_TIMEOUT_HOURS,
  };
  process.env.BUYER_DECISION_TIMEOUT_HOURS = '6';
  process.env.SELLER_PREPARATION_TIMEOUT_HOURS = '12';
  process.env.BUYER_LOADING_TIMEOUT_HOURS = '18';
  try {
    assert.equal(timing.computeBuyerDecisionDueAt(from).toISOString(), '2026-10-08T06:00:00.000Z');
    assert.equal(timing.computeSellerPreparationDueAt(from).toISOString(), '2026-10-08T12:00:00.000Z');
    assert.equal(timing.computeBuyerLoadingDueAt(from).toISOString(), '2026-10-08T18:00:00.000Z');
  } finally {
    for (const [key, value] of Object.entries({
      BUYER_DECISION_TIMEOUT_HOURS: old.buyer,
      SELLER_PREPARATION_TIMEOUT_HOURS: old.seller,
      BUYER_LOADING_TIMEOUT_HOURS: old.loading,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
