'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransitionOrder,
  assertOrderTransition,
  ORDER_TRANSITIONS,
} = require('../src/services/orderStateMachine');

test('allows the canonical order lifecycle', () => {
  const valid = [
    ['PENDING_PAYMENT', 'CONFIRMED'],
    ['CONFIRMED', 'TRANSPORT_ARRANGED'],
    ['TRANSPORT_ARRANGED', 'DELIVERED'],
    ['DELIVERED', 'COMPLETED'],
  ];
  for (const [from, to] of valid) {
    assert.equal(canTransitionOrder(from, to), true);
    assert.doesNotThrow(() => assertOrderTransition(from, to));
  }
});

test('rejects backward and impossible transitions', () => {
  const invalid = [
    ['COMPLETED', 'CONFIRMED'],
    ['DELIVERED', 'CONFIRMED'],
    ['PENDING_PAYMENT', 'DELIVERED'],
    ['CONFIRMED', 'COMPLETED'],
    ['CANCELLED', 'CONFIRMED'],
  ];
  for (const [from, to] of invalid) {
    assert.equal(canTransitionOrder(from, to), false);
    assert.throws(
      () => assertOrderTransition(from, to),
      (error) => error.code === 'INVALID_ORDER_TRANSITION' && error.status === 409
    );
  }
});

test('transition map is immutable at the object level', () => {
  assert.ok(ORDER_TRANSITIONS.PENDING_PAYMENT.has('CONFIRMED'));
  assert.equal(ORDER_TRANSITIONS.COMPLETED.size, 0);
});
