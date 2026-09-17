'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransitionOrder,
  assertOrderTransition,
  ORDER_TRANSITIONS,
  DISPUTABLE_STATUSES,
  transitionOrderStatus,
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

// Regression test: routes/disputes.js imports DISPUTABLE_STATUSES and
// (until fixed) a non-existent `transitionOrder` from this module. Because
// that TypeError only surfaces inside disputes.js's try/catch, it silently
// degraded into a generic 500 ("Could not create dispute") for every single
// dispute attempt, with nothing at require-time to catch it. These tests
// pin down both the export's existence and its content so that class of
// drift fails loudly again.
test('DISPUTABLE_STATUSES is exported and matches every status that can reach DISPUTED', () => {
  assert.ok(Array.isArray(DISPUTABLE_STATUSES));
  const expected = Object.keys(ORDER_TRANSITIONS).filter((status) => ORDER_TRANSITIONS[status].has('DISPUTED'));
  assert.deepEqual([...DISPUTABLE_STATUSES].sort(), expected.sort());
  // The statuses routes/disputes.js actually needs to allow a dispute from.
  for (const status of ['PENDING_PAYMENT', 'CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED']) {
    assert.ok(DISPUTABLE_STATUSES.includes(status), `${status} should be disputable`);
  }
  // Terminal/already-disputed statuses must not be disputable.
  for (const status of ['COMPLETED', 'CANCELLED', 'DISPUTED']) {
    assert.ok(!DISPUTABLE_STATUSES.includes(status), `${status} should not be disputable`);
  }
});

test('module does not export a transitionOrder function (routes must use transitionOrderStatus)', () => {
  const mod = require('../src/services/orderStateMachine');
  assert.equal(mod.transitionOrder, undefined);
  assert.equal(typeof transitionOrderStatus, 'function');
});

// Direct regression check for the disputes.js bug: statically pull the names
// destructured from `require('../services/orderStateMachine')` in
// routes/disputes.js and assert every one of them actually exists on the
// module. This is what would have caught it — the previous import
// (`transitionOrder`, a name the module never exported) only failed at
// request time, inside a try/catch that reported a generic 500.
test('routes/disputes.js only imports names that orderStateMachine actually exports', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/disputes.js'), 'utf8');
  const match = source.match(/require\(['"]\.\.\/services\/orderStateMachine['"]\)/);
  assert.ok(match, 'disputes.js should require ../services/orderStateMachine');
  const destructureMatch = source.match(/const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\.\/services\/orderStateMachine['"]\)/);
  assert.ok(destructureMatch, 'expected a destructured require of orderStateMachine');
  const importedNames = destructureMatch[1].split(',').map((n) => n.trim()).filter(Boolean);
  assert.ok(importedNames.length > 0);
  const mod = require('../src/services/orderStateMachine');
  for (const name of importedNames) {
    assert.notEqual(mod[name], undefined, `orderStateMachine does not export "${name}" but routes/disputes.js imports it`);
  }
});
