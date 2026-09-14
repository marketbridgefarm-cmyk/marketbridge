'use strict';

const { normalizePrivateKey } = require('./objectStorage');

// Sanity limit on how many photo/video references a single listing can
// carry — mirrors the cap already applied on the listing-update path.
const MAX_REFERENCES = 10;

/**
 * Filters a caller-supplied list of listing photo/video keys down to the
 * ones that are safe to persist on a listing.
 *
 * Listing media is uploaded via POST /listings/media, which stores each
 * file in private object storage under
 * `evidence/listing/<uploaderId>/<uuid><ext>` (see utils/evidenceUpload.js).
 * Listing creation accepts an arbitrary `photos`/`videos` array in the
 * request body, so without this check a user could submit someone else's
 * private evidence key and have it attached — and later served via a
 * signed URL — as their own listing media. This scopes accepted keys to
 * ones that were actually uploaded by the authenticated user into the
 * listing-media namespace, dropping anything else rather than erroring,
 * since photos/videos are optional on listing creation.
 *
 * @param {unknown} keys - candidate array of photo or video keys
 * @param {string} userId - id of the authenticated user creating the listing
 * @param {string} [kind] - 'photos' | 'videos', unused beyond documenting intent
 * @returns {string[]} the subset of keys that are valid, owned references
 */
function validateListingReferences(keys, userId, kind) {
  if (!Array.isArray(keys) || !userId) return [];

  const prefix = `evidence/listing/${userId}/`;
  const seen = new Set();
  const safe = [];

  for (const rawKey of keys) {
    if (typeof rawKey !== 'string') continue;

    let normalized;
    try {
      normalized = normalizePrivateKey(rawKey);
    } catch (error) {
      // Object storage isn't configured / key couldn't be normalized —
      // treat as an invalid reference rather than failing the request.
      continue;
    }

    if (!normalized || !normalized.startsWith(prefix)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    safe.push(normalized);

    if (safe.length >= MAX_REFERENCES) break;
  }

  return safe;
}

module.exports = { validateListingReferences };
