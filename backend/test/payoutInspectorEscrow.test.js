'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { releaseDuePayouts, releaseInspectorPayoutsForRequest } = require('../src/services/payoutService');

const NOW = new Date('2026-11-10T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const hoursAhead = (h) => new Date(NOW.getTime() + h * 3600 * 1000);

function fakePrisma(payouts) {
  const claims = [];
  const moves = [];
  return {
    claims,
    moves,
    payout: {
      findMany: async () => payouts,
      updateMany: async ({ where, data }) => {
        if (data.status === 'RELEASED') { claims.push({ where, data }); return { count: 1 }; }
        moves.push({ where, data });
        return { count: 1 };
      },
    },
  };
}

const inspectorPayout = (request, over = {}) => ({
  id: 'p1', payeeRole: 'INSPECTOR', status: 'HELD',
  releaseAt: hoursAhead(72), // generic payment-time hold, far in the future
  payment: { inspectionRequest: request },
  ...over,
});

test('inspector fee stays in escrow while the report has not been submitted', async () => {
  for (const status of ['ACCEPTED', 'IN_PROGRESS']) {
    const prisma = fakePrisma([inspectorPayout({ status, completedAt: null })]);
    const out = await releaseDuePayouts(prisma, NOW);
    assert.deepEqual(out, { released: 0, deferred: 1 }, status);
    assert.equal(prisma.claims.length, 0);
  }
});

test('after the report is submitted, the fee waits for the review window (48h by default)', async () => {
  const prisma = fakePrisma([inspectorPayout({ status: 'COMPLETED', completedAt: hoursAgo(10), reportAcceptedAt: null })]);
  const out = await releaseDuePayouts(prisma, NOW);
  assert.deepEqual(out, { released: 0, deferred: 1 });
});

test('review window elapsed: released automatically even though the old 3-day hold has not passed', async () => {
  const prisma = fakePrisma([inspectorPayout({ status: 'COMPLETED', completedAt: hoursAgo(49), reportAcceptedAt: null })]);
  const out = await releaseDuePayouts(prisma, NOW);
  assert.deepEqual(out, { released: 1, deferred: 0 });
  const claim = prisma.claims[0];
  assert.equal(claim.where.status, 'HELD');
  assert.equal('releaseAt' in claim.where, false);          // no stale payment-time condition
});

test('report accepted: released immediately, no waiting', async () => {
  const prisma = fakePrisma([inspectorPayout({ status: 'COMPLETED', completedAt: hoursAgo(1), reportAcceptedAt: hoursAgo(0.01) })]);
  const out = await releaseDuePayouts(prisma, NOW);
  assert.deepEqual(out, { released: 1, deferred: 0 });
});

test('the review window is configurable', async () => {
  process.env.INSPECTION_REPORT_REVIEW_HOURS = '6';
  try {
    const prisma = fakePrisma([inspectorPayout({ status: 'COMPLETED', completedAt: hoursAgo(7), reportAcceptedAt: null })]);
    assert.deepEqual(await releaseDuePayouts(prisma, NOW), { released: 1, deferred: 0 });
  } finally {
    delete process.env.INSPECTION_REPORT_REVIEW_HOURS;
  }
});

test('seller and transporter payouts keep their original rule (receipt + hold days)', async () => {
  const receipt = { createdAt: hoursAgo(24) };
  const prisma = fakePrisma([
    { id: 's1', payeeRole: 'SELLER', status: 'HELD', releaseAt: hoursAgo(1), order: { events: [receipt] } },
  ]);
  // receipt 24h ago + 3 days hold => not yet
  assert.deepEqual(await releaseDuePayouts(prisma, NOW), { released: 0, deferred: 1 });
  const old = fakePrisma([
    { id: 's2', payeeRole: 'SELLER', status: 'HELD', releaseAt: hoursAgo(1), order: { events: [{ createdAt: hoursAgo(24 * 5) }] } },
  ]);
  assert.deepEqual(await releaseDuePayouts(old, NOW), { released: 1, deferred: 0 });
  assert.ok('releaseAt' in old.claims[0].where);            // original guard preserved for non-inspectors
});

test('releaseInspectorPayoutsForRequest only touches HELD inspector payouts of that request', async () => {
  let seen;
  const tx = { payout: { updateMany: async (args) => { seen = args; return { count: 2 }; } } };
  const out = await releaseInspectorPayoutsForRequest(tx, { inspectionRequestId: 'r1', now: NOW });
  assert.equal(out.released, 2);
  assert.deepEqual(seen.where, { status: 'HELD', payeeRole: 'INSPECTOR', payment: { inspectionRequestId: 'r1' } });
  assert.equal(seen.data.status, 'RELEASED');
});

// ── After the report is submitted, nothing may freeze or cancel the inspector's fee ──

const { holdForDispute, cancelPayoutsForOrder } = require('../src/services/payoutService');

function fakeTx(payouts) {
  const updates = [];
  let findArgs = null;
  return {
    updates,
    get findArgs() { return findArgs; },
    payout: {
      findMany: async (args) => { findArgs = args; return payouts; },
      update: async ({ where, data }) => { updates.push({ id: where.id, ...data }); return { id: where.id, ...data }; },
    },
    auditEvent: { create: async () => ({}) },
  };
}

const earnedInspector = { id: 'pi', payeeRole: 'INSPECTOR', status: 'HELD', payment: { inspectionRequest: { status: 'COMPLETED' } } };
const unfinishedInspector = { id: 'pu', payeeRole: 'INSPECTOR', status: 'HELD', payment: { inspectionRequest: { status: 'IN_PROGRESS' } } };
const sellerPayout = { id: 'ps', payeeRole: 'SELLER', status: 'HELD', payment: { inspectionRequest: null } };
const transporterPayout = { id: 'pt', payeeRole: 'TRANSPORTER', status: 'HELD', payment: { inspectionRequest: null } };

test('an unclassified order dispute freezes everyone EXCEPT an inspector who already submitted the report', async () => {
  const tx = fakeTx([earnedInspector, unfinishedInspector, sellerPayout, transporterPayout]);
  const frozen = await holdForDispute(tx, { orderId: 'o1', actorId: 'a', disputeType: null });
  assert.deepEqual(tx.updates.map((u) => u.id).sort(), ['ps', 'pt', 'pu']);
  assert.equal(frozen.length, 3);
});

test('goods and transport disputes never touch the inspector payout', async () => {
  for (const disputeType of ['GOODS_QUALITY', 'TRANSPORT_DAMAGE', 'SELLER_FRAUD']) {
    const tx = fakeTx([earnedInspector, sellerPayout, transporterPayout]);
    await holdForDispute(tx, { orderId: 'o1', actorId: 'a', disputeType });
    assert.ok(!tx.updates.some((u) => u.id === 'pi'), disputeType);
  }
});

test('a dispute explicitly about the inspection report still freezes the fee (safety valve), unless switched off', async () => {
  const tx = fakeTx([earnedInspector]);
  await holdForDispute(tx, { orderId: 'o1', actorId: 'a', disputeType: 'INSPECTION_REPORT' });
  assert.deepEqual(tx.updates.map((u) => u.id), ['pi']);

  process.env.INSPECTOR_FEE_FREEZE_ON_REPORT_DISPUTE = 'false';
  try {
    const off = fakeTx([earnedInspector]);
    await holdForDispute(off, { orderId: 'o1', actorId: 'a', disputeType: 'INSPECTION_REPORT' });
    assert.equal(off.updates.length, 0);
  } finally {
    delete process.env.INSPECTOR_FEE_FREEZE_ON_REPORT_DISPUTE;
  }
});

test('an inspector who has NOT finished is still frozen by an inspection dispute', async () => {
  const tx = fakeTx([unfinishedInspector]);
  await holdForDispute(tx, { orderId: 'o1', actorId: 'a', disputeType: 'INSPECTION' });
  assert.deepEqual(tx.updates.map((u) => u.id), ['pu']);
});

test('cancelling an order cancels seller/transport payouts but excludes earned inspector payouts from the query', async () => {
  const tx = fakeTx([sellerPayout, transporterPayout]);
  const cancelled = await cancelPayoutsForOrder(tx, { orderId: 'o1', actorId: 'a', reason: 'buyer cancelled', retainInspectionRequestIds: ['req1'] });
  assert.equal(cancelled.length, 2);
  assert.deepEqual(tx.findArgs.where.NOT, { payeeRole: 'INSPECTOR', payment: { inspectionRequestId: { in: ['req1'] } } });
  assert.ok(tx.updates.every((u) => u.status === 'CANCELLED'));
});

test('without any earned inspection the cancellation query is unchanged', async () => {
  const tx = fakeTx([sellerPayout]);
  await cancelPayoutsForOrder(tx, { orderId: 'o1', actorId: 'a', reason: 'x' });
  assert.equal('NOT' in tx.findArgs.where, false);
});
