'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { avatarUrlFor, withAvatarUrl } = require('../src/utils/avatarUrl');

test('avatarUrlFor returns null when the user has no photo', () => {
  assert.equal(avatarUrlFor({ id: 'u1' }), null);
  assert.equal(avatarUrlFor(null), null);
});

test('avatarUrlFor gives a stable public path that changes when the photo changes', () => {
  const a = avatarUrlFor({ id: 'u1', avatarKey: 'avatars/u1/one.webp' });
  const again = avatarUrlFor({ id: 'u1', avatarKey: 'avatars/u1/one.webp' });
  const b = avatarUrlFor({ id: 'u1', avatarKey: 'avatars/u1/two.webp' });
  assert.match(a, /^\/api\/users\/u1\/avatar\?v=[0-9a-f]{10}$/);
  assert.equal(a, again);
  assert.notEqual(a, b);
});

test('withAvatarUrl never exposes the private storage key', () => {
  const out = withAvatarUrl({ id: 'u1', name: 'Almaz', avatarKey: 'avatars/u1/one.webp' });
  assert.equal('avatarKey' in out, false);
  assert.equal(out.name, 'Almaz');
  assert.ok(out.avatarUrl.startsWith('/api/users/u1/avatar'));
  assert.equal(withAvatarUrl({ id: 'u2', name: 'No photo' }).avatarUrl, null);
});
