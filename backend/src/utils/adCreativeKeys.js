'use strict';

/**
 * Ownership checks for advertisement BANNER creative keys.
 *
 * POST /api/ads/creative stores every banner image under
 * `advertisements/banner/<uploaderId>/<uuid>.webp` and hands the key back to
 * the client, which later submits it with the campaign. The key is therefore
 * client-controlled input: without this check an advertiser could submit any
 * object key in the bucket (another user's banner, a digital product file, an
 * evidence upload...) and have the platform sign a viewing URL for it.
 *
 * The Telegram carousel equivalents live in ./telegramCarousel.js.
 */

const BANNER_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i;

function bannerKeyPrefix(userId) {
  return `advertisements/banner/${userId}/`;
}

function isOwnedBannerCreativeKey(key, userId) {
  if (typeof key !== 'string' || !userId) return false;
  const prefix = bannerKeyPrefix(userId);
  return key.startsWith(prefix) && BANNER_FILE_PATTERN.test(key.slice(prefix.length));
}

module.exports = { bannerKeyPrefix, isOwnedBannerCreativeKey };
