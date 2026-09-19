'use strict';

/**
 * Pure unit tests for the Telegram carousel key validation
 * (backend/src/utils/telegramCarousel.js). No database or storage needed.
 *
 * The client sends back the storage keys returned by POST
 * /api/ads/telegram-images when it creates a campaign, so the server must
 * only accept keys that this same user's upload endpoint could have made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { telegramKeyPrefix, isOwnedTelegramImageKey, parseTelegramImageKeys } = require('../src/utils/telegramCarousel');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LIMITS = { minImages: 2, maxImages: 10 };

function key(userId, n) {
  return `${telegramKeyPrefix(userId)}00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jpg`;
}

test('accepts 2–10 of the user\'s own uploads and preserves slide order', () => {
  const keys = [key(USER, 3), key(USER, 1), key(USER, 2)];
  const result = parseTelegramImageKeys(keys, USER, LIMITS);
  assert.deepEqual(result, { keys });

  const ten = Array.from({ length: 10 }, (_, i) => key(USER, i + 1));
  assert.deepEqual(parseTelegramImageKeys(ten, USER, LIMITS).keys, ten);
});

test('rejects too few, too many, and missing images', () => {
  assert.match(parseTelegramImageKeys([key(USER, 1)], USER, LIMITS).error, /at least 2/);
  assert.match(parseTelegramImageKeys([], USER, LIMITS).error, /at least 2/);
  assert.match(parseTelegramImageKeys(undefined, USER, LIMITS).error, /at least 2/);
  assert.match(parseTelegramImageKeys('not-an-array', USER, LIMITS).error, /at least 2/);
  const eleven = Array.from({ length: 11 }, (_, i) => key(USER, i + 1));
  assert.match(parseTelegramImageKeys(eleven, USER, LIMITS).error, /at most 10/);
  assert.match(parseTelegramImageKeys(eleven.slice(0, 4), USER, { minImages: 2, maxImages: 3 }).error, /at most 3/);
});

test('rejects another user\'s uploads and arbitrary bucket keys', () => {
  assert.ok(parseTelegramImageKeys([key(USER, 1), key(OTHER, 2)], USER, LIMITS).error);
  assert.equal(isOwnedTelegramImageKey('digital-products/abc/secret.pdf', USER), false);
  assert.equal(isOwnedTelegramImageKey(`${telegramKeyPrefix(USER)}../${OTHER}/x.jpg`, USER), false);
  assert.equal(isOwnedTelegramImageKey(`${telegramKeyPrefix(USER)}not-a-uuid.jpg`, USER), false);
  assert.equal(isOwnedTelegramImageKey(key(USER, 1).replace('.jpg', '.exe'), USER), false);
  assert.equal(isOwnedTelegramImageKey(key(USER, 1), ''), false);
  assert.equal(isOwnedTelegramImageKey(42, USER), false);
});

test('rejects duplicate images and non-string entries', () => {
  assert.match(parseTelegramImageKeys([key(USER, 1), key(USER, 1)], USER, LIMITS).error, /more than once/);
  assert.ok(parseTelegramImageKeys([key(USER, 1), { key: key(USER, 2) }], USER, LIMITS).error);
  assert.ok(parseTelegramImageKeys([key(USER, 1), null], USER, LIMITS).error);
});

test('trims whitespace around otherwise valid keys', () => {
  const result = parseTelegramImageKeys([` ${key(USER, 1)} `, key(USER, 2)], USER, LIMITS);
  assert.deepEqual(result.keys, [key(USER, 1), key(USER, 2)]);
});
