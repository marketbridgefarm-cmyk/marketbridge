'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitAmount,
  splitInto,
  isInstallmentParent,
  ensureInstallmentChildren,
  finalizeInstallmentPlan,
  markParentRefundedIfComplete,
  MAX_INSTALLMENTS,
} = require('../src/services/installmentService');

const sum = (parts) => Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;

test('splitAmount uses the fewest installments, each within the limit', () => {
  assert.deepEqual(splitAmount(2100000, 1000000), [700000, 700000, 700000]);
  assert.deepEqual(splitAmount(1000000, 1000000), [1000000]);
  assert.deepEqual(splitAmount(1000000.01, 1000000), [500000.01, 500000]);
});

test('splitAmount parts always sum exactly to the total', () => {
  for (const total of [2100000, 2500000.5, 3333333.33, 1000000.01, 9999999.99]) {
    const parts = splitAmount(total, 1000000);
    assert.equal(sum(parts), total);
    assert.ok(parts.every((p) => p <= 1000000));
  }
});

test('splitAmount rejects invalid input and plans that are too large', () => {
  assert.throws(() => splitAmount(0, 1000000), /Invalid amount/);
  assert.throws(() => splitAmount(100, 0), /Invalid installment limit/);
  assert.throws(
    () => splitAmount(MAX_INSTALLMENTS * 1000000 + 1, 1000000),
    (error) => error.code === 'TOO_MANY_INSTALLMENTS'
  );
});

test('splitInto spreads spare cents over the first installments', () => {
  assert.deepEqual(splitInto(10, 3), [3.34, 3.33, 3.33]);
});

test('isInstallmentParent only matches payments with an installment count', () => {
  assert.equal(isInstallmentParent({ installmentCount: 3 }), true);
  assert.equal(isInstallmentParent({ installmentCount: null }), false);
  assert.equal(isInstallmentParent(null), false);
});

function paymentDb(initial) {
  const rows = [...initial];
  return {
    rows,
    payment: {
      findMany: async ({ where }) =>
        rows
          .filter((r) => r.parentPaymentId === where.parentPaymentId)
          .sort((a, b) => a.installmentSequence - b.installmentSequence),
      createMany: async ({ data }) => {
        data.forEach((d, i) => rows.push({ id: `child-${i + 1}`, ...d }));
        return { count: data.length };
      },
    },
  };
}

test('ensureInstallmentChildren creates the children once and is idempotent', async () => {
  const parent = {
    id: 'parent', orderId: 'o1', createdById: 'u1', amount: 2100000,
    currency: 'ETB', method: 'TELEBIRR', installmentCount: 3,
  };
  const db = paymentDb([]);

  const first = await ensureInstallmentChildren(parent, 1000000, { db });
  assert.equal(first.length, 3);
  assert.equal(sum(first.map((c) => c.amount)), 2100000);
  assert.ok(first.every((c) => c.type === 'MARKETPLACE_INSTALLMENT'));
  assert.ok(first.every((c) => c.commissionAmount === 0));
  assert.deepEqual(first.map((c) => c.installmentSequence), [1, 2, 3]);

  const again = await ensureInstallmentChildren(parent, 1000000, { db });
  assert.equal(again.length, 3);
  assert.equal(db.rows.length, 3);
});

test('ensureInstallmentChildren keeps the recorded count if the limit later changes', async () => {
  const parent = {
    id: 'parent', orderId: 'o1', createdById: 'u1', amount: 2100000,
    currency: 'ETB', method: 'QR', installmentCount: 3,
  };
  const db = paymentDb([]);
  const children = await ensureInstallmentChildren(parent, 5000000, { db });
  assert.equal(children.length, 3);
});

function planDb(parent) {
  return { payment: { findUnique: async () => parent } };
}

test('finalizeInstallmentPlan does not settle until every installment is PAID', async () => {
  let settled = 0;
  const parent = {
    id: 'p', status: 'PENDING', installmentCount: 3, amount: 300, currency: 'ETB',
    installments: [{ id: 'a', status: 'PAID', installmentSequence: 1 }, { id: 'b', status: 'PAID', installmentSequence: 2 }, { id: 'c', status: 'PROCESSING', installmentSequence: 3 }],
  };
  const result = await finalizeInstallmentPlan('p', {
    db: planDb(parent),
    settle: async () => { settled += 1; },
  });
  assert.equal(settled, 0);
  assert.equal(result.status, 'PENDING');
});

test('finalizeInstallmentPlan does not settle when installments are missing', async () => {
  let settled = 0;
  const parent = {
    id: 'p', status: 'PENDING', installmentCount: 3, amount: 300,
    installments: [{ id: 'a', status: 'PAID', installmentSequence: 1 }, { id: 'b', status: 'PAID', installmentSequence: 2 }],
  };
  await finalizeInstallmentPlan('p', {
    db: planDb(parent),
    settle: async () => { settled += 1; },
  });
  assert.equal(settled, 0);
});

test('finalizeInstallmentPlan settles the parent once, for the full amount, when all are PAID', async () => {
  const calls = [];
  const parent = {
    id: 'p', status: 'PENDING', installmentCount: 2, amount: 2100000, currency: 'ETB',
    installments: [{ id: 'a', status: 'PAID', installmentSequence: 1 }, { id: 'b', status: 'PAID', installmentSequence: 2 }],
  };
  await finalizeInstallmentPlan('p', {
    db: planDb(parent),
    settle: async (args) => { calls.push(args); return { id: 'p', status: 'PAID' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paymentId, 'p');
  assert.equal(calls[0].status, 'PAID');
  assert.equal(calls[0].payload.amount, 2100000);
  assert.equal(calls[0].eventId, 'installments-complete:p');
});

test('finalizeInstallmentPlan leaves settled, refunded and failed parents alone', async () => {
  for (const status of ['PAID', 'REFUND_PENDING', 'REFUNDED', 'FAILED']) {
    let settled = 0;
    const parent = {
      id: 'p', status, installmentCount: 1, amount: 10,
      installments: [{ id: 'a', status: 'PAID' }],
    };
    await finalizeInstallmentPlan('p', {
      db: planDb(parent),
      settle: async () => { settled += 1; },
    });
    assert.equal(settled, 0, status);
  }
});

test('finalizeInstallmentPlan ignores payments that are not installment plans', async () => {
  const result = await finalizeInstallmentPlan('p', {
    db: planDb({ id: 'p', status: 'PENDING', installmentCount: null }),
    settle: async () => { throw new Error('must not settle'); },
  });
  assert.equal(result, null);
});

function refundTx(parent) {
  const log = { updates: [], obligation: [] };
  return {
    log,
    payment: {
      findUnique: async () => parent,
      update: async ({ data }) => { log.updates.push(data); return { ...parent, ...data }; },
    },
    paymentObligation: { update: async ({ data }) => { log.obligation.push(data); } },
  };
}

test('parent is refunded only after the last paid installment is refunded', async () => {
  const held = refundTx({
    id: 'p', status: 'REFUND_PENDING', installmentCount: 2, obligationId: 'ob',
    installments: [{ status: 'REFUNDED' }, { status: 'REFUND_PENDING' }],
  });
  await markParentRefundedIfComplete(held, 'p');
  assert.equal(held.log.updates.length, 0);

  const done = refundTx({
    id: 'p', status: 'REFUND_PENDING', installmentCount: 2, obligationId: 'ob',
    installments: [{ status: 'REFUNDED' }, { status: 'FAILED' }],
  });
  await markParentRefundedIfComplete(done, 'p');
  assert.deepEqual(done.log.updates, [{ status: 'REFUNDED' }]);
  assert.deepEqual(done.log.obligation, [{ status: 'CANCELLED' }]);
});

test('parent that is not awaiting a refund is not touched', async () => {
  const tx = refundTx({
    id: 'p', status: 'PAID', installmentCount: 1, installments: [{ status: 'REFUNDED' }],
  });
  await markParentRefundedIfComplete(tx, 'p');
  assert.equal(tx.log.updates.length, 0);
});

test('finalizeInstallmentPlan ignores replaced (sequence-less) failed attempts', async () => {
  const calls = [];
  const parent = {
    id: 'p', status: 'PENDING', installmentCount: 2, amount: 200, currency: 'ETB',
    installments: [
      { id: 'a', status: 'PAID', installmentSequence: 1 },
      { id: 'b-old', status: 'FAILED', installmentSequence: null },
      { id: 'b-new', status: 'PAID', installmentSequence: 2 },
    ],
  };
  await finalizeInstallmentPlan('p', {
    db: planDb(parent),
    settle: async (args) => { calls.push(args); return { id: 'p', status: 'PAID' }; },
  });
  assert.equal(calls.length, 1);
});

function retryDb({ failed, order = { status: 'CONFIRMED' } }) {
  const log = { updates: [], created: [] };
  const tx = {
    payment: {
      findUnique: async () => failed,
      update: async ({ data }) => { log.updates.push(data); },
      create: async ({ data }) => { log.created.push(data); return { id: 'new', ...data }; },
    },
    order: { findUnique: async () => order },
  };
  return { log, db: { $transaction: async (fn) => fn(tx) } };
}

const failedChild = (overrides = {}) => ({
  id: 'c1', type: 'MARKETPLACE_INSTALLMENT', status: 'FAILED', createdById: 'buyer',
  orderId: 'o1', parentPaymentId: 'p', installmentSequence: 2, amount: 700000,
  currency: 'ETB', method: 'TELEBIRR', reference: null,
  parentPayment: { id: 'p', status: 'PENDING' },
  ...overrides,
});

test('replaceFailedInstallment gives the failed attempt up its sequence and creates a fresh one', async () => {
  const { replaceFailedInstallment } = require('../src/services/installmentService');
  const { db, log } = retryDb({ failed: failedChild() });
  const created = await replaceFailedInstallment('c1', 'buyer', { db });
  assert.deepEqual(log.updates, [{ installmentSequence: null }]);
  assert.equal(created.installmentSequence, 2);
  assert.equal(created.amount, 700000);
  assert.equal(created.status, 'PENDING');
  assert.equal(created.commissionAmount, 0);
});

test('replaceFailedInstallment refuses other users, non-failed, replaced and closed plans', async () => {
  const { replaceFailedInstallment } = require('../src/services/installmentService');
  const cases = [
    [failedChild(), 'someone-else', 403],
    [failedChild({ status: 'PENDING' }), 'buyer', 409],
    [failedChild({ installmentSequence: null }), 'buyer', 409],
    [failedChild({ parentPayment: { id: 'p', status: 'PAID' } }), 'buyer', 409],
    [failedChild({ parentPayment: null }), 'buyer', 404],
  ];
  for (const [failed, user, status] of cases) {
    const { db, log } = retryDb({ failed });
    await assert.rejects(
      () => replaceFailedInstallment('c1', user, { db }),
      (error) => error.status === status
    );
    assert.equal(log.created.length, 0);
  }
});

test('replaceFailedInstallment refuses when the order is cancelled', async () => {
  const { replaceFailedInstallment } = require('../src/services/installmentService');
  const { db } = retryDb({ failed: failedChild(), order: { status: 'CANCELLED' } });
  await assert.rejects(
    () => replaceFailedInstallment('c1', 'buyer', { db }),
    (error) => error.code === 'ORDER_NOT_PAYABLE'
  );
});
