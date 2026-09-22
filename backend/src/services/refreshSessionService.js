const crypto = require('crypto');

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newSessionId() {
  return crypto.randomUUID();
}

async function createRefreshSession(prisma, {
  userId,
  sessionId = newSessionId(),
  familyId = sessionId,
  refreshToken,
  userAgent,
  ipAddress,
  expiresAt = new Date(Date.now() + REFRESH_TTL_MS),
}) {
  return prisma.refreshSession.create({
    data: {
      id: sessionId,
      userId,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      userAgent: userAgent || null,
      ipAddress: ipAddress || null,
    },
  });
}

async function revokeSession(prisma, sessionId, reason = 'logout') {
  if (!sessionId) return;
  await prisma.refreshSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

async function revokeAllSessions(prisma, userId, reason = 'security') {
  return prisma.refreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

async function revokeFamily(prisma, familyId, reason = 'refresh-token-reuse') {
  return prisma.refreshSession.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

async function rotateRefreshSession(prisma, session, refreshToken, nextRefreshToken, nextExpiresAt, nextSessionId = newSessionId()) {
  const now = new Date();
  const nextHash = hashRefreshToken(nextRefreshToken);

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.refreshSession.findUnique({ where: { id: session.id } });
    if (!current) return { ok: false, reason: 'not-found' };

    if (current.revokedAt || current.rotatedAt || current.expiresAt <= now) {
      await tx.refreshSession.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'refresh-token-reuse' },
      });
      return { ok: false, reason: 'reused-or-expired' };
    }

    if (current.tokenHash !== hashRefreshToken(refreshToken)) {
      await tx.refreshSession.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'refresh-token-reuse' },
      });
      return { ok: false, reason: 'reuse-detected' };
    }

    const claimed = await tx.refreshSession.updateMany({
      where: { id: current.id, tokenHash: current.tokenHash, revokedAt: null, rotatedAt: null },
      data: { rotatedAt: now, lastUsedAt: now },
    });

    if (claimed.count !== 1) {
      await tx.refreshSession.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'refresh-token-reuse' },
      });
      return { ok: false, reason: 'concurrent-reuse' };
    }

    await tx.refreshSession.create({
      data: {
        id: nextSessionId,
        userId: current.userId,
        familyId: current.familyId,
        tokenHash: nextHash,
        expiresAt: nextExpiresAt,
        userAgent: current.userAgent,
        ipAddress: current.ipAddress,
      },
    });

    return { ok: true };
  }, { maxWait: 10000, timeout: 15000 });

  return result;
}

module.exports = {
  REFRESH_TTL_MS,
  hashRefreshToken,
  newSessionId,
  createRefreshSession,
  rotateRefreshSession,
  revokeSession,
  revokeAllSessions,
  revokeFamily,
};
