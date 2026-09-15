'use strict';

// Same adapter shape as the Chapa payment integration (config/chapa.js):
// one small function this file exposes, provider details are an
// implementation detail behind it. No SMS provider is configured for this
// platform yet, so the default ('console') just logs — this makes the
// whole notification pipeline (outbox write -> scheduler -> "send") fully
// exercisable and testable today, with a real gateway a drop-in swap once
// Alex picks one (AfroMessage and Geez SMS are the common Ethiopian
// options; both expose a simple HTTP send-SMS API a fetch() call away).

const PROVIDER = (process.env.SMS_PROVIDER || 'console').toLowerCase();

/**
 * Normalize a phone number the way it's commonly entered in Ethiopia
 * (09XXXXXXXX, 07XXXXXXXX, +2519XXXXXXXX, 2519XXXXXXXX) into E.164
 * (+2519XXXXXXXX / +2517XXXXXXXX) for a provider API. Returns null if the
 * input doesn't look like a plausible Ethiopian mobile number, so a
 * malformed phone field can't silently eat an SMS send attempt.
 */
function normalizeEthiopianPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');

  if (/^\+251(7|9)\d{8}$/.test(digits)) return digits;
  if (/^251(7|9)\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0(7|9)\d{8}$/.test(digits)) return `+251${digits.slice(1)}`;
  if (/^(7|9)\d{8}$/.test(digits)) return `+251${digits}`;

  return null;
}

async function sendViaConsole({ to, body }) {
  console.log(`[sms:console] -> ${to}: ${body}`);
  return { ok: true, providerMessageId: null };
}

/**
 * Not wired to a real endpoint — no AfroMessage credentials exist in this
 * environment. Left in this shape (rather than omitted) so plugging in a
 * real account is a matter of filling in the fetch call and adding
 * AFROMESSAGE_API_KEY / AFROMESSAGE_SENDER_ID to the environment, not
 * designing the integration from scratch.
 */
async function sendViaAfroMessage({ to, body }) {
  const apiKey = process.env.AFROMESSAGE_API_KEY;
  const senderId = process.env.AFROMESSAGE_SENDER_ID;

  if (!apiKey) {
    throw new Error('AFROMESSAGE_API_KEY is not configured');
  }

  const response = await fetch('https://api.afromessage.com/api/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, message: body, sender: senderId }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AfroMessage send failed (${response.status}): ${text}`);
  }

  const data = await response.json().catch(() => ({}));
  return { ok: true, providerMessageId: data.id || data.messageId || null };
}

const PROVIDERS = {
  console: sendViaConsole,
  afromessage: sendViaAfroMessage,
};

/**
 * Send one SMS. Throws on failure — callers (the maintenance scheduler's
 * sendPendingSms job) are responsible for catching, recording the error,
 * and retrying/giving up per-entry so one bad number can't wedge the batch.
 */
async function sendSms({ to, body }) {
  const normalized = normalizeEthiopianPhone(to);
  if (!normalized) {
    throw new Error(`Not a valid Ethiopian phone number: ${to}`);
  }

  const send = PROVIDERS[PROVIDER];
  if (!send) {
    throw new Error(`Unknown SMS_PROVIDER "${PROVIDER}"`);
  }

  return send({ to: normalized, body });
}

module.exports = { sendSms, normalizeEthiopianPhone };
