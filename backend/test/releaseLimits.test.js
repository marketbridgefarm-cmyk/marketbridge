'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/releaseLimitsService');

test('reason is required and must be from the list', () => {
  assert.throws(() => svc.parseReleaseReason({}), { statusCode: 400 });
  assert.throws(() => svc.parseReleaseReason({ reason: 'BORED' }), { statusCode: 400 });
  assert.deepEqual(svc.parseReleaseReason({ reason: 'no_response' }), { reason: 'NO_RESPONSE', note: null });
});

test('OTHER needs a note, note is trimmed to 200 chars', () => {
  assert.throws(() => svc.parseReleaseReason({ reason: 'OTHER' }), { statusCode: 400 });
  const r = svc.parseReleaseReason({ reason: 'OTHER', note: ` ${'x'.repeat(300)} ` });
  assert.equal(r.note.length, 200);
});

test('release is blocked until the wait period after acceptance elapses', () => {
  const fresh = { updatedAt: new Date().toISOString() };
  assert.throws(() => svc.assertAcceptedReleaseWindowElapsed(fresh), (e) => e.statusCode === 409 && e.releaseAvailableAt instanceof Date);
  const old = { updatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
  assert.doesNotThrow(() => svc.assertAcceptedReleaseWindowElapsed(old));
});

test('limits are configurable and default to 24h / 2 releases', () => {
  assert.equal(svc.acceptedReleaseWaitHours(), 24);
  assert.equal(svc.maxAcceptedReleases(), 2);
});

test('countAcceptedReleases queries audit events by job id in metadata', async () => {
  let seen;
  const tx = { auditEvent: { count: async (args) => { seen = args; return 2; } } };
  const n = await svc.countAcceptedReleases(tx, { action: 'TRANSPORT_QUOTE_WITHDRAWN', metadataKey: 'transportJobId', jobId: 'j1' });
  assert.equal(n, 2);
  assert.deepEqual(seen.where.metadata, { path: ['transportJobId'], equals: 'j1' });
});

test('releaseAllowance adds one extra release per admin override', async () => {
  const tx = {
    auditEvent: {
      count: async ({ where }) => (where.action === 'RELEASE_LIMIT_OVERRIDE' ? 1 : 2),
    },
  };
  const r = await svc.releaseAllowance(tx, { action: 'TRANSPORT_QUOTE_WITHDRAWN', metadataKey: 'transportJobId', jobId: 'j1' });
  assert.deepEqual(r, { used: 2, allowed: 3 });
});
