'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransition, assertTransition } = require('../src/services/paymentStateMachine');

test('payment state machine permits the normal payment lifecycle', () => {
  assert.equal(canTransition('PENDING', 'PROCESSING'), true);
  assert.equal(canTransition('PROCESSING', 'PAID'), true);
  assert.equal(canTransition('PAID', 'REFUND_PENDING'), true);
  assert.equal(canTransition('REFUND_PENDING', 'REFUNDED'), true);
});

test('payment state machine rejects backward or skipped transitions', () => {
  assert.equal(canTransition('PAID', 'PENDING'), false);
  assert.equal(canTransition('REFUNDED', 'PAID'), false);
  assert.throws(() => assertTransition('PENDING', 'REFUNDED'), /Invalid payment state transition/);
  assert.throws(() => assertTransition('REFUNDED', 'PAID'), /Invalid payment state transition/);
});
