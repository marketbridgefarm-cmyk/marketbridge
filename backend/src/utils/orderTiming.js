'use strict';

const DEFAULT_TIMEOUT_HOURS = 48;

/**
 * How long a buyer has to pay before an order is automatically cancelled
 * and its provisional order released back to the listing queue. Inventory is
 * committed only when goods payment settles. Configurable via
 * ORDER_PAYMENT_TIMEOUT_HOURS so Alex can tune it without a code change
 * (e.g. shorter for fast-moving produce, longer if bank/Telebirr transfers
 * commonly take a day or two to clear).
 */
function paymentTimeoutHours() {
  const configured = Number(process.env.ORDER_PAYMENT_TIMEOUT_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_HOURS;
}

function computePaymentDueAt(from = new Date()) {
  return new Date(from.getTime() + paymentTimeoutHours() * 60 * 60 * 1000);
}

module.exports = { paymentTimeoutHours, computePaymentDueAt };
