'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');

const ISSUER = 'MarketBridge';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BACKUP_CODE_COUNT = 10;

// otplib defaults to a 30s step with a +/-1 step window, which is what
// every mainstream authenticator app (Google/Microsoft/Authy) assumes.
authenticator.options = { window: 1 };

function generateTotpSecret() {
  return authenticator.generateSecret();
}

function buildOtpauthUrl(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

function verifyTotp(encryptedSecret, code) {
  if (!encryptedSecret || !code) return false;
  try {
    const secret = decryptSecret(encryptedSecret);
    return authenticator.check(String(code).trim(), secret);
  } catch (error) {
    return false;
  }
}

function encryptTotpSecret(plainSecret) {
  return encryptSecret(plainSecret);
}

// Six-digit numeric code for the email-fallback factor. Stored bcrypt-hashed
// like a password, at a lower cost factor since it's single-use and expires
// in minutes — the hashing here is about not leaving a plaintext code
// sitting in the database, not about resisting years of offline attack.
function generateEmailOtp() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  return {
    code,
    expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS),
  };
}

async function hashCode(code) {
  return bcrypt.hash(code, 10);
}

async function compareCode(code, hash) {
  if (!code || !hash) return false;
  return bcrypt.compare(String(code).trim(), hash);
}

// Backup codes are shown once, in plaintext, immediately after MFA setup is
// confirmed — after that only their bcrypt hashes exist. Format is
// grouped (XXXX-XXXX) purely for readability when copying them down.
async function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
  return { codes, hashed };
}

module.exports = {
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  encryptTotpSecret,
  generateEmailOtp,
  hashCode,
  compareCode,
  generateBackupCodes,
};
