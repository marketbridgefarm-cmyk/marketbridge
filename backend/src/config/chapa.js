// Chapa (chapa.co) payment gateway client.
//
// Ethiopia-licensed payment gateway operator. Supports card, Telebirr, and
// bank-transfer checkout without requiring the merchant to be in a
// Stripe-eligible country. Works identically in test mode (no KYC needed,
// uses Chapa's own test cards, no real money moves) and live mode
// (requires Chapa's compliance/KYC approval) — same endpoints, same
// payload shapes, just different keys. Switch CHAPA_SECRET_KEY from a
// CHASECK_TEST-... key to a live CHASECK-... key when ready; no code
// changes needed.
//
// CAVEAT: the initialize/verify request-response shapes below are
// well-documented and stable. The webhook payload shape has drifted across
// Chapa's own docs and community integrations historically — treat the
// webhook handler as best-effort and lean on the verify-on-return flow
// (which calls Chapa directly and is authoritative) as the primary
// confirmation path until you've confirmed the exact webhook fields by
// inspecting a real test event in your Chapa dashboard or server logs.

const crypto = require('crypto');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

function getSecretKey() {
  const key = process.env.CHAPA_SECRET_KEY;
  if (!key) throw new Error('CHAPA_SECRET_KEY is not configured');
  return key;
}

async function chapaFetch(path, options = {}) {
  const res = await fetch(`${CHAPA_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.message || `Chapa request failed (${res.status})`;
    throw Object.assign(new Error(message), { status: 502, chapaResponse: data });
  }
  return data;
}

// Initializes a transaction and returns a hosted checkout URL to redirect
// the browser to. txRef must be unique per attempt — we use the Payment's
// own id, which is safe to reuse across retries of the same still-PENDING
// payment.
async function initializeTransaction({
  txRef, amount, currency = 'ETB', email, firstName, lastName, phoneNumber,
  callbackUrl, returnUrl, title, description,
}) {
  const data = await chapaFetch('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref: txRef,
      amount: String(amount),
      currency,
      email: email || undefined,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      phone_number: phoneNumber || undefined,
      callback_url: callbackUrl,
      return_url: returnUrl,
      customization: {
        title: (title || 'MarketBridge payment').slice(0, 16), // Chapa limits this field's length
        description: description || undefined,
      },
    }),
  });

  const checkoutUrl = data?.data?.checkout_url;
  if (!checkoutUrl) throw Object.assign(new Error('Chapa did not return a checkout URL'), { status: 502, chapaResponse: data });
  return { checkoutUrl, raw: data };
}

// Authoritative status check — call this on the return_url page rather
// than trusting only the webhook, since webhook delivery/format can lag
// or vary.
async function verifyTransaction(txRef) {
  const data = await chapaFetch(`/transaction/verify/${encodeURIComponent(txRef)}`, { method: 'GET' });
  const status = data?.data?.status; // expected: 'success' | 'failed' | 'pending'
  return { status, raw: data };
}

// Chapa signs webhook bodies with the secret key over the raw JSON body.
// Confirm the exact header name and algorithm against your dashboard's
// webhook settings / a real test event before relying on this in
// production — see the caveat above.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', getSecretKey()).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };
