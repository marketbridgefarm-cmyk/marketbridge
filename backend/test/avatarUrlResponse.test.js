'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertAvatars, avatarUrlResponse } = require('../src/middleware/avatarUrls');

test('avatarKey is turned into avatarUrl at any depth and never leaks', () => {
  const out = convertAvatars({
    id: 'o1',
    buyer: { id: 'u1', name: 'Esan', avatarKey: 'avatars/u1/a.webp' },
    seller: { id: 'u2', name: 'Hawi', avatarKey: null },
    list: [{ truckOwner: { id: 'u3', name: 'T', avatarKey: 'avatars/u3/b.webp' } }],
  });
  assert.match(out.buyer.avatarUrl, /^\/api\/users\/u1\/avatar\?v=/);
  assert.equal(out.seller.avatarUrl, null);
  assert.match(out.list[0].truckOwner.avatarUrl, /^\/api\/users\/u3\/avatar/);
  assert.equal(JSON.stringify(out).includes('avatarKey'), false);
});

test('objects without avatarKey, Dates and non-plain values pass through untouched', () => {
  const date = new Date('2026-11-25T00:00:00Z');
  const out = convertAvatars({ id: 'x', createdAt: date, amount: 12, tags: ['a'], nothing: null });
  assert.equal(out.createdAt, date);
  assert.equal('avatarUrl' in out, false);
  assert.deepEqual(out.tags, ['a']);
});

test('a user object without an id never gets a link', () => {
  assert.equal(convertAvatars({ name: 'No id', avatarKey: 'k' }).avatarUrl, null);
});

test('middleware rewrites res.json output', () => {
  let sent;
  const res = { json: (b) => { sent = b; } };
  avatarUrlResponse({}, res, () => {});
  res.json({ user: { id: 'u1', avatarKey: 'k' } });
  assert.ok(sent.user.avatarUrl.startsWith('/api/users/u1/avatar'));
  assert.equal('avatarKey' in sent.user, false);
});
