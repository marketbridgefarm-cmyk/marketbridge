'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// This test intentionally runs without REDIS_URL so it does not require an
// external service. It verifies the production-critical configuration shape.
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

test('rate limit middleware exports all protected limiters', () => {
  const limits = require('../src/middleware/rateLimit');
  assert.equal(typeof limits.apiLimiter, 'function');
  assert.equal(typeof limits.authLimiter, 'function');
  assert.equal(typeof limits.paymentLimiter, 'function');
  assert.equal(typeof limits.webhookLimiter, 'function');
});
