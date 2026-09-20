'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/sellerPayoutService');

function auditStub() {
  return {
    auditEvent: {
      create: async ({ data }) => ({ id: 'audit-1', ...data }),
    },
  };
}

test('seller payout hold defaults to 3 days', () => {
  const previous = process.env.SELLER_PAYOUT_HOLD_DAYS;
  delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  assert.equal(service.holdDays(), 3);
  if (previous === undefined) delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  else process.env.SELLER_PAYOUT_HOLD_DAYS = previous;
});

test('seller payout hold respects configured hold days', () => {
  const previous = process.env.SELLER_PAYOUT_HOLD_DAYS;
  process.env.SELLER_PAYOUT_HOLD_DAYS = '5';
  assert.equal(service.holdDays(), 5);
  if (previous === undefined) delete process.env.SELLER_PAYOUT_HOLD_DAYS;
  else process.env.SELLER_PAYOUT_HOLD_DAYS = previous;
});

test('createPayoutHold is idempotent and starts a HELD record', async () => {
  const existing = null;
  let created;
  const tx = {
    ...auditStub(),
    sellerPayout: {
      findUnique: async () => existing,
      create: async ({ data }) => {
        created = data;
        return { id: 'payout-1', ...data };
      },
    },
  };

  const result = await service.createPayoutHold(tx, {
    order: { id: 'order-1', sellerId: 'seller-1' },
    payment: { id: 'payment-1', netAmount: 525, amount: 550, currency: 'ETB' },
  });

  assert.equal(result.status, 'HELD');
  assert.equal(created.amount, 525);
  assert.equal(created.currency, 'ETB');
  assert.equal(created.orderId, 'order-1');
  assert.equal(created.sellerId, 'seller-1');
  assert.ok(created.releaseAt instanceof Date);
});

test('dispute resolution can restart the full hold clock', async () => {
  let updated;
  const payout = {
    id: 'payout-1',
    orderId: 'order-1',
    status: 'ON_HOLD_DISPUTE',
    releaseAt: new Date(0),
  };

  const tx = {
    ...auditStub(),
    sellerPayout: {
      findUnique: async () => payout,
      update: async ({ data }) => {
        updated = { ...payout, ...data };
        return updated;
      },
    },
  };

  const before = Date.now();
  const result = await service.resumeAfterDispute(tx, { orderId: 'order-1', actorId: 'admin-1' });
  const after = Date.now();

  assert.equal(result.status, 'HELD');
  assert.equal(result.releasedAt, null);
  assert.equal(result.paidOutAt, null);
  assert.equal(result.payoutReference, null);
  assert.ok(updated.releaseAt.getTime() >= before + 3 * 24 * 60 * 60 * 1000);
  assert.ok(updated.releaseAt.getTime() <= after + 3 * 24 * 60 * 60 * 1000 + 1000);
});

test('dispute resolution can cancel a frozen payout', async () => {
  let updated;
  const tx = {
    ...auditStub(),
    sellerPayout: {
      findUnique: async () => ({ id: 'payout-1', orderId: 'order-1', status: 'ON_HOLD_DISPUTE' }),
      update: async ({ data }) => {
        updated = data;
        return { id: 'payout-1', orderId: 'order-1', status: data.status };
      },
    },
  };

  const result = await service.cancelAfterDispute(tx, { orderId: 'order-1', actorId: 'admin-1' });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(updated.status, 'CANCELLED');
});
