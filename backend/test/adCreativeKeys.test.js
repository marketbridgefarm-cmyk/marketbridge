'use strict';

/**
 * Pure unit tests for BANNER creative key ownership
 * (backend/src/utils/adCreativeKeys.js). No database or storage needed.
 *
 * POST /api/ads receives the storage key back from the client, so it must
 * only accept keys that this same user's POST /api/ads/creative could have
 * produced — otherwise an advertiser could get any object in the private
 * bucket signed and displayed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { bannerKeyPrefix, isOwnedBannerCreativeKey } = require('../src/utils/adCreativeKeys');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '00000000-0000-4000-8000-000000000001.webp';

test('accepts a key under the caller\'s own banner prefix', () => {
  assert.equal(isOwnedBannerCreativeKey(`${bannerKeyPrefix(USER)}${FILE}`, USER), true);
  assert.equal(bannerKeyPrefix(USER), `advertisements/banner/${USER}/`);
});

test('rejects another user\'s banner, and keys from other parts of the bucket', () => {
  assert.equal(isOwnedBannerCreativeKey(`${bannerKeyPrefix(OTHER)}${FILE}`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`digital-products/${USER}/${FILE}`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`advertisements/telegram/${USER}/${FILE.replace('.webp', '.jpg')}`, USER), false);
  assert.equal(isOwnedBannerCreativeKey('s3://bucket/advertisements/banner/x/y.webp', USER), false);
  assert.equal(isOwnedBannerCreativeKey('https://evil.example/x.webp', USER), false);
});

test('rejects traversal, wrong extensions, and malformed file names', () => {
  const prefix = bannerKeyPrefix(USER);
  assert.equal(isOwnedBannerCreativeKey(`${prefix}../${OTHER}/${FILE}`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`${prefix}${FILE.replace('.webp', '.exe')}`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`${prefix}not-a-uuid.webp`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`${prefix}${FILE}/extra`, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`${prefix}${FILE}\n`, USER), false);
});

test('rejects non-string input and a missing user', () => {
  assert.equal(isOwnedBannerCreativeKey(undefined, USER), false);
  assert.equal(isOwnedBannerCreativeKey(null, USER), false);
  assert.equal(isOwnedBannerCreativeKey({ key: `${bannerKeyPrefix(USER)}${FILE}` }, USER), false);
  assert.equal(isOwnedBannerCreativeKey(`${bannerKeyPrefix(USER)}${FILE}`, ''), false);
  assert.equal(isOwnedBannerCreativeKey(`${bannerKeyPrefix(USER)}${FILE}`, undefined), false);
});
