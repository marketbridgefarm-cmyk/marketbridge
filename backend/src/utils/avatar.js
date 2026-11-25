'use strict';

// Profile-photo upload: validation, square crop to 512px WebP, private object storage.
const crypto = require('crypto');
const multer = require('multer');

const { uploadPrivateObject, deletePrivateObject } = require('./objectStorage');
const { optimizeUpload } = require('./imageProcessor');

const AVATAR_SIZE = Number(process.env.AVATAR_IMAGE_SIZE || 512);
const AVATAR_MAX_BYTES = Number(process.env.AVATAR_MAX_FILE_BYTES || 5 * 1024 * 1024);
const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!AVATAR_MIME_TYPES.includes(String(file.mimetype).toLowerCase())) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    return cb(null, true);
  },
});

// Express middleware: single file field "avatar", with friendly JSON errors instead of a stack trace.
function avatarUploadMiddleware(req, res, next) {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (!err) return next();
    let message = 'Could not read the photo. Please try another one.';
    if (err.code === 'LIMIT_FILE_SIZE') message = `Photo is too large (max ${Math.round(AVATAR_MAX_BYTES / (1024 * 1024))} MB).`;
    else if (String(err.message || '').startsWith('Unsupported file type')) message = 'Please choose a JPG, PNG, WebP or HEIC photo.';
    return res.status(400).json({ error: message });
  });
}

// Crops to a square, strips metadata (EXIF location etc.), stores privately. Returns the new object key.
async function saveAvatar(userId, file) {
  const optimized = await optimizeUpload({
    buffer: file.buffer,
    mime: String(file.mimetype).toLowerCase(),
    maxWidth: AVATAR_SIZE,
    maxHeight: AVATAR_SIZE,
    quality: 82,
    format: 'webp',
    fit: 'cover',
  });
  const key = `avatars/${userId}/${crypto.randomUUID()}.webp`;
  await uploadPrivateObject({ key, buffer: optimized.buffer, contentType: optimized.contentType });
  return key;
}

async function removeAvatarObject(key) {
  if (!key) return;
  try {
    await deletePrivateObject(key);
  } catch (_) {
    // An orphaned object is harmless; never fail a profile update because cleanup failed.
  }
}

module.exports = { avatarUploadMiddleware, saveAvatar, removeAvatarObject, AVATAR_MAX_BYTES, AVATAR_MIME_TYPES };
