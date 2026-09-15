'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

// A ±1 step window (this codebase's otplib default: 30s steps) tolerates
// ordinary clock drift between the server and the user's phone without
// meaningfully weakening the code — each accepted window is still only 30s
// wide, just centered slightly differently.
authenticator.options = { window: 1 };

const ISSUER = 'MarketBridge';
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateSecret() {
  return authenticator.generateSecret();
}

function buildOtpAuthUri(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

async function generateQrCodeDataUrl(otpAuthUri) {
  return QRCode.toDataURL(otpAuthUri);
}

function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  try {
    return authenticator.check(String(code).trim(), secret);
  } catch {
    return false;
  }
}

function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    const bytes = crypto.randomBytes(10);
    for (let j = 0; j < 10; j += 1) {
      code += BACKUP_CODE_ALPHABET[bytes[j] % BACKUP_CODE_ALPHABET.length];
    }
    // XXXXX-XXXXX is easier to read/type back than one 10-character block.
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

async function hashBackupCodes(plainCodes) {
  return Promise.all(plainCodes.map((code) => bcrypt.hash(code, 10)));
}

/**
 * Check `code` against the user's stored (bcrypt-hashed) backup codes.
 * Returns the index of the matching hash so the caller can remove it
 * (backup codes are one-time use), or -1 if there's no match.
 */
async function findMatchingBackupCodeIndex(hashedCodes, code) {
  const candidate = String(code || '').trim().toUpperCase();
  if (!candidate) return -1;
  for (let i = 0; i < hashedCodes.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(candidate, hashedCodes[i])) return i;
  }
  return -1;
}

module.exports = {
  generateSecret,
  buildOtpAuthUri,
  generateQrCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  hashBackupCodes,
  findMatchingBackupCodeIndex,
};
