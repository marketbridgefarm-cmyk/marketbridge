
const CHAPA_MODE = String(process.env.CHAPA_MODE || 'test').toLowerCase();

const isLive = CHAPA_MODE === 'live';

const CHAPA_SECRET_KEY = isLive
  ? process.env.CHAPA_LIVE_SECRET_KEY
  : process.env.CHAPA_TEST_SECRET_KEY;

const CHAPA_PUBLIC_KEY = isLive
  ? process.env.CHAPA_LIVE_PUBLIC_KEY
  : process.env.CHAPA_TEST_PUBLIC_KEY;

const CHAPA_BASE_URL =
  process.env.CHAPA_BASE_URL || 'https://api.chapa.co';

const CHAPA_API_VERSION =
  process.env.CHAPA_API_VERSION || 'v1';

const CHAPA_API_URL =
  `${CHAPA_BASE_URL.replace(/\/$/, '')}/${CHAPA_API_VERSION}`;

function requireSecretKey() {
  if (!CHAPA_SECRET_KEY) {
    throw new Error(
      `Chapa ${isLive ? 'live' : 'test'} secret key is not configured`
    );
  }

  return CHAPA_SECRET_KEY;
}

function getHeaders() {
  return {
    Authorization: `Bearer ${requireSecretKey()}`,
    'Content-Type': 'application/json',
  };
}

function getChapaConfig() {
  return {
    mode: isLive ? 'live' : 'test',
    baseUrl: CHAPA_API_URL,
    publicKey: CHAPA_PUBLIC_KEY || null,
    secretKeyConfigured: Boolean(CHAPA_SECRET_KEY),
  };
}

async function chapaRequest(path, options = {}) {
  const url = `${CHAPA_API_URL}/${String(path).replace(/^\/+/, '')}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers || {}),
    },
  });

  let data;

  try {
    data = await response.json();
  } catch {
    data = {
      message: await response.text(),
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.error ||
      `Chapa request failed with HTTP ${response.status}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}

/**
 * Initialize a Chapa checkout/payment.
 *
 * NOTE:
 * The exact Chapa request fields supported for a particular
 * payment channel should be confirmed against the merchant
 * account/API version. The route layer should provide the
 * transaction-specific data.
 */
async function initializePayment(payload) {
  return chapaRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Verify a Chapa transaction by transaction/reference ID.
 */
async function verifyPayment(transactionId) {
  if (!transactionId) {
    throw new Error('Chapa transaction ID is required for verification');
  }

  return chapaRequest(
    `/transaction/verify/${encodeURIComponent(transactionId)}`,
    {
      method: 'GET',
    }
  );
}

module.exports = {
  CHAPA_MODE,
  CHAPA_BASE_URL,
  CHAPA_API_VERSION,
  CHAPA_API_URL,
  CHAPA_PUBLIC_KEY,

  isLive,

  getChapaConfig,
  chapaRequest,
  initializePayment,
  verifyPayment,
};
