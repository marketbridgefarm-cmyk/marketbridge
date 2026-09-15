'use strict';

// Explicit payment lifecycle. Provider notifications must never be able to
// move money backwards or skip the refund lifecycle.
const TRANSITIONS = Object.freeze({
  PENDING: new Set(['PROCESSING', 'FAILED', 'RECONCILIATION_REQUIRED']),
  PROCESSING: new Set(['PAID', 'FAILED', 'RECONCILIATION_REQUIRED']),
  PAID: new Set(['REFUND_PENDING', 'RECONCILIATION_REQUIRED']),
  RECONCILIATION_REQUIRED: new Set(['PROCESSING', 'PAID', 'FAILED']),
  REFUND_PENDING: new Set(['REFUNDED', 'PAID', 'RECONCILIATION_REQUIRED']),
  FAILED: new Set(),
  REFUNDED: new Set(),
});

function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].has(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw Object.assign(
      new Error(`Invalid payment state transition: ${from} -> ${to}`),
      { status: 409, code: 'INVALID_PAYMENT_STATE_TRANSITION' }
    );
  }
}

module.exports = { TRANSITIONS, canTransition, assertTransition };
