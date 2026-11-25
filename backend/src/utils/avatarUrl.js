'use strict';

// Pure helpers (no storage / image dependencies) so routes, serializers and tests can share them.
const crypto = require('crypto');

// Stable public path for a user's photo. The path never changes while the photo is the same, and the
// short ?v= fingerprint changes when the photo does, so browsers can cache it safely. The route behind it
// (routes/users.js) redirects to a freshly signed private-storage URL.
function avatarUrlFor(user) {
  if (!user || !user.id || !user.avatarKey) return null;
  const v = crypto.createHash('sha1').update(String(user.avatarKey)).digest('hex').slice(0, 10);
  return `/api/users/${user.id}/avatar?v=${v}`;
}

// Replace the private storage key with the public avatarUrl on any user-shaped object.
function withAvatarUrl(user) {
  if (!user || typeof user !== 'object') return user;
  const { avatarKey, ...rest } = user;
  return { ...rest, avatarUrl: avatarUrlFor(user) };
}

module.exports = { avatarUrlFor, withAvatarUrl };
