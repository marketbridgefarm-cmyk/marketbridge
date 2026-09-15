'use strict';

// Shared Redis-backed store for express-rate-limit. This is required when
// MarketBridge runs more than one API instance; in-memory counters are only
// safe for a single process.

const Redis = require('ioredis');

class RedisRateLimitStore {
  constructor({ windowMs, prefix = 'marketbridge:ratelimit:' }) {
    this.windowMs = Number(windowMs);
    this.prefix = prefix;
    this.redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000),
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });

    this.redis.on('error', (error) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[rate-limit-redis] Redis error:', error.message);
      }
    });
  }

  init(options) {
    this.windowMs = Number(options?.windowMs || this.windowMs);
  }

  async _ensureConnected() {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  async increment(key) {
    await this._ensureConnected();

    const redisKey = `${this.prefix}${key}`;
    const ttlMs = Math.max(1, this.windowMs);

    // Atomically increment and apply the window only when the key is new.
    // This avoids the race where two API instances both reset a counter.
    const result = await this.redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
       local ttl = redis.call('PTTL', KEYS[1])
       return {n, ttl}`,
      1,
      redisKey,
      ttlMs
    );

    const totalHits = Number(result[0]);
    const ttl = Math.max(1, Number(result[1]));

    return {
      totalHits,
      resetTime: new Date(Date.now() + ttl),
    };
  }

  async decrement(key) {
    await this._ensureConnected();
    const redisKey = `${this.prefix}${key}`;
    await this.redis.eval(
      `local n = redis.call('DECR', KEYS[1])
       if n <= 0 then redis.call('DEL', KEYS[1]) end
       return n`,
      1,
      redisKey
    );
  }

  async resetKey(key) {
    await this._ensureConnected();
    await this.redis.del(`${this.prefix}${key}`);
  }

  async shutdown() {
    if (this.redis.status !== 'end') {
      await this.redis.quit();
    }
  }
}

module.exports = RedisRateLimitStore;
