const CHAPA_MODE = String(process.env.CHAPA_MODE || 'test').toLowerCase();

if (!['test', 'live'].includes(CHAPA_MODE)) {
  throw new Error('CHAPA_MODE must be either "test" or "live"');
}

const isLive = CHAPA_MODE === 'live';

const CHAPA_SECRET_KEY = isLive
  ? process.env.CHAPA_LIVE_SECRET_KEY
  : process.env.CHAPA_TEST_SECRET_KEY;

const CHAPA_PUBLIC_KEY = isLive
  ? process.env.CHAPA_LIVE_PUBLIC_KEY
  : process.env.CHAPA_TEST_PUBLIC_KEY;

const CHAPA_ENCRYPTION_KEY = isLive
  ? process.env.CHAPA_LIVE_ENCRYPTION_KEY
  : process.env.CHAPA_TEST_ENCRYPTION_KEY;

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

function getHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${requireSecretKey()}`,
    ...extra,
  };
}

function getChapaConfig() {
  return {
    mode: isLive ? 'live' : 'test',
    baseUrl: CHAPA_API_URL,
    publicKey: CHAPA_PUBLIC_KEY || null,
    encryptionKeyConfigured: Boolean(CHAPA_ENCRYPTION_KEY),
    secretKeyConfigured: Boolean(CHAPA_SECRET_KEY),
  };
}

/**
 * Convert a JavaScript object into multipart/form-data.
 *
 * Node 20 provides FormData natively, so no additional
 * multipart package is required.
 */
function createFormData(fields = {}) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.append(key, String(value));
    }
  }

  return form;
}

/**
 * Chapa Direct Charge.
 *
 * Supported MarketBridge methods:
 *
 * TELEBIRR -> telebirr
 * CBE      -> cbebirr
 *
 * Chapa's Direct Charge API expects multipart/form-data.
 */
async function directCharge({
  type,
  amount,
  mobile,
  txRef,
  currency = 'ETB',
}) {
  if (!['telebirr', 'cbebirr'].includes(type)) {
    throw new Error(
      'Unsupported Chapa Direct Charge type. Use telebirr or cbebirr.'
    );
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error('A valid payment amount is required');
  }

  if (!mobile) {
    throw new Error('Customer mobile number is required');
  }

  if (!txRef) {
    throw new Error('Transaction reference is required');
  }

  const form = createFormData({
    amount,
    currency,
    tx_ref: txRef,
    mobile,
  });

  const response = await fetch(
    `${CHAPA_API_URL}/charges?type=${encodeURIComponent(type)}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: form,
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
        data?.error ||
        `Chapa Direct Charge failed with HTTP ${response.status}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}

/**
 * Verify a Chapa transaction.
 *
 * Chapa verification uses the merchant transaction reference.
 */
async function verifyPayment(txRef) {
  if (!txRef) {
    throw new Error(
      'Transaction reference is required for Chapa verification'
    );
  }

  const response = await fetch(
    `${CHAPA_API_URL}/transaction/verify/${encodeURIComponent(txRef)}`,
    {
      method: 'GET',
      headers: getHeaders({
        Accept: 'application/json',
      }),
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
        data?.error ||
        `Chapa verification failed with HTTP ${response.status}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}

/**
 * Map MarketBridge payment methods to Chapa Direct Charge methods.
 */
function chapaPaymentType(method) {
  switch (String(method || '').toUpperCase()) {
    case 'TELEBIRR':
      return 'telebirr';

    case 'CBE':
      return 'cbebirr';

    default:
      return null;
  }
}

/**
 * Extract the transaction/reference value from
 * different possible Chapa response structures.
 */
function extractChapaReference(data) {
  return (
    data?.data?.tx_ref ||
    data?.data?.reference ||
    data?.tx_ref ||
    data?.reference ||
    data?.data?.transaction_reference ||
    null
  );
}

/**
 * Determine whether a Chapa response represents
 * a successful initialization.
 *
 * IMPORTANT:
 * Initialization is NOT the same thing as payment confirmation.
 */
function isChargeInitialized(data) {
  const status = String(
    data?.status ||
      data?.data?.status ||
      ''
  ).toLowerCase();

  return (
    status === 'success' ||
    status === 'pending' ||
    Boolean(data?.data)
  );
}

module.exports = {
  CHAPA_MODE,
  CHAPA_BASE_URL,
  CHAPA_API_VERSION,
  CHAPA_API_URL,
  CHAPA_PUBLIC_KEY,
  CHAPA_ENCRYPTION_KEY,
  isLive,

  getChapaConfig,
  directCharge,
  verifyPayment,
  chapaPaymentType,
  extractChapaReference,
  isChargeInitialized,
};
