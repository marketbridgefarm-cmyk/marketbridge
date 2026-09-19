'use strict';

const path = require('path');
const crypto = require('crypto');

let sharp;
try {
  // Loaded lazily so non-image API operations can still start while dependencies
  // are being installed. Production image endpoints fail closed if unavailable.
  sharp = require('sharp');
} catch (_) {
  sharp = null;
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_INPUT_PIXELS = Number(process.env.IMAGE_MAX_INPUT_PIXELS || 40_000_000);
const LISTING_MAX_WIDTH = Number(process.env.LISTING_IMAGE_MAX_WIDTH || 1920);
const LISTING_MAX_HEIGHT = Number(process.env.LISTING_IMAGE_MAX_HEIGHT || 1920);
const LISTING_QUALITY = Number(process.env.LISTING_IMAGE_QUALITY || 82);
const AD_MAX_WIDTH = Number(process.env.AD_IMAGE_MAX_WIDTH || 1600);
const AD_MAX_HEIGHT = Number(process.env.AD_IMAGE_MAX_HEIGHT || 900);
const AD_QUALITY = Number(process.env.AD_IMAGE_QUALITY || 84);

function isImageMime(mime) {
  return IMAGE_MIME_TYPES.has(String(mime || '').toLowerCase());
}

function hasValidImageSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const type = String(mime || '').toLowerCase();
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  // HEIF/HEIC files are ISO-BMFF containers. Require an ftyp box and a
  // compatible brand rather than trusting the multipart MIME header.
  if (type === 'image/heic' || type === 'image/heif') {
    return buffer.toString('ascii', 4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/i.test(buffer.toString('ascii', 8, Math.min(buffer.length, 64)));
  }
  return false;
}

function requireSharp() {
  if (!sharp) {
    throw new Error('Image processing is unavailable: install the sharp package before enabling image uploads in production');
  }
  return sharp;
}

function normalizedQuality(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(40, Math.round(n))) : fallback;
}

async function processImage(buffer, options = {}) {
  const imageSharp = requireSharp();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Image buffer is empty');

  const maxWidth = Math.max(1, Number(options.maxWidth || LISTING_MAX_WIDTH));
  const maxHeight = Math.max(1, Number(options.maxHeight || LISTING_MAX_HEIGHT));
  const quality = normalizedQuality(options.quality, LISTING_QUALITY);
  // WebP is the default everywhere. Telegram albums are the exception: the
  // Bot API is most reliable with JPEG photos, so callers can ask for it.
  const format = options.format === 'jpeg' ? 'jpeg' : 'webp';

  const image = imageSharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  });

  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not determine image dimensions');
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw new Error('Image dimensions exceed the configured safety limit');

  const pipeline = image
    .rotate() // apply EXIF orientation, then discard metadata
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true });

  const output = format === 'jpeg'
    // JPEG has no alpha channel: flatten transparent PNG/WebP onto white
    // instead of letting it turn black.
    ? await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    : await pipeline.webp({ quality, effort: 4, smartSubsample: true }).toBuffer();

  return {
    buffer: output,
    contentType: format === 'jpeg' ? 'image/jpeg' : 'image/webp',
    extension: format === 'jpeg' ? '.jpg' : '.webp',
    originalBytes: buffer.length,
    optimizedBytes: output.length,
    width: metadata.width,
    height: metadata.height,
    wasResized: metadata.width > maxWidth || metadata.height > maxHeight,
    compressionRatio: Number((output.length / buffer.length).toFixed(4)),
  };
}

function makeDerivedKey(key, suffix = 'optimized') {
  const ext = path.extname(key);
  const base = ext ? key.slice(0, -ext.length) : key;
  return `${base}-${suffix}-${crypto.randomUUID()}.webp`;
}

async function optimizeUpload({ buffer, mime, maxWidth, maxHeight, quality, format, imageOnly = true }) {
  if (!isImageMime(mime)) return { buffer, contentType: mime, extension: path.extname('file') || '', optimized: false };
  if (!hasValidImageSignature(buffer, mime)) throw new Error('Image file contents do not match the declared image type');
  return { ...(await processImage(buffer, { maxWidth, maxHeight, quality, format })), optimized: true, imageOnly };
}

module.exports = {
  IMAGE_MIME_TYPES,
  isImageMime,
  hasValidImageSignature,
  processImage,
  optimizeUpload,
  makeDerivedKey,
  MAX_INPUT_PIXELS,
};
