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
