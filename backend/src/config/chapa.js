// Chapa (chapa.co) payment gateway client.
//
// MarketBridge uses Chapa for payment checkout and verification.
// Keep this module small and provider-focused; business/payment settlement
// belongs in backend/src/routes/payments.js / payment service.

const crypto = require('crypto');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';
const TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;

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
  if (!key) return 'unconfigured';
  return key.startsWith('CHASECK_TEST-') ? 'test' : 'live';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function chapaFetch(path, options = {}, retries = DEFAULT_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${CHAPA_BASE_URL}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${getSecretKey()}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const error = Object.assign(
          new Error(data?.message || `Chapa request failed (${response.status})`),
          {
            status: response.status,
            chapaResponse: data,
            retryable: response.status >= 500 || response.status === 429,
          },
        );

        if (error.retryable && attempt < retries) {
          lastError = error;
          await sleep(1000 * (attempt + 1));
          continue;
        }

        throw error;
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        lastError = Object.assign(new Error('Chapa request timed out'), {
          status: 504,
          retryable: true,
        });
      } else {
        lastError = error;
      }

      const retryableNetworkError = !error.status;
      const retryable = error.retryable || retryableNetworkError;

      if (retryable && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Chapa request failed');
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
  if (!txRef) throw Object.assign(new Error('txRef is required'), { status: 400 });
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw Object.assign(new Error('amount must be greater than zero'), { status: 400 });
  }
  if (!callbackUrl) throw Object.assign(new Error('callbackUrl is required'), { status: 400 });
  if (!returnUrl) throw Object.assign(new Error('returnUrl is required'), { status: 400 });

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
  if (!checkoutUrl) {
    throw Object.assign(new Error('Chapa did not return a checkout URL'), {
      status: 502,
      chapaResponse: data,
    });
  }

  return { checkoutUrl, raw: data };
}

async function verifyTransaction(txRef) {
  if (!txRef) throw Object.assign(new Error('txRef is required'), { status: 400 });

  const data = await chapaFetch(
    `/transaction/verify/${encodeURIComponent(txRef)}`,
    { method: 'GET' },
  );

  return {
    status: data?.data?.status,
    raw: data,
  };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  try {
    const raw = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(String(rawBody ?? ''), 'utf8');

    const expected = crypto
      .createHmac('sha256', getWebhookSecret())
      .update(raw)
      .digest('hex');

    const supplied = String(signatureHeader).trim();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(supplied, 'utf8');

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
