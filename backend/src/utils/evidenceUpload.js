'use strict';

const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const { uploadPrivateObject } = require('./objectStorage');
const { optimizeUpload } = require('./imageProcessor');

const MAX_BYTES = Number(process.env.EVIDENCE_MAX_FILE_BYTES || 15 * 1024 * 1024);
const MAX_FILES = Number(process.env.EVIDENCE_MAX_FILES || 5);

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'video/mp4', 'video/quicktime',
];

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  },
});

function safeExtension(name = '') {
  const ext = path.extname(name).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function makeEvidenceKey(namespace, resourceId, originalName, extensionOverride) {
  const ext = extensionOverride || safeExtension(originalName);
  return `evidence/${namespace}/${resourceId}/${crypto.randomUUID()}${ext}`;
}

async function uploadEvidenceFiles(namespace, resourceId, files = []) {
  const photoKeys = [];
  const videoKeys = [];
  const mediaStats = [];

  for (const file of files) {
    if (file.mimetype.startsWith('image/')) {
      const optimized = await optimizeUpload({
        buffer: file.buffer,
        mime: file.mimetype,
        maxWidth: Number(process.env.EVIDENCE_IMAGE_MAX_WIDTH || 1920),
        maxHeight: Number(process.env.EVIDENCE_IMAGE_MAX_HEIGHT || 1920),
        quality: Number(process.env.EVIDENCE_IMAGE_QUALITY || 82),
      });
      const key = makeEvidenceKey(namespace, resourceId, file.originalname, optimized.extension);
      await uploadPrivateObject({ key, buffer: optimized.buffer, contentType: optimized.contentType });
      photoKeys.push(key);
      mediaStats.push({ type: 'image', originalBytes: optimized.originalBytes, optimizedBytes: optimized.optimizedBytes, width: optimized.width, height: optimized.height });
    } else {
      const key = makeEvidenceKey(namespace, resourceId, file.originalname);
      await uploadPrivateObject({ key, buffer: file.buffer, contentType: file.mimetype });
      videoKeys.push(key);
      mediaStats.push({ type: 'video', originalBytes: file.size, optimizedBytes: file.size });
    }
  }

  return { photoKeys, videoKeys, mediaStats };
}

module.exports = { evidenceUpload, uploadEvidenceFiles };
