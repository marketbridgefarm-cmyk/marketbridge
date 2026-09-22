'use strict';

const chapa = require('../config/chapa');

/**
 * Provider adapter boundary.
 *
 * Chapa currently supplies the hosted checkout used by MarketBridge. Direct
 * Telebirr/CBE credentials and API contracts are intentionally not guessed:
 * they must be supplied by the merchant/provider before enabling a direct
 * adapter. This prevents a fake "successful" integration from handling real
 * money.
 */
function normalizeProvider(method) {
  const value = String(method || '').toUpperCase();
  if (value === 'TELEBIRR') return 'CHAPA_TELEBIRR';
  if (value === 'CBE') return 'CBE';
  if (value === 'QR') return 'CHAPA';
  return 'OTHER';
}

function getAdapter(method) {
  const provider = normalizeProvider(method);

  if (provider === 'CHAPA_TELEBIRR' || provider === 'CHAPA') {
    return {
      provider,
      initialize: chapa.initializeTransaction,
      verify: chapa.verifyTransaction,
      refund: chapa.refundTransaction,
      verifyRefund: chapa.verifyRefund,
      verifyWebhookSignature: chapa.verifyWebhookSignature,
    };
  }

  if (provider === 'CBE') {
    return {
      provider,
      initialize() {
        throw Object.assign(
          new Error('Direct CBE payment adapter is not enabled. Configure the approved CBE API contract and credentials first.'),
          { status: 503, code: 'CBE_ADAPTER_NOT_CONFIGURED' }
        );
      },
      verify() {
        throw Object.assign(
          new Error('Direct CBE verification is not enabled. Configure the approved CBE API contract and credentials first.'),
          { status: 503, code: 'CBE_ADAPTER_NOT_CONFIGURED' }
        );
      },
    };
  }

  return {
    provider,
    initialize() {
      throw Object.assign(new Error(`No payment adapter configured for method ${method}`), { status: 503, code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
    },
    verify() {
      throw Object.assign(new Error(`No payment adapter configured for method ${method}`), { status: 503, code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
    },
  };
}

module.exports = { normalizeProvider, getAdapter };
