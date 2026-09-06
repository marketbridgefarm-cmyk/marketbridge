// Chapa (chapa.co) payment gateway client.
//
// Ethiopia-licensed payment gateway operator. Supports card, Telebirr, and
// bank-transfer checkout without requiring the merchant to be in a
// Stripe-eligible country.
//
// Enhanced with:
// - Request retry logic
// - Better error handling
// - Timeout support
// - Logging

const crypto = require('crypto');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';
const TIMEOUT_MS = 30000; // 30 second timeout

function getSecretKey() {
  const key = process.env.CHAPA_SECRET_KEY;
  if (!key) throw new Error('CHAPA_SECRET_KEY is not configured');
  return key;
}

function getWebhookSecret() {
  const key = process.env.CHAPA_WEBHOOK_SECRET;
  if (!key) throw new Error('CHAPA_WEBHOOK_SECRET is not configured');
  return key;
}

function getChapaMode() {
  const key = process.env.CHAPA_SECRET_KEY || '';
  return key.startsWith('CHASECK_TEST-') ? 'test' : key ? 'live' : 'unconfigured';
}

// Enhanced fetch with timeout and retry
async function chapaFetch(path, options = {}, retries = 2) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${CHAPA_BASE_URL}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${getSecretKey()}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const message = data?.message || `Chapa request failed (${res.status})`;
        const error = Object.assign(new Error(message), {
          status: res.status,
          chapaResponse: data,
          retryable: res.status >= 500 || res.status === 429,
        });

        // Retry on 5xx or rate limit
        if (error.retryable && attempt < retries) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }

        throw error;
      }

      clearTimeout(timeoutId);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        clearTimeout(timeoutId);
        throw Object.assign(new Error('Chapa request timed out'), { status: 504 });
      }

      lastError = error;

      // Retry network errors
      if (attempt < retries && !error.status) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      clearTimeout(timeoutId);
      throw error;
    }
  }

  clearTimeout(timeoutId);
  throw lastError || new Error('Chapa request failed');
}

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
        title: (title || 'MarketBridge payment').slice(0, 16),
        description: description || undefined,
      },
    }),
  });

  const checkoutUrl = data?.data?.checkout_url;
  if (!checkoutUrl) throw Object.assign(new Error('Chapa did not return a checkout URL'), { status: 502, chapaResponse: data });
  return { checkoutUrl, raw: data };
}

async function verifyTransaction(txRef) {
  const data = await chapaFetch(`/transaction/verify/${encodeURIComponent(txRef)}`, { method: 'GET' });
  const status = data?.data?.status; // expected: 'success' | 'failed' | 'pending'
  return { status, raw: data };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  try {
    const expected = crypto.createHmac('sha256', getWebhookSecret()).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (error) {
    console.error('Webhook signature verification error:', error.message);
    return false;
  }
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature, getChapaMode };  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', getWebhookSecret()).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature, getChapaMode };
