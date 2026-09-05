
// Platform commission rates by payment type. These are placeholder defaults
// — adjust to your actual business terms. Expressed as a fraction of the
// payment amount (0.05 = 5%).
//
// ADVERTISING has no rate: the whole ad payment already IS platform
// revenue, there's no third party being paid out, so no split applies.
const COMMISSION_RATES = {
  MARKETPLACE: 0.05,  // agricultural produce and other product sales
  TRANSPORT: 0.10,    // hired-truck jobs only (never for OWN_TRUCK — the
                       // seller/buyer using their own truck owes the
                       // platform nothing, since no transporter was booked
                       // through it)
  INSPECTOR: 0.10,     // inspection fees
  DIGITAL: 0.15,       // digital product sales
  ADVERTISING: 0,
};

function commissionFor(type, amount) {
  const rate = COMMISSION_RATES[type] ?? 0;
  const commissionAmount = Math.round(Number(amount) * rate * 100) / 100;
  return { rate, commissionAmount };
}

module.exports = { COMMISSION_RATES, commissionFor };
