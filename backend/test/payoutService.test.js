'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/payoutService');

function auditStub() {
  return {
    auditEvent: {
      create: async ({ data }) => ({ id: 'audit-1', ...data }),
    },
  };
}

test('payout hold defaults to 3 days', () => {
  const previous = process.env.SELLER_PAYOUT_HOLD_DAYS;
  delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  assert.equal(service.holdDays(), 3);
  if (previous === undefined) delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  else process.env.SELLER_PAYOUT_HOLD_DAYS = previous;
});

test('payout hold respects configured hold days', () => {
  const previous = process.env.SELLER_PAYOUT_HOLD_DAYS;
  process.env.SELLER_PAYOUT_HOLD_DAYS = '5';
  assert.equal(service.holdDays(), 5);
  if (previous === undefined) delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  else process.env.SELLER_PAYOUT_HOLD_DAYS = previous;
});

test('createPayoutHold is idempotent and starts a HELD record for a seller', async () => {
  const existing = null;
  let created;
  const tx = {
    ...auditStub(),
    payout: {
      findUnique: async () => existing,
      create: async ({ data }) => {
        created = data;
        return { id: 'payout-1', ...data };
      },
    },
  };

  const result = await service.createPayoutHold(tx, {
    orderId: 'order-1',
    payeeRole: 'SELLER',
    payeeId: 'seller-1',
    payment: { id: 'payment-1', netAmount: 525, amount: 550, currency: 'ETB' },
  });

  assert.equal(result.status, 'HELD');
  assert.equal(created.amount, 525);
  assert.equal(created.currency, 'ETB');
  assert.equal(created.orderId, 'order-1');
  assert.equal(created.payeeRole, 'SELLER');
  assert.equal(created.payeeId, 'seller-1');
  assert.ok(created.releaseAt instanceof Date);
});

test('createPayoutHold works for a hired transporter', async () => {
  let created;
  const tx = {
    ...auditStub(),
    payout: {
      findUnique: async () => null,
      create: async ({ data }) => {
        created = data;
        return { id: 'payout-2', ...data };
      },
    },
  };

  const result = await service.createPayoutHold(tx, {
    orderId: 'order-2',
    payeeRole: 'TRANSPORTER',
    payeeId: 'truck-owner-1',
    payment: { id: 'payment-2', netAmount: 300, amount: 320, currency: 'ETB' },
  });

  assert.equal(result.status, 'HELD');
  assert.equal(created.payeeRole, 'TRANSPORTER');
  assert.equal(created.payeeId, 'truck-owner-1');
});

test('createPayoutHold works for an inspector with no order yet', async () => {
  let created;
  const tx = {
    ...auditStub(),
    payout: {
      findUnique: async () => null,
      create: async ({ data }) => {
        created = data;
        return { id: 'payout-3', ...data };
      },
    },
  };

  const result = await service.createPayoutHold(tx, {
    orderId: null,
    payeeRole: 'INSPECTOR',
    payeeId: 'inspector-1',
    payment: { id: 'payment-3', netAmount: 100, amount: 100, currency: 'ETB' },
  });

  assert.equal(result.status, 'HELD');
  assert.equal(created.orderId, null);
  assert.equal(created.payeeRole, 'INSPECTOR');
  assert.equal(created.payeeId, 'inspector-1');
});

test('createPayoutHold is a no-op without a payee', async () => {
  const tx = { ...auditStub(), payout: { findUnique: async () => null } };
  const result = await service.createPayoutHold(tx, {
    orderId: 'order-1',
    payeeRole: 'TRANSPORTER',
    payeeId: null,
    payment: { id: 'payment-1', amount: 100, currency: 'ETB' },
  });
  assert.equal(result, null);
});

test('a dispute freezes every payout on the order, not just the seller', async () => {
  const payouts = [
    { id: 'payout-seller', orderId: 'order-1', payeeRole: 'SELLER', status: 'HELD' },
    { id: 'payout-transporter', orderId: 'order-1', payeeRole: 'TRANSPORTER', status: 'RELEASED' },
  ];
  const updates = [];
  const tx = {
    ...auditStub(),
    payout: {
      findMany: async () => payouts,
      update: async ({ where, data }) => {
        updates.push({ id: where.id, ...data });
        return { ...payouts.find((p) => p.id === where.id), ...data };
      },
    },
  };

  const result = await service.holdForDispute(tx, { orderId: 'order-1', actorId: 'buyer-1' });

  assert.equal(result.length, 2);
  assert.ok(result.every((p) => p.status === 'ON_HOLD_DISPUTE'));
  assert.equal(updates.length, 2);
});

test('dispute resolution can restart the full hold clock for every frozen payout', async () => {
  const payouts = [
    { id: 'payout-seller', orderId: 'order-1', status: 'ON_HOLD_DISPUTE' },
    { id: 'payout-inspector', orderId: 'order-1', status: 'ON_HOLD_DISPUTE' },
  ];
  const updates = [];
  const tx = {
    ...auditStub(),
    payout: {
      findMany: async () => payouts,
      update: async ({ where, data }) => {
        const merged = { ...payouts.find((p) => p.id === where.id), ...data };
        updates.push(merged);
        return merged;
      },
    },
  };

  const before = Date.now();
  const result = await service.resumeAfterDispute(tx, { orderId: 'order-1', actorId: 'admin-1' });
  const after = Date.now();

  assert.equal(result.length, 2);
  for (const payout of result) {
    assert.equal(payout.status, 'HELD');
    assert.equal(payout.releasedAt, null);
    assert.equal(payout.paidOutAt, null);
    assert.equal(payout.payoutReference, null);
    assert.ok(payout.releaseAt.getTime() >= before + 3 * 24 * 60 * 60 * 1000);
    assert.ok(payout.releaseAt.getTime() <= after + 3 * 24 * 60 * 60 * 1000 + 1000);
  }
});

test('dispute resolution can cancel every frozen payout on the order', async () => {
  const payouts = [
    { id: 'payout-seller', orderId: 'order-1', status: 'ON_HOLD_DISPUTE' },
    { id: 'payout-transporter', orderId: 'order-1', status: 'ON_HOLD_DISPUTE' },
  ];
  const tx = {
    ...auditStub(),
    payout: {
      findMany: async () => payouts,
      update: async ({ where, data }) => ({ ...payouts.find((p) => p.id === where.id), ...data }),
    },
  };

  const result = await service.cancelAfterDispute(tx, { orderId: 'order-1', actorId: 'admin-1' });
  assert.equal(result.length, 2);
  assert.ok(result.every((p) => p.status === 'CANCELLED'));
});

test('markPaidOut only succeeds from RELEASED, regardless of payeeRole', async () => {
  const tx = {
    ...auditStub(),
    payout: {
      findUnique: async () => ({ id: 'payout-1', status: 'HELD', payeeRole: 'INSPECTOR' }),
    },
  };

  await assert.rejects(
    () => service.markPaidOut(tx, { payoutId: 'payout-1', actorId: 'admin-1', payoutReference: 'ref-1' }),
    /only a RELEASED payout can be marked paid out/
  );
});
