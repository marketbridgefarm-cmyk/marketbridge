// MarketBridge Chapa integration.
// Uses Chapa's hosted checkout API for test/live payments.

const crypto = require('crypto');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';
const TIMEOUT_MS = Number(process.env.CHAPA_TIMEOUT_MS || 30000);

function getSecretKey() {
  const key = process.env.CHAPA_SECRET_KEY;
  if (!key) throw new Error('CHAPA_SECRET_KEY is not configured');
  return key.trim();
}

function getWebhookSecret() {
  const key = process.env.CHAPA_WEBHOOK_SECRET;
  if (!key) throw new Error('CHAPA_WEBHOOK_SECRET is not configured');
  return key.trim();
}

function getChapaMode() {
  const key = process.env.CHAPA_SECRET_KEY || '';
  return key.startsWith('CHASECK_TEST-') ? 'test' : key ? 'live' : 'unconfigured';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function chapaFetch(path, options = {}, retries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${CHAPA_BASE_URL}${path}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${getSecretKey()}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const message = data?.message || data?.error || data?.data?.message || `Chapa request failed (${response.status})`;
        const error = Object.assign(new Error(message), {
          status: response.status,
          chapaResponse: data,
          retryable: response.status >= 500 || response.status === 429,
        });

        if (error.retryable && attempt < retries) {
          lastError = error;
          await sleep(1000 * (attempt + 1));
          continue;
        }

        throw error;
      }

      return data;
    } catch (error) {
      lastError = error;

      if (error.name === 'AbortError') {
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw Object.assign(new Error('Chapa request timed out'), { status: 504 });
      }

      if (attempt < retries && !error.status) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Chapa request failed');
}

function validEthiopianPhone(value) {
  const phone = String(value || '').replace(/[\s-]/g, '');
  return /^0[79]\d{8}$/.test(phone) ? phone : undefined;
}

async function initializeTransaction({
  txRef,
  amount,
  currency = 'ETB',
  email,
  firstName,
  lastName,
  phoneNumber,
  callbackUrl,
  returnUrl,
  title,
  description,
}) {
  if (!txRef) throw Object.assign(new Error('Chapa transaction reference is required'), { status: 400 });
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw Object.assign(new Error('Chapa payment amount must be greater than zero'), { status: 400 });
  }
  if (currency !== 'ETB' && currency !== 'USD') {
    throw Object.assign(new Error('Chapa currency must be ETB or USD'), { status: 400 });
  }
  if (!callbackUrl || !returnUrl) {
    throw Object.assign(new Error('Chapa callback and return URLs are required'), { status: 400 });
  }

  const payload = {
    tx_ref: String(txRef),
    amount: String(amount),
    currency,
    email: email || undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    phone_number: validEthiopianPhone(phoneNumber),
    callback_url: callbackUrl,
    return_url: returnUrl,
    customization: {
      title: String(title || 'MarketBridge').slice(0, 16),
      description: String(description || 'MarketBridge payment').slice(0, 200),
    },
  };

  const data = await chapaFetch('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const checkoutUrl = data?.data?.checkout_url;
  if (!checkoutUrl) {
    throw Object.assign(new Error(data?.message || 'Chapa did not return a checkout URL'), {
      status: 502,
      chapaResponse: data,
    });
  }

  return { checkoutUrl, raw: data };
}

async function verifyTransaction(txRef) {
  const data = await chapaFetch(`/transaction/verify/${encodeURIComponent(txRef)}`, { method: 'GET' });
  return { status: data?.data?.status, raw: data };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;

  try {
    const expected = crypto.createHmac('sha256', getWebhookSecret()).update(rawBody).digest('hex');
    const provided = String(signatureHeader).trim();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (error) {
    console.error('Webhook signature verification error:', error.message);
    return false;
  }
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  getChapaMode,
};
