'use strict';

const crypto = require('crypto');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

// ============================================================================
// SECRET KEY
// ============================================================================

function getSecretKey() {
  const key = process.env.CHAPA_SECRET_KEY;

  if (!key) {
    throw Object.assign(
      new Error('CHAPA_SECRET_KEY is not configured'),
      { status: 500 }
    );
  }

  return key;
}

// ============================================================================
// API REQUEST
// ============================================================================

async function chapaRequest(endpoint, options = {}) {
  const secretKey = getSecretKey();

  const timeoutMs = Math.max(1000, Number(process.env.CHAPA_API_TIMEOUT_MS || 15000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(
      `${CHAPA_BASE_URL}${endpoint}`,
      {
        ...options,
        signal: options.signal || controller.signal,

        headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
        },
      }
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Chapa request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'CHAPA_REQUEST_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.error ||
      `Chapa request failed with HTTP ${response.status}`
    );

    error.status = response.status;
    error.chapa = data;

    throw error;
  }

  return data;
}

// ============================================================================
// INITIALIZE TRANSACTION
// ============================================================================

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
  if (!txRef) {
    throw Object.assign(
      new Error('Chapa txRef is required'),
      { status: 400 }
    );
  }

  if (
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0
  ) {
    throw Object.assign(
      new Error('Invalid Chapa amount'),
      { status: 400 }
    );
  }

  if (!email) {
    throw Object.assign(
      new Error('Customer email is required for Chapa checkout'),
      { status: 400 }
    );
  }

  if (!callbackUrl) {
    throw Object.assign(
      new Error('Chapa callback URL is required'),
      { status: 400 }
    );
  }

  if (!returnUrl) {
    throw Object.assign(
      new Error('Chapa return URL is required'),
      { status: 400 }
    );
  }

  const payload = {
    amount: Number(amount).toFixed(2),

    currency,

    email,

    first_name: firstName || 'MarketBridge',

    last_name: lastName || 'User',

    tx_ref: String(txRef),

    callback_url: callbackUrl,

    return_url: returnUrl,

    customization: {
      title: title || 'MarketBridge',

      description:
        description || 'MarketBridge payment',
    },
  };

  if (phoneNumber) {
    payload.phone_number = phoneNumber;
  }

  const result = await chapaRequest(
    '/transaction/initialize',
    {
      method: 'POST',

      body: JSON.stringify(payload),
    }
  );

  const checkoutUrl =
    result?.data?.checkout_url;

  if (!checkoutUrl) {
    const error = new Error(
      'Chapa did not return a checkout URL'
    );

    error.status = 502;
    error.chapa = result;

    throw error;
  }

  return {
    checkoutUrl,
    raw: result,
  };
}

// ============================================================================
// VERIFY TRANSACTION
// ============================================================================

async function verifyTransaction(txRef) {
  if (!txRef) {
    throw Object.assign(
      new Error('Transaction reference is required'),
      { status: 400 }
    );
  }

  const result = await chapaRequest(
    `/transaction/verify/${encodeURIComponent(String(txRef))}`,
    {
      method: 'GET',
    }
  );

  const status = String(
    result?.data?.status ||
    result?.status ||
    ''
  ).toLowerCase();

  let normalizedStatus = 'pending';

  if (
    status === 'success' ||
    status === 'successful'
  ) {
    normalizedStatus = 'success';
  } else if (
    status === 'failed' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'canceled'
  ) {
    normalizedStatus = 'failed';
  }

  return {
    status: normalizedStatus,
    raw: result,
  };
}


// ============================================================================
// REFUND
// ============================================================================

/**
 * Submit a refund against the original Chapa transaction reference.
 * Chapa v1 expects form-urlencoded data for this endpoint.
 * The refund is asynchronous; a successful submission is therefore not the
 * same thing as a completed refund. Call verifyRefund() afterwards/webhook.
 */
async function refundTransaction({ txRef, amount, reason, reference, meta }) {
  if (!txRef) {
    throw Object.assign(new Error('Original Chapa tx_ref is required for refund'), { status: 400, code: 'CHAPA_REFUND_TX_REF_REQUIRED' });
  }

  if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    throw Object.assign(new Error('Invalid Chapa refund amount'), { status: 400, code: 'CHAPA_REFUND_AMOUNT_INVALID' });
  }

  const params = new URLSearchParams();
  if (reason) params.set('reason', String(reason));
  if (amount !== undefined) params.set('amount', Number(amount).toFixed(2));
  if (reference) params.set('reference', String(reference));

  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== null) params.set(`meta[${key}]`, String(value));
    }
  }

  const result = await chapaRequest(
    `/refund/${encodeURIComponent(String(txRef))}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  const refId = result?.data?.ref_id || result?.data?.reference || result?.ref_id;
  if (!refId) {
    const error = new Error('Chapa accepted the refund request without returning a refund reference');
    error.status = 502;
    error.code = 'CHAPA_REFUND_REFERENCE_MISSING';
    error.chapa = result;
    throw error;
  }

  return {
    refId: String(refId),
    status: String(result?.data?.status || result?.status || 'initiated').toLowerCase(),
    raw: result,
  };
}

/** Verify the asynchronous state of a Chapa refund. */
async function verifyRefund(refId) {
  if (!refId) {
    throw Object.assign(new Error('Chapa refund reference is required'), { status: 400, code: 'CHAPA_REFUND_REFERENCE_REQUIRED' });
  }

  const result = await chapaRequest(
    `/refund/${encodeURIComponent(String(refId))}/verify`,
    { method: 'GET' }
  );

  const status = String(result?.data?.status || result?.status || '').toLowerCase();
  let normalizedStatus = 'pending';
  if (status === 'refunded') normalizedStatus = 'refunded';
  else if (status === 'reversed' || status === 'failed' || status === 'cancelled' || status === 'canceled') normalizedStatus = 'reversed';
  else if (status === 'initiated' || status === 'processing') normalizedStatus = 'processing';

  return { status: normalizedStatus, raw: result };
}

// ============================================================================
// WEBHOOK SIGNATURE
// ============================================================================

function hmacHex(secret, data) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('hex');
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a || '').trim(), 'utf8');
  const bBuf = Buffer.from(String(b || '').trim(), 'utf8');

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Chapa sends two different headers, computed two different ways:
// - "chapa-signature":   HMAC-SHA256(secret, secret)   -- signs the secret itself
// - "x-chapa-signature": HMAC-SHA256(secret, payload)  -- signs the raw request body
// Either header matching is sufficient (per Chapa's docs).
function verifyWebhookSignature(
  rawBody,
  headers
) {
  const secret =
    process.env.CHAPA_WEBHOOK_SECRET;

  if (!secret || !rawBody || !headers) {
    return false;
  }

  const payloadSig = headers['x-chapa-signature'];
  const secretSig = headers['chapa-signature'];

  if (payloadSig) {
    const expected = hmacHex(secret, rawBody);
    if (safeCompare(expected, payloadSig)) {
      return true;
    }
  }

  if (secretSig) {
    const expected = hmacHex(secret, secret);
    if (safeCompare(expected, secretSig)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeTransaction,
  verifyTransaction,
  refundTransaction,
  verifyRefund,
  verifyWebhookSignature,
};
