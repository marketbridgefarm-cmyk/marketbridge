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
 * Chapa Direct Charge
 *
 * Supported payment types currently used by MarketBridge:
 *
 *   TELEBIRR -> telebirr
 *   CBE      -> cbebirr
 *
 * Chapa expects this request as multipart/form-data.
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

  const form = new URLSearchParams();

  form.append('amount', String(amount));
  form.append('currency', currency);
  form.append('tx_ref', txRef);
  form.append('mobile', String(mobile));

  const response = await fetch(
    `${CHAPA_API_URL}/charges?type=${encodeURIComponent(type)}`,
    {
      method: 'POST',
      headers: getHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      body: form.toString(),
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
 * Normalize the MarketBridge payment method
 * to Chapa's Direct Charge method.
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
};
