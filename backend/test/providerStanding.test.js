'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/providerStandingService');

// Minimal in-memory Prisma stand-in for the standing + audit + rating tables.
function makeTx({ standing = null, cancels = 0, ratings = [4, 5] } = {}) {
  const state = {
    standing: standing && { id: 's1', userId: 'u1', status: 'GOOD', suspensionCount: 0, suspendedAt: null,
      suspendedUntil: null, probationUntil: null, ratingPenalty: 0, ...standing },
    cancels,
    audits: [],
    userRating: null,
    events: [],
  };
  const tx = {
    state,
    providerStanding: {
      upsert: async ({ create }) => (state.standing ||= { id: 's1', status: 'GOOD', suspensionCount: 0, suspendedAt: null,
        suspendedUntil: null, probationUntil: null, ratingPenalty: 0, ...create }),
      findUnique: async () => state.standing,
      update: async ({ data }) => Object.assign(state.standing, data),
    },
    auditEvent: {
      count: async () => state.cancels,
      create: async ({ data }) => { state.audits.push(data); return data; },
    },
    rating: { aggregate: async () => ({ _avg: { score: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null } }) },
    user: { update: async ({ data }) => { state.userRating = data.rating; return data; } },
    orderEvent: { create: async ({ data }) => { state.events.push(data); return { id: 'e1', ...data }; } },
    order: { findUnique: async () => null },
    notification: { createMany: async () => ({}) },
  };
  return tx;
}

test('suspension lengths escalate and the 4th is indefinite', () => {
  assert.equal(svc.suspensionDaysFor(1), 3);
  assert.equal(svc.suspensionDaysFor(2), 14);
  assert.equal(svc.suspensionDaysFor(3), 30);
  assert.equal(svc.suspensionDaysFor(4), null);
});

test('first cancellation: rating hit only', async () => {
  const tx = makeTx({ cancels: 1 });
  const out = await svc.applyProviderCancellation(tx, { userId: 'u1', orderId: 'o1', reason: 'SCHEDULE_CONFLICT' });
  assert.equal(out.action, 'RATING_HIT');
  assert.equal(tx.state.standing.status, 'GOOD');
  assert.equal(tx.state.standing.ratingPenalty, svc.CANCEL_PENALTY);
  assert.equal(tx.state.userRating, 4.4); // 4.5 average - 0.1
});

test('second cancellation warns', async () => {
  const tx = makeTx({ cancels: 2 });
  const out = await svc.applyProviderCancellation(tx, { userId: 'u1', orderId: 'o1', reason: 'OTHER' });
  assert.equal(out.action, 'WARNED');
  assert.equal(tx.state.events[0].metadata.kind, 'WARNING');
});

test('third cancellation suspends for 3 days with extra rating hit', async () => {
  const tx = makeTx({ cancels: 3 });
  const out = await svc.applyProviderCancellation(tx, { userId: 'u1', orderId: 'o1', reason: 'OTHER' });
  assert.equal(out.action, 'SUSPENDED');
  const s = tx.state.standing;
  assert.equal(s.status, 'SUSPENDED');
  assert.equal(s.suspensionCount, 1);
  const days = (s.suspendedUntil - s.suspendedAt) / 86400000;
  assert.equal(Math.round(days), 3);
  assert.equal(Math.round(s.ratingPenalty * 100) / 100, 0.6); // 0.1 + 0.5
  assert.ok(tx.state.audits.some((a) => a.action === 'PROVIDER_SUSPENDED'));
});

test('a cancellation on probation suspends immediately at the next tier', async () => {
  const tx = makeTx({ cancels: 1, standing: { status: 'PROBATION', suspensionCount: 1, probationUntil: new Date(Date.now() + 86400000) } });
  const out = await svc.applyProviderCancellation(tx, { userId: 'u1', orderId: 'o1', reason: 'OTHER' });
  assert.equal(out.action, 'SUSPENDED');
  assert.equal(tx.state.standing.suspensionCount, 2);
  assert.equal(Math.round((tx.state.standing.suspendedUntil - tx.state.standing.suspendedAt) / 86400000), 14);
});

test('suspension timer ends into REJOIN_PENDING, not straight to good standing', async () => {
  const tx = makeTx({ standing: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() - 1000) } });
  const settled = await svc.settleTimers(tx, tx.state.standing);
  assert.equal(settled.status, 'REJOIN_PENDING');
});

test('clean probation returns to GOOD and restores half the rating penalty', async () => {
  const tx = makeTx({ standing: { status: 'PROBATION', probationUntil: new Date(Date.now() - 1000), ratingPenalty: 0.6 } });
  const settled = await svc.settleTimers(tx, tx.state.standing);
  assert.equal(settled.status, 'GOOD');
  assert.equal(settled.ratingPenalty, 0.3);
  assert.equal(tx.state.userRating, 4.2);
});

test('rejoin requires REJOIN_PENDING and starts probation', async () => {
  const tx = makeTx({ standing: { status: 'REJOIN_PENDING' } });
  const prisma = { $transaction: async (fn) => fn(tx) };
  const updated = await svc.rejoin(prisma, 'u1');
  assert.equal(updated.status, 'PROBATION');
  assert.ok(updated.probationUntil > new Date());

  const stillSuspended = makeTx({ standing: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 86400000) } });
  await assert.rejects(svc.rejoin({ $transaction: async (fn) => fn(stillSuspended) }, 'u1'), { statusCode: 409 });
});

test('appeal: only while suspended, once, with a real message', async () => {
  const tx = makeTx({ standing: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 86400000) } });
  const prisma = { $transaction: async (fn) => fn(tx) };
  await assert.rejects(svc.appeal(prisma, 'u1', 'short'), { statusCode: 400 });
  await svc.appeal(prisma, 'u1', 'The requester moved the pickup site twice.');
  await assert.rejects(svc.appeal(prisma, 'u1', 'Trying a second appeal here.'), { statusCode: 409 });
});

test('admin reinstate can go to GOOD and clear the penalty', async () => {
  const tx = makeTx({ standing: { status: 'SUSPENDED', ratingPenalty: 0.6 } });
  const prisma = { $transaction: async (fn) => fn(tx) };
  const updated = await svc.adminReinstate(prisma, { userId: 'u1', adminId: 'a1', to: 'GOOD', clearPenalty: true });
  assert.equal(updated.status, 'GOOD');
  assert.equal(updated.ratingPenalty, 0);
  assert.equal(tx.state.userRating, 4.5);
  await assert.rejects(svc.adminReinstate(prisma, { userId: 'u1', adminId: 'a1', to: 'GOOD' }), { statusCode: 409 });
});

test('bidding gate blocks suspended and rejoin-pending providers', async () => {
  const mk = (standing) => {
    const tx = makeTx({ standing });
    return { providerStanding: tx.providerStanding, $transaction: async (fn) => fn(tx), auditEvent: tx.auditEvent, rating: tx.rating, user: tx.user };
  };
  await assert.rejects(
    svc.assertProviderCanBid(mk({ status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 86400000) }), 'u1'),
    { code: 'PROVIDER_SUSPENDED' }
  );
  await assert.rejects(svc.assertProviderCanBid(mk({ status: 'REJOIN_PENDING' }), 'u1'), { code: 'PROVIDER_REJOIN_REQUIRED' });
  await assert.doesNotReject(svc.assertProviderCanBid(mk({ status: 'PROBATION', probationUntil: new Date(Date.now() + 86400000) }), 'u1'));
  await assert.doesNotReject(svc.assertProviderCanBid({ providerStanding: { findUnique: async () => null } }, 'u1'));
});
