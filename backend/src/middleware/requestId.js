'use strict';

// Request/correlation ID middleware.
//
// Every inbound request gets a request ID — reused from the caller's
// X-Request-Id header when present (so a frontend or upstream proxy can
// pass its own trace ID through), otherwise generated fresh. The ID is:
//   - echoed back as a response header (X-Request-Id) for client-side
//     correlation with support tickets / bug reports,
//   - attached to req.requestId for manual use in routes/services,
//   - attached to req.log — a pino child logger pre-bound with the
//     request ID (and route/method) — so every log line emitted while
//     handling this request can be traced end-to-end without threading
//     the ID through every function call by hand,
//   - passed through to payment operations and audit events so a support
//     request ("order X failed to pay") can be grepped across logs,
//     PaymentReconciliation rows, and AuditEvent rows using one ID.
//
// This directly targets PDF section "Request IDs": "Add a request/
// correlation ID to API requests and carry it through logs, payment
// operations, audit events and error reports."

const crypto = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../utils/logger');

function genRequestId(req) {
  const upstream = req.headers['x-request-id'];
  if (upstream && typeof upstream === 'string' && upstream.length <= 128) {
    return upstream;
  }
  return crypto.randomUUID();
}

const requestIdMiddleware = pinoHttp({
  logger,
  genReqId: genRequestId,
  customProps: (req) => ({ requestId: req.id }),
  // Keep access logs lean: method, path, status, duration — not headers/body.
  serializers: {
    req(req) {
      return { method: req.method, url: req.url };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Don't spam logs with load-balancer/uptime health checks.
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/ready',
  },
});

// Small shim so route/service code can do `req.requestId` (matches the
// naming already used elsewhere in this codebase, e.g. inspections.js's
// unrelated local `requestId` param) alongside pino-http's `req.id`.
function attachRequestId(req, res, next) {
  req.requestId = req.id;
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { requestIdMiddleware, attachRequestId };
