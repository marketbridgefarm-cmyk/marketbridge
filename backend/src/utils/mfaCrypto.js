'use strict';

const crypto = require('crypto');

// AES-256-GCM at-rest encryption for TOTP secrets. A TOTP secret is a
// long-lived credential equivalent to a password — unlike passwordHash it
// can't be stored as a one-way hash, because the server has to read it back
// to compute the expected code, so it gets symmetric encryption instead of
// bcrypt. MFA_ENCRYPTION_KEY must be 32 bytes, given as base64 or hex.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce size for GCM

function loadKey() {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    throw Object.assign(new Error('MFA_ENCRYPTION_KEY is not configured'), { status: 500 });
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== 32) {
    throw Object.assign(
      new Error('MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex)'),
      { status: 500 }
    );
  }

  return key;
}

// Returns a single string "iv:authTag:ciphertext" (all base64) so it fits
// in one TEXT column without a separate schema for the nonce/tag.
function encryptSecret(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const key = loadKey();
  const parts = String(stored || '').split(':');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Malformed encrypted MFA secret'), { status: 500 });
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
