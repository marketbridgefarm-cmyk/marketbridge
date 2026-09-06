// Platform commission rates by payment type.
// These are configurable via environment variables for flexibility.
//
// Default rates:
// MARKETPLACE: 5% (agricultural produce and other product sales)
// TRANSPORT: 10% (hired-truck jobs only, NEVER for OWN_TRUCK)
// INSPECTOR: 10% (inspection fees)
// DIGITAL: 15% (digital product sales)
// ADVERTISING: 0% (whole ad payment IS platform revenue)

function getEnvRate(type, defaultRate) {
  const envKey = {
    MARKETPLACE: 'MARKETPLACE_COMMISSION_RATE',
    TRANSPORT: 'TRANSPORT_COMMISSION_RATE',
    INSPECTOR: 'INSPECTION_COMMISSION_RATE',
    DIGITAL: 'DIGITAL_COMMISSION_RATE',
    ADVERTISING: 'ADVERTISING_COMMISSION_RATE',
  }[type];

  if (!envKey) return defaultRate;

  const value = Number(process.env[envKey]);

  // Validate: must be between 0 and 100
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.warn(`Invalid commission rate for ${type}: ${value}. Using default ${defaultRate}`);
    return defaultRate;
  }

  // Convert percentage to fraction
  return value / 100;
}

const COMMISSION_RATES = {
  MARKETPLACE: getEnvRate('MARKETPLACE', 0.05),
  TRANSPORT: getEnvRate('TRANSPORT', 0.10),
  INSPECTOR: getEnvRate('INSPECTOR', 0.10),
  DIGITAL: getEnvRate('DIGITAL', 0.15),
  ADVERTISING: getEnvRate('ADVERTISING', 0),
};

function commissionFor(type, amount) {
  const rate = COMMISSION_RATES[type] ?? 0;

  // Validate amount
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { rate: 0, commissionAmount: 0 };
  }

  // Calculate with proper rounding (2 decimal places)
  const commissionAmount = Math.round(numericAmount * rate * 100) / 100;

  return { rate, commissionAmount };
}

// Calculate net amount (amount minus commission)
function netFor(type, amount) {
  const { rate, commissionAmount } = commissionFor(type, amount);
  const netAmount = Math.round((Number(amount) - commissionAmount) * 100) / 100;
  return { rate, commissionAmount, netAmount };
}

// Get all commission rates (for admin display)
function getAllRates() {
  return { ...COMMISSION_RATES };
}

module.exports = { COMMISSION_RATES, commissionFor, netFor, getAllRates };
