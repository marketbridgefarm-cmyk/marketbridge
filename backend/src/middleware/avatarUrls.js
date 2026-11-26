'use strict';

// Safety net + convenience for profile photos.
//   • Any query may select `avatarKey: true` on a user; this middleware turns it into the public
//     `avatarUrl` on the way out, so routes do not each need their own mapping.
//   • The private storage key can never reach a client, even if a route forgets to map it.
// Only plain objects and arrays are walked (Dates, Decimals, Buffers are left alone).
const { avatarUrlFor } = require('../utils/avatarUrl');

const isPlain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function convertAvatars(value) {
  if (Array.isArray(value)) return value.map(convertAvatars);
  if (!isPlain(value)) return value;

  const hasKey = Object.prototype.hasOwnProperty.call(value, 'avatarKey');
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== 'avatarKey') out[k] = convertAvatars(v);
  }
  if (hasKey) out.avatarUrl = value.id && value.avatarKey ? avatarUrlFor({ id: value.id, avatarKey: value.avatarKey }) : null;
  return out;
}

function avatarUrlResponse(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(convertAvatars(body));
  next();
}

module.exports = { avatarUrlResponse, convertAvatars };
