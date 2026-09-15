'use strict';

const rateLimit = require('express-rate-limit');
const RedisRateLimitStore = require('../utils/redisRateLimitStore');

function createStore(windowMs, prefix) {
  if (process.env.REDIS_URL) {
    return new RedisRateLimitStore({ windowMs, prefix });
  }
  return undefined; // express-rate-limit's memory store for single-instance dev/test.
}

const common = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: false,
};

// General API limiter: generous, just there to blunt scraping/abuse.
const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 300,
  store: createStore(15 * 60 * 1000, 'marketbridge:rl:api:'),
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.path === '/health',
});

// Tight limiter for auth endpoints (register/login).
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: createStore(15 * 60 * 1000, 'marketbridge:rl:auth:'),
  message: { error: 'Too many auth attempts. Please try again later.' },
});

// Even tighter limiter for payment endpoints.
const paymentLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 10,
  store: createStore(60 * 1000, 'marketbridge:rl:payment:'),
  message: { error: 'Too many payment attempts. Please slow down.' },
});

// Webhooks MUST be rate-limited even when a signature header is present.
// Header presence is not proof of authenticity. Signature verification is
// performed by the webhook handler after this limiter.
const webhookLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 60,
  store: createStore(60 * 1000, 'marketbridge:rl:webhook:'),
  message: { error: 'Too many webhook requests.' },
});

const stores = [apiLimiter, authLimiter, paymentLimiter, webhookLimiter]
  .map((limiter) => limiter.store)
  .filter((store) => store && typeof store.ping === 'function');

async function checkRedisHealth() {
  if (!process.env.REDIS_URL) return true;
  if (!stores.length) return false;
  const results = await Promise.all(stores.map((store) => store.ping()));
  return results.every(Boolean);
}

async function shutdownRateLimitStores() {
  await Promise.all(stores.map((store) => store.shutdown().catch(() => undefined)));
}

module.exports = { apiLimiter, authLimiter, paymentLimiter, webhookLimiter, checkRedisHealth, shutdownRateLimitStores };
