import assert from 'node:assert/strict';
import { resolveAvatarUrl } from '../src/utils/avatarUrl.js';

// No VITE_API_URL in node: same-origin, so the relative path stays relative.
assert.equal(resolveAvatarUrl(null), null);
assert.equal(resolveAvatarUrl(''), null);
assert.equal(resolveAvatarUrl('/api/users/u1/avatar?v=abc'), '/api/users/u1/avatar?v=abc');
assert.equal(resolveAvatarUrl('api/users/u1/avatar'), '/api/users/u1/avatar');
// Already-absolute and local preview URLs are left alone.
assert.equal(resolveAvatarUrl('https://cdn.example/a.webp'), 'https://cdn.example/a.webp');
assert.equal(resolveAvatarUrl('blob:http://x/1'), 'blob:http://x/1');
console.log('ok: avatar url helper');
