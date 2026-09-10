const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const required = ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];

function config() {
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Object storage is not configured: missing ${missing.join(', ')}`);
  }
  return {
    region: process.env.S3_REGION,
    bucket: process.env.S3_BUCKET,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
  };
}

function client() {
  const c = config();
  return new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function safeExtension(name = '') {
  const ext = path.extname(name).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function makeDigitalKey(productId, originalName) {
  return `digital-products/${productId}/${crypto.randomUUID()}${safeExtension(originalName)}`;
}

async function uploadPrivateObject({ key, buffer, contentType }) {
  const c = config();
  await client().send(new PutObjectCommand({
    Bucket: c.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
}

async function deletePrivateObject(key) {
  if (!key) return;
  const c = config();
  await client().send(new DeleteObjectCommand({
    Bucket: c.bucket,
    Key: key,
  }));
}


function normalizePrivateKey(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.includes('\r') || raw.includes('\n')) return null;
  const c = config();
  if (raw.startsWith('s3://')) {
    const rest = raw.slice(5);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const bucket = rest.slice(0, slash);
    if (bucket !== c.bucket) return null;
    return decodeURIComponent(rest.slice(slash + 1));
  }
  if (/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/^\/+/, '');
}

async function privateMediaMetadata(key) {
  const normalized = normalizePrivateKey(key);
  if (!normalized) throw new Error('Media reference is not a private object-storage key');
  const c = config();
  const result = await client().send(new HeadObjectCommand({ Bucket: c.bucket, Key: normalized }));
  return {
    key: normalized,
    contentType: result.ContentType || null,
    contentLength: result.ContentLength ?? null,
    etag: result.ETag || null,
    lastModified: result.LastModified || null,
  };
}

async function signedMediaUrl({ key, fileName, contentType, disposition = 'inline' }) {
  const normalized = normalizePrivateKey(key);
  if (!normalized) throw new Error('Media reference is not a private object-storage key');
  const c = config();
  const expires = Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900);
  const safeName = String(fileName || 'media').replace(/[\"\\\r\n]/g, '_').slice(0, 180);
  const safeDisposition = disposition === 'attachment' ? 'attachment' : 'inline';
  const command = new GetObjectCommand({
    Bucket: c.bucket,
    Key: normalized,
    ResponseContentDisposition: `${safeDisposition}; filename="${safeName}"`,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });
  return getSignedUrl(client(), command, { expiresIn: expires });
}

async function signedDownloadUrl({ key, fileName, contentType }) {
  const c = config();
  const expires = Math.min(Math.max(Number(process.env.DIGITAL_DOWNLOAD_EXPIRES_SECONDS || 300), 60), 900);
  const safeName = String(fileName || 'download').replace(/[\"\\\r\n]/g, '_').slice(0, 180);
  const command = new GetObjectCommand({
    Bucket: c.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });
  return getSignedUrl(client(), command, { expiresIn: expires });
}

module.exports = { config, makeDigitalKey, uploadPrivateObject, deletePrivateObject, signedDownloadUrl, normalizePrivateKey, privateMediaMetadata, signedMediaUrl };
