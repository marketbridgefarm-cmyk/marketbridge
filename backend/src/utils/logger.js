'use strict';

// Structured application logger.
//
// Replaces ad-hoc console.log/console.error calls with structured JSON logs
// (timestamp, level, message, plus arbitrary business fields) so log
// aggregators (Render logs, or any log drain wired up later) can be
// filtered/alerted on instead of grepped by hand.
//
// Usage:
//   const logger = require('../utils/logger');
//   logger.info({ orderId, requestId: req.requestId }, 'order confirmed');
//   logger.error({ err, paymentId }, 'chapa verification failed');
//
// req-scoped logs should prefer `req.log` (attached by requestId middleware,
// see middleware/requestId.js) so every line automatically carries the
// request's correlation ID without having to thread it through manually.

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

// Fields that must never reach logs, no matter which object they're nested
// in — tokens, secrets, passwords, MFA material, card/provider payloads.
// This is a defense-in-depth net: call sites should still avoid logging
// these directly, but a redaction list catches accidental inclusion (e.g.
// logging `req.body` or a full user/payment object during debugging).
const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.mfaSecret',
  '*.backupCodes',
  '*.cardNumber',
  '*.webhookSecret',
  '*.CHAPA_SECRET_KEY',
  '*.JWT_SECRET',
];

const logger = pino({
  level,
  base: { service: 'marketbridge-api' },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    !isProduction
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        }
      : undefined,
});

module.exports = logger;
