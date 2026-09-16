'use strict';

// Error tracking + alerting. Entirely optional: with no SENTRY_DSN set,
// every export here is a harmless no-op, so this never blocks local dev or
// a deploy that hasn't configured it yet.
//
// This is deliberately separate from utils/logger.js (pino). The logger
// writes every request/error to stdout for after-the-fact grepping;
// Sentry additionally groups errors, tracks new-vs-recurring, and (once
// alert rules are set up in the Sentry project) pages a human. Neither
// replaces the other.

let Sentry = null;
const enabled = Boolean(process.env.SENTRY_DSN);

if (enabled) {
  // Loaded lazily so the app can still boot without @sentry/node installed
  // (e.g. before `npm install` has picked up the new dependency) — it just
  // silently runs without error tracking rather than crashing on require.
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      // Render exposes the deployed commit SHA as RENDER_GIT_COMMIT; falls
      // back to an explicit SENTRY_RELEASE if set some other way.
      release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
      // Card numbers, tokens, etc. should never reach Sentry breadcrumbs in
      // the first place (see logger.js's redaction), but this is a second
      // layer: strip Authorization/Cookie headers from anything captured.
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('SENTRY_DSN is set but @sentry/node failed to load — run `npm install` to pick up the new dependency. Continuing without error tracking.', error.message);
    Sentry = null;
  }
}

function setupExpressErrorHandler(app) {
  if (Sentry) Sentry.setupExpressErrorHandler(app);
}

function captureException(err, context) {
  if (Sentry) Sentry.captureException(err, context);
}

function setUser(user) {
  if (Sentry) Sentry.setUser(user);
}

async function flush(timeoutMs = 2000) {
  if (Sentry) {
    try {
      await Sentry.flush(timeoutMs);
    } catch (_) {
      // best-effort — never let a flush failure block process shutdown
    }
  }
}

module.exports = {
  isEnabled: () => enabled && Boolean(Sentry),
  setupExpressErrorHandler,
  captureException,
  setUser,
  flush,
};
