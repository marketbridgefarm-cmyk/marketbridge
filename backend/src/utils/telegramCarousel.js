'use strict';

/**
 * Helpers for TELEGRAM_PROMOTION campaigns that use the CAROUSEL template.
 *
 * Carousel photos are uploaded ahead of campaign creation (POST
 * /api/ads/telegram-images) into private object storage under a per-user
 * prefix, and the campaign then references them by key. Because the client
 * sends those keys back, the server must never trust them blindly: a key
 * that points at somebody else's upload (or at any other object in the
 * bucket) would let an advertiser get a private file signed and shown to
 * MarketBridge staff / themselves. parseTelegramImageKeys() therefore only
 * accepts keys this exact user's upload endpoint could have produced.
 */

const KEY_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

function telegramKeyPrefix(userId) {
  return `advertisements/telegram/${userId}/`;
}

function isOwnedTelegramImageKey(key, userId) {
  if (typeof key !== 'string' || !userId) return false;
  const prefix = telegramKeyPrefix(userId);
  return key.startsWith(prefix) && KEY_FILE_PATTERN.test(key.slice(prefix.length));
}

/**
 * Validate the list of uploaded image keys submitted with a carousel
 * campaign. Returns `{ keys }` (order preserved — it is the slide order) or
 * `{ error }` with a message safe to show to the advertiser.
 */
function parseTelegramImageKeys(raw, userId, { minImages, maxImages }) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `A Telegram carousel needs at least ${minImages} uploaded images` };
  }
  const keys = raw.map((value) => (typeof value === 'string' ? value.trim() : ''));
  if (keys.length < minImages) return { error: `A Telegram carousel needs at least ${minImages} images` };
  if (keys.length > maxImages) return { error: `A Telegram carousel can have at most ${maxImages} images` };
  if (!keys.every((key) => isOwnedTelegramImageKey(key, userId))) {
    return { error: 'One or more carousel images are invalid — please re-upload them' };
  }
  if (new Set(keys).size !== keys.length) return { error: 'The same carousel image was added more than once' };
  return { keys };
}

module.exports = { telegramKeyPrefix, isOwnedTelegramImageKey, parseTelegramImageKeys };
