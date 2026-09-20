'use strict';

const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { webhookLimiter } = require('../middleware/rateLimit');
const { handleInboundSms } = require('../services/smsListingService');
const { sendSms } = require('../services/smsService');

const router = express.Router();

/**
 * Shared-secret check for the inbound SMS webhook. Unlike the Chapa
 * payment webhook, there's no specific provider chosen/configured yet
 * (see smsService.js's PROVIDER switch), so there's no vendor-specific
 * signature scheme to verify against. This is deliberately the simplest
 * thing that still stops an open, unauthenticated endpoint from letting
 * anyone on the internet create draft listings: a shared secret set in
 * SMS_INBOUND_WEBHOOK_SECRET and compared with a constant-time check.
 * Whichever SMS provider Alex ends up wiring up for real should configure
 * its webhook to send this as a header or query param.
 */
function verifyInboundSecret(req) {
  const configured = process.env.SMS_INBOUND_WEBHOOK_SECRET;
  if (!configured) return false; // fail closed if unconfigured, not open.

  const provided = req.get('x-marketbridge-sms-secret') || req.query.secret || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(configured));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post(
  '/inbound',
  webhookLimiter,
  [body('from').notEmpty(), body('text').notEmpty()],
  async (req, res) => {
    try {
      if (!verifyInboundSecret(req)) {
        req.log.warn('SMS INBOUND: rejected, missing/invalid webhook secret');
        return res.status(401).json({ error: 'Invalid webhook credentials' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0]?.msg || 'from and text are required' });
      }

      const { from, text } = req.body;
      const result = await handleInboundSms({ from: String(from), text: String(text).slice(0, 480) });

      if (result.reply && result.to) {
        // Best-effort reply, sent synchronously (not via the outbox) since
        // this is a direct request/response conversation, not a
        // triggered notification. If the send fails (e.g. console
        // provider in dev, or a real provider hiccup), the webhook still
        // acknowledges 200 — the sender just won't get confirmation text,
        // which mirrors how a flaky carrier would behave anyway.
        try {
          await sendSms({ to: result.to, body: result.reply });
        } catch (sendError) {
          req.log.warn({ err: sendError }, 'SMS INBOUND: could not send reply');
        }
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      req.log.error({ err: error }, 'SMS INBOUND ERROR:');
      // Still 200 — most SMS providers retry aggressively on non-2xx,
      // and a parsing/DB error here shouldn't cause the same message to
      // be redelivered and potentially double-create a listing.
      return res.status(200).json({ received: true, error: 'Could not process message' });
    }
  }
);

module.exports = router;
