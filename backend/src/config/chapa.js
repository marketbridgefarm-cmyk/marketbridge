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

  const response = await fetch(
    `${CHAPA_BASE_URL}${endpoint}`,
    {
      ...options,

      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    }
  );

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
  verifyWebhookSignature,
};
