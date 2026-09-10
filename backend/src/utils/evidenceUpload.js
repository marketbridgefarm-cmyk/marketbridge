'use strict';

const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const { uploadPrivateObject } = require('./objectStorage');

const MAX_BYTES = Number(process.env.EVIDENCE_MAX_FILE_BYTES || 15 * 1024 * 1024); // 15MB default
const MAX_FILES = Number(process.env.EVIDENCE_MAX_FILES || 5);

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
];

// Multer config shared by transport and inspection evidence uploads.
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: MAX_FILES,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

function safeExtension(name = '') {
  const ext = path.extname(name).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// Builds a private-storage key namespaced under the given resource, e.g.
// "evidence/transport/<jobId>/<uuid>.jpg" or
// "evidence/inspection/<reportId>/<uuid>.jpg".
function makeEvidenceKey(namespace, resourceId, originalName) {
  return `evidence/${namespace}/${resourceId}/${crypto.randomUUID()}${safeExtension(originalName)}`;
}

// Uploads each file in req.files to private object storage and returns
// { photoKeys, videoKeys } split by MIME type.
async function uploadEvidenceFiles(namespace, resourceId, files = []) {
  const photoKeys = [];
  const videoKeys = [];

  for (const file of files) {
    const key = makeEvidenceKey(namespace, resourceId, file.originalname);

    await uploadPrivateObject({
      key,
      buffer: file.buffer,
      contentType: file.mimetype,
    });

    if (file.mimetype.startsWith('video/')) {
      videoKeys.push(key);
    } else {
      photoKeys.push(key);
    }
  }

  return { photoKeys, videoKeys };
}

module.exports = {
  evidenceUpload,
  uploadEvidenceFiles,
};


