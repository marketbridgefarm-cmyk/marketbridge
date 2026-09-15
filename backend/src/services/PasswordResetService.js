'use strict';

const crypto = require('crypto');

// Deliberately short — a reset link is meant to be used within minutes of
// being requested, not saved for later. Matches the pattern already used
// for refresh-token hashing (services/refreshSessionService.js): the raw
// token goes out to the user, only its sha256 hash is ever persisted, so a
// database read alone can never be used to reset an account's password.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createResetToken(prisma, { userId, requestedIp = null }) {
  const rawToken = generateRawToken();
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      requestedIp,
    },
  });
  return rawToken;
}

/**
 * Validate and consume a reset token inside `tx`. Returns the associated
 * userId on success, or null if the token is missing/expired/already used
 * — callers should treat null as "invalid or expired link" without
 * distinguishing which, to avoid leaking whether a token ever existed.
 */
async function consumeResetToken(tx, rawToken) {
  if (!rawToken) return null;

  const record = await tx.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });

  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    return null;
  }

  await tx.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.userId;
}

module.exports = { createResetToken, consumeResetToken, RESET_TOKEN_TTL_MS };
