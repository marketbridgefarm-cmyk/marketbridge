'use strict';

const crypto = require('crypto');
const prisma = require('../config/db');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requestKey(req) {
  return req.get('Idempotency-Key') || req.body?.idempotencyKey || null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function requestFingerprint(req) {
  return hashKey(`${req.method}:${req.baseUrl || ''}${req.path || req.originalUrl || ''}:${stableStringify(req.body || {})}`);
}

function idempotency(scope, options = {}) {
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  const requireKey = Boolean(options.requireKey);

  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = requestKey(req);

    if (!rawKey) {
      if (requireKey) {
        return res.status(400).json({ error: 'Idempotency-Key is required for this operation' });
      }
      return next();
    }

    const key = String(rawKey).trim();
    if (!key || key.length > 200) {
      return res.status(400).json({ error: 'Idempotency-Key must be between 1 and 200 characters' });
    }

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const keyHash = hashKey(key);
    const requestHash = requestFingerprint(req);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    let record;

    try {
      try {
        record = await prisma.idempotencyRequest.create({
          data: { userId, scope, keyHash, requestHash, expiresAt },
        });
      } catch (error) {
        if (error.code !== 'P2002') throw error;

        record = await prisma.idempotencyRequest.findUnique({
          where: { userId_scope_keyHash: { userId, scope, keyHash } },
        });

        if (!record) return res.status(409).json({ error: 'Request is already being processed. Please retry.' });

        if (record.requestHash !== requestHash) {
          return res.status(409).json({ error: 'Idempotency-Key was already used for a different request' });
        }

        if (record.status === 'COMPLETED') {
          return res.status(record.statusCode || 200).json(record.response ?? {});
        }

        if (record.expiresAt > now) {
          return res.status(409).json({ error: 'Request is already being processed. Please retry shortly.' });
        }

        const takeover = await prisma.idempotencyRequest.updateMany({
          where: { id: record.id, status: 'PROCESSING', expiresAt: { lte: now } },
          data: { expiresAt, updatedAt: now },
        });

        if (takeover.count !== 1) {
          return res.status(409).json({ error: 'Request is already being processed. Please retry shortly.' });
        }
      }

      req.idempotency = { id: record.id, scope, keyHash };

      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      let captured = false;

      const persist = async (body) => {
        if (captured || !req.idempotency) return;
        captured = true;
        const statusCode = res.statusCode || 200;
        try {
          if (statusCode >= 200 && statusCode < 400) {
            await prisma.idempotencyRequest.update({
              where: { id: req.idempotency.id },
              data: { status: 'COMPLETED', statusCode, response: body },
            });
          } else {
            await prisma.idempotencyRequest.delete({ where: { id: req.idempotency.id } }).catch(() => {});
          }
        } catch (error) {
          console.error('IDEMPOTENCY CACHE ERROR:', error);
        }
      };

      res.json = function patchedJson(body) {
        void persist(body);
        return originalJson(body);
      };

      res.send = function patchedSend(body) {
        void persist(body);
        return originalSend(body);
      };

      return next();
    } catch (error) {
      console.error('IDEMPOTENCY MIDDLEWARE ERROR:', error);
      return res.status(500).json({ error: 'Could not initialize request idempotency' });
    }
  };
}

module.exports = { idempotency, hashKey };
