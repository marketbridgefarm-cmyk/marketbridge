const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const {
  REFRESH_TTL_MS,
  createRefreshSession,
  rotateRefreshSession,
  revokeSession,
  revokeFamily,
  revokeAllSessions,
  newSessionId,
} = require('../services/refreshSessionService');

const router = express.Router();

const OPTIONAL_ROLES = ['INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER'];
const DEFAULT_ROLES = ['BUYER', 'SELLER'];

function signToken(user, sessionId) {
  return jwt.sign({ sub: user.id, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    algorithm: 'HS256',
  });
}

function signRefreshToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, sid: sessionId, type: 'refresh', jti: sessionId },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    {
      expiresIn: Math.floor(REFRESH_TTL_MS / 1000),
      algorithm: 'HS256',
    }
  );
}

function sanitize(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

function requestIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function requestMeta(req) {
  return {
    userAgent: typeof req.get === 'function' ? req.get('user-agent') : null,
    ipAddress: requestIp(req),
  };
}

async function issueSession(user, req) {
  const sessionId = newSessionId();
  const refreshToken = signRefreshToken(user, sessionId);
  await createRefreshSession(prisma, {
    userId: user.id,
    sessionId,
    refreshToken,
    ...requestMeta(req),
  });

  return {
    token: signToken(user, sessionId),
    refreshToken,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  };
}

// Register
router.post(
  '/register',
  authLimiter,
  [
    body('name').isString().trim().isLength({ min: 2, max: 120 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 8, max: 128 }),
    body('phone').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
    body('location').optional({ values: 'falsy' }).isString().trim().isLength({ max: 200 }),
    body('roles').optional().isArray(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const { name, email, phone, password, location } = req.body;
      const roles = Array.isArray(req.body.roles) && req.body.roles.length
        ? [...new Set(req.body.roles)]
        : [...DEFAULT_ROLES];

      const invalidRole = roles.find((r) => ![...DEFAULT_ROLES, ...OPTIONAL_ROLES].includes(r));
      if (invalidRole) {
        return res.status(400).json({ error: `Invalid role: ${invalidRole}` });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: { name, email, phone, passwordHash, roles, location },
      });

      const session = await issueSession(user, req);
      return res.status(201).json({ user: sanitize(user), ...session });
    } catch (error) {
      console.error('Register error:', error);
      return res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// Login
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 1, max: 128 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const { email, password } = req.body;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

      if (user.accountStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
      }

      const session = await issueSession(user, req);
      return res.json({ user: sanitize(user), ...session });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Refresh token: persistent session + one-time rotation.
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });

    let payload;
    try {
      payload = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
        { algorithms: ['HS256'] }
      );
    } catch (error) {
      return res.status(401).json({ error: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
    }

    if (payload.type !== 'refresh' || !payload.sub || !payload.sid || payload.jti !== payload.sid) {
      return res.status(401).json({ error: 'Refresh session is invalid or expired', code: 'INVALID_REFRESH_SESSION' });
    }

    const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.userId !== payload.sub) {
      return res.status(401).json({ error: 'Refresh session is invalid or expired', code: 'INVALID_REFRESH_SESSION' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    if (user.accountStatus === 'SUSPENDED') {
      await revokeAllSessions(prisma, user.id, 'account-suspended');
      return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
    }

    const nextSessionId = newSessionId();
    const newRefreshToken = signRefreshToken(user, nextSessionId);
    const nextExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    const rotation = await rotateRefreshSession(
      prisma,
      session,
      refreshToken,
      newRefreshToken,
      nextExpiresAt,
      nextSessionId
    );

    if (!rotation.ok) {
      return res.status(401).json({
        error: 'Refresh token is no longer valid. Please sign in again.',
        code: 'REFRESH_SESSION_REVOKED',
      });
    }

    return res.json({
      user: sanitize(user),
      token: signToken(user, nextSessionId),
      refreshToken: newRefreshToken,
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: sanitize(req.user) });
});

// Revoke only the current persistent session. Access-token session IDs are
// accepted by the auth middleware and therefore become invalid immediately.
router.post('/logout', authenticate, async (req, res) => {
  await revokeFamily(prisma, req.authSessionFamilyId, 'logout');
  res.json({ message: 'Logged out successfully' });
});

// Revoke every active refresh session for the current account.
router.post('/logout-all', authenticate, async (req, res) => {
  const result = await revokeAllSessions(prisma, req.user.id, 'logout-all');
  res.json({ message: 'All sessions have been logged out', revokedSessions: result.count });
});

module.exports = router;
