const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const required = ['S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'];
function config() {
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Object storage is not configured: missing ${missing.join(', ')}`);
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
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    // Cloudflare R2's S3-compatible API returns 501 NotImplemented for the
    // checksum headers newer AWS SDK versions attach by default, and does
    // not support AWS's SSE-S3 parameter (R2 encrypts at rest regardless).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
function safeExtension(name='') {
  const ext = path.extname(name).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(ext) ? ext : '';
}
function makeDigitalKey(productId, originalName) {
  return `digital-products/${productId}/${crypto.randomUUID()}${safeExtension(originalName)}`;
}
async function uploadPrivateObject({ key, buffer, contentType }) {
  const c = config();
  await client().send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream' }));
}
async function deletePrivateObject(key) {
  if (!key) return;
  const c = config();
  await client().send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
}
async function signedDownloadUrl({ key, fileName, contentType }) {
  const c = config();
  const expires = Math.min(Math.max(Number(process.env.DIGITAL_DOWNLOAD_EXPIRES_SECONDS || 300), 60), 900);
  const safeName = String(fileName || 'download').replace(/[\"\\\r\n]/g, '_').slice(0, 180);
  const command = new (require('@aws-sdk/client-s3').GetObjectCommand)({
    Bucket: c.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });
  return getSignedUrl(client(), command, { expiresIn: expires });
}
module.exports = { config, makeDigitalKey, uploadPrivateObject, deletePrivateObject, signedDownloadUrl };
