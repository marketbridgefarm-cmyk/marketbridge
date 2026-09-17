#!/usr/bin/env node
'use strict';

/**
 * Off-site storage helper for database backups.
 *
 * Reuses the same S3_* env vars as src/utils/objectStorage.js (region,
 * endpoint, force-path-style, credentials) so backups can live in the
 * existing R2/S3 bucket under a dedicated prefix, or in a separate bucket
 * via S3_BACKUP_BUCKET.
 *
 * Why this exists: backend/scripts/backup-postgres.sh previously only
 * wrote dumps to local disk. On Render (and most PaaS hosts) the
 * filesystem is ephemeral — it does not survive a redeploy or restart —
 * so a "backup" that only ever lands on local disk can silently vanish
 * before anyone needs it. This gives the backup script a durable target.
 *
 * Usage:
 *   node scripts/backupStorage.js upload <localFilePath>
 *   node scripts/backupStorage.js download <key> <destFilePath>
 *   node scripts/backupStorage.js list
 *   node scripts/backupStorage.js prune [retentionDays]
 *
 * If S3 credentials aren't configured, upload/list/prune warn and exit 0
 * (off-site copy is a best-effort enhancement on top of the verified local
 * dump, not a hard requirement) — download exits non-zero since there is
 * nothing to restore from in that case.
 */

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const PREFIX = 'db-backups/';

function config() {
  const bucket = process.env.S3_BACKUP_BUCKET || process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    accessKeyId,
    secretAccessKey,
  };
}

function client(cfg) {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

async function upload(localFile) {
  const cfg = config();
  if (!cfg) {
    console.warn(
      'S3 backup storage not configured (need S3_BACKUP_BUCKET or S3_BUCKET, S3_REGION, ' +
      'S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) — backup stayed local-only.'
    );
    return;
  }
  const key = PREFIX + path.basename(localFile);
  const body = fs.readFileSync(localFile);
  await client(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body }));
  console.log(`Uploaded to s3://${cfg.bucket}/${key}`);
}

async function list() {
  const cfg = config();
  if (!cfg) {
    console.warn('S3 backup storage not configured — nothing to list.');
    return [];
  }
  const c = client(cfg);
  let items = [];
  let ContinuationToken;
  do {
    const res = await c.send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: PREFIX, ContinuationToken })
    );
    items = items.concat(res.Contents || []);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  items.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  return items;
}

async function download(key, destFile) {
  const cfg = config();
  if (!cfg) {
    console.error('S3 backup storage not configured — cannot download.');
    process.exit(1);
  }
  const fullKey = key.startsWith(PREFIX) ? key : PREFIX + key;
  const res = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: fullKey }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  fs.writeFileSync(destFile, Buffer.concat(chunks));
  console.log(`Downloaded s3://${cfg.bucket}/${fullKey} -> ${destFile}`);
}

async function prune(retentionDays) {
  const cfg = config();
  if (!cfg) return;
  const items = await list();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const c = client(cfg);
  let deleted = 0;
  for (const item of items) {
    if (new Date(item.LastModified).getTime() < cutoff) {
      await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: item.Key }));
      deleted += 1;
    }
  }
  console.log(`Pruned ${deleted} remote backup(s) older than ${retentionDays} day(s).`);
}

async function main() {
  const [, , cmd, arg1, arg2] = process.argv;
  if (cmd === 'upload') {
    if (!arg1) throw new Error('Usage: backupStorage.js upload <localFile>');
    await upload(arg1);
  } else if (cmd === 'download') {
    if (!arg1 || !arg2) throw new Error('Usage: backupStorage.js download <key> <destFile>');
    await download(arg1, arg2);
  } else if (cmd === 'list') {
    const items = await list();
    for (const item of items) console.log(`${item.Key}\t${item.LastModified}\t${item.Size}`);
  } else if (cmd === 'prune') {
    const days = Number(arg1 || process.env.BACKUP_RETENTION_DAYS || 14);
    await prune(days);
  } else {
    console.error('Usage: backupStorage.js <upload|download|list|prune> [...args]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
