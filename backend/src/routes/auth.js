const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const qrcode = require('qrcode');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { authLimiter, mfaLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const { recordAuditEvent } = require('../utils/audit');
const { sendMail } = require('../utils/mailer');
const {
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  encryptTotpSecret,
  generateEmailOtp,
  hashCode,
  compareCode,
  generateBackupCodes,
} = require('../utils/mfa');
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

// How long a login-time MFA challenge stays valid. Deliberately short: the
// user is mid-login, actively holding their authenticator app or inbox.
const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

const OPTIONAL_ROLES = ['INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER'];
const DEFAULT_ROLES = ['BUYER', 'SELLER'];

// Refresh tokens live in an HttpOnly cookie, never in the JSON response body
// or localStorage — this is what keeps a stolen/XSS'd page from being able
// to mint fresh sessions indefinitely. The access token (short-lived) still
// goes back in the body for the frontend to hold in memory/localStorage,
// since its short TTL makes that an acceptable, lower-value target.
const REFRESH_COOKIE_NAME = 'mb_refresh';
const isProduction = process.env.NODE_ENV === 'production';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    // Frontend and backend are on different domains in production
    // (Vercel + Render), which requires SameSite=None + Secure for the
    // cookie to be sent at all. Locally (http, same-site) Lax is fine.
    sameSite: isProduction ? 'none' : 'lax',
    // Scoped to the auth routes only — the browser won't attach this
    // cookie to ordinary API calls, just /api/auth/refresh and /api/auth/logout.
    path: '/api/auth',
    maxAge: REFRESH_TTL_MS,
  };
}

function setRefreshCookie(res, refreshToken) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  const { maxAge, ...opts } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, opts);
}

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
      setRefreshCookie(res, session.refreshToken);
      return res.status(201).json({ user: sanitize(user), token: session.token, expiresIn: session.expiresIn });
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

      // Admin accounts with MFA confirmed don't get a session on a correct
      // password alone — a second factor is required first. No session,
      // access token, or refresh cookie is issued here; the client must
      // complete POST /auth/mfa/verify with the returned challengeId.
      if (user.roles.includes('ADMIN') && user.mfaEnabled) {
        const challenge = await prisma.mfaChallenge.create({
          data: {
            userId: user.id,
            expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
          },
        });
        return res.json({
          mfaRequired: true,
          challengeId: challenge.id,
          methods: ['totp', 'email', 'backup'],
        });
      }

      const session = await issueSession(user, req);
      setRefreshCookie(res, session.refreshToken);
      return res.json({ user: sanitize(user), token: session.token, expiresIn: session.expiresIn });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Request an email OTP for a pending MFA challenge (the fallback factor,
// used when the user doesn't have their authenticator app handy).
router.post(
  '/mfa/challenge/email',
  mfaLimiter,
  [body('challengeId').isString().trim().notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const challenge = await prisma.mfaChallenge.findUnique({ where: { id: req.body.challengeId } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
        return res.status(400).json({ error: 'This login challenge has expired. Please log in again.' });
      }

      const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
      if (!user) {
        return res.status(400).json({ error: 'This login challenge has expired. Please log in again.' });
      }

      const { code, expiresAt } = generateEmailOtp();
      await prisma.mfaChallenge.update({
        where: { id: challenge.id },
        data: { emailOtpHash: await hashCode(code), emailOtpExpiresAt: expiresAt },
      });

      await sendMail({
        to: user.email,
        subject: 'Your MarketBridge sign-in code',
        text: `Your MarketBridge verification code is ${code}. It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
      });

      return res.json({ message: 'Verification code sent' });
    } catch (error) {
      console.error('MFA email challenge error:', error);
      return res.status(500).json({ error: 'Failed to send verification code' });
    }
  }
);

// Complete a login-time MFA challenge with a TOTP code, an emailed OTP, or
// a backup code, and issue the session exactly as a normal /login would.
router.post(
  '/mfa/verify',
  mfaLimiter,
  [
    body('challengeId').isString().trim().notEmpty(),
    body('code').isString().trim().isLength({ min: 4, max: 20 }),
    body('method').isIn(['totp', 'email', 'backup']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const { challengeId, code, method } = req.body;
      const challenge = await prisma.mfaChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
        return res.status(400).json({ error: 'This login challenge has expired. Please log in again.' });
      }

      if (challenge.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
        await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
        return res.status(401).json({ error: 'Too many incorrect attempts. Please log in again.' });
      }

      const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
      if (!user || !user.mfaEnabled) {
        return res.status(400).json({ error: 'This login challenge has expired. Please log in again.' });
      }

      let ok = false;
      if (method === 'totp') {
        ok = verifyTotp(user.mfaSecret, code);
      } else if (method === 'email') {
        ok =
          !!challenge.emailOtpHash &&
          !!challenge.emailOtpExpiresAt &&
          challenge.emailOtpExpiresAt > new Date() &&
          (await compareCode(code, challenge.emailOtpHash));
      } else if (method === 'backup') {
        const unused = await prisma.mfaBackupCode.findMany({ where: { userId: user.id, usedAt: null } });
        for (const candidate of unused) {
          // eslint-disable-next-line no-await-in-loop
          if (await compareCode(code, candidate.codeHash)) {
            await prisma.mfaBackupCode.update({ where: { id: candidate.id }, data: { usedAt: new Date() } });
            ok = true;
            break;
          }
        }
      }

      if (!ok) {
        await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
        return res.status(401).json({ error: 'Incorrect code' });
      }

      await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });

      const session = await issueSession(user, req);
      setRefreshCookie(res, session.refreshToken);
      await recordAuditEvent(prisma, {
        actorId: user.id,
        action: 'MFA_LOGIN_VERIFIED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: { method },
        ...requestMeta(req),
      });
      return res.json({ user: sanitize(user), token: session.token, expiresIn: session.expiresIn });
    } catch (error) {
      console.error('MFA verify error:', error);
      return res.status(500).json({ error: 'Verification failed' });
    }
  }
);

// Begin admin MFA setup: generates a new TOTP secret (encrypted at rest),
// stores it unconfirmed, and returns everything needed to add it to an
// authenticator app. mfaEnabled stays false until /mfa/setup/confirm
// succeeds, so a half-finished setup never silently locks the account out.
router.post('/mfa/setup/start', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: req.user.id },
      data: { mfaSecret: encryptTotpSecret(secret), mfaEnabled: false, mfaConfirmedAt: null },
    });

    const otpauthUrl = buildOtpauthUrl(req.user.email, secret);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    return res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (error) {
    console.error('MFA setup start error:', error);
    return res.status(500).json({ error: 'Failed to start MFA setup' });
  }
});

// Confirm setup with a live code from the authenticator app. Success turns
// MFA on and issues one-time-viewable backup codes.
router.post(
  '/mfa/setup/confirm',
  authenticate,
  requireRole('ADMIN'),
  [body('code').isString().trim().isLength({ min: 6, max: 6 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const current = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!current?.mfaSecret) {
        return res.status(400).json({ error: 'Start MFA setup before confirming it' });
      }

      if (!verifyTotp(current.mfaSecret, req.body.code)) {
        return res.status(401).json({ error: 'Incorrect code' });
      }

      const { codes, hashed } = await generateBackupCodes();

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: req.user.id },
          data: { mfaEnabled: true, mfaConfirmedAt: new Date() },
        });
        // Setup can be re-run (e.g. switching authenticator apps); drop any
        // previous backup codes so only the newly issued set is valid.
        await tx.mfaBackupCode.deleteMany({ where: { userId: req.user.id } });
        await tx.mfaBackupCode.createMany({
          data: hashed.map((codeHash) => ({ userId: req.user.id, codeHash })),
        });
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'MFA_ENABLED',
          resourceType: 'User',
          resourceId: req.user.id,
          ...requestMeta(req),
        });
      });

      return res.json({ message: 'MFA enabled', backupCodes: codes });
    } catch (error) {
      console.error('MFA setup confirm error:', error);
      return res.status(500).json({ error: 'Failed to confirm MFA setup' });
    }
  }
);

// Disable MFA. Requires the current password as a step-up check, since this
// is a security-downgrade action on an account that (by definition, to
// reach this route) currently has MFA enabled.
router.post(
  '/mfa/disable',
  authenticate,
  requireRole('ADMIN'),
  [body('password').isString().notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const current = await prisma.user.findUnique({ where: { id: req.user.id } });
      const match = await bcrypt.compare(req.body.password, current.passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Incorrect password' });
      }

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: req.user.id },
          data: { mfaEnabled: false, mfaSecret: null, mfaConfirmedAt: null },
        });
        await tx.mfaBackupCode.deleteMany({ where: { userId: req.user.id } });
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'MFA_DISABLED',
          resourceType: 'User',
          resourceId: req.user.id,
          ...requestMeta(req),
        });
      });

      return res.json({ message: 'MFA disabled' });
    } catch (error) {
      console.error('MFA disable error:', error);
      return res.status(500).json({ error: 'Failed to disable MFA' });
    }
  }
);

// Invalidate all existing backup codes and issue a fresh set. Requires the
// current password, same reasoning as /mfa/disable.
router.post(
  '/mfa/backup-codes/regenerate',
  authenticate,
  requireRole('ADMIN'),
  [body('password').isString().notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const current = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!current.mfaEnabled) {
        return res.status(400).json({ error: 'MFA is not enabled on this account' });
      }

      const match = await bcrypt.compare(req.body.password, current.passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Incorrect password' });
      }

      const { codes, hashed } = await generateBackupCodes();
      await prisma.$transaction(async (tx) => {
        await tx.mfaBackupCode.deleteMany({ where: { userId: req.user.id } });
        await tx.mfaBackupCode.createMany({
          data: hashed.map((codeHash) => ({ userId: req.user.id, codeHash })),
        });
        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'MFA_BACKUP_CODES_REGENERATED',
          resourceType: 'User',
          resourceId: req.user.id,
          ...requestMeta(req),
        });
      });

      return res.json({ backupCodes: codes });
    } catch (error) {
      console.error('MFA backup code regeneration error:', error);
      return res.status(500).json({ error: 'Failed to regenerate backup codes' });
    }
  }
);

// Request a password reset link. Always returns the same generic response
// whether or not the email is registered, so this endpoint can't be used to
// enumerate accounts.
router.post(
  '/password/forgot',
  passwordResetLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const genericResponse = {
      message: 'If an account exists for that email, a password reset link has been sent.',
    };
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const user = await prisma.user.findUnique({ where: { email: req.body.email } });
      if (!user) {
        return res.json(genericResponse);
      }

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });

      const resetUrl = `${process.env.CLIENT_URL?.split(',')[0] || ''}/reset-password?token=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Reset your MarketBridge password',
        text: `We received a request to reset your MarketBridge password. This link expires in 30 minutes:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.`,
      });

      return res.json(genericResponse);
    } catch (error) {
      console.error('Password forgot error:', error);
      // Still return the generic response — don't leak whether the failure
      // was "no such account" vs. a server error.
      return res.json(genericResponse);
    }
  }
);

// Complete a password reset. Revokes every active refresh session for the
// account afterward, so a reset also logs the account out everywhere —
// important if the reset was triggered because credentials were exposed.
router.post(
  '/password/reset',
  passwordResetLimiter,
  [
    body('token').isString().trim().notEmpty(),
    body('password').isString().isLength({ min: 8, max: 128 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
      const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!record || record.usedAt || record.expiresAt < new Date()) {
        return res.status(400).json({ error: 'This reset link is invalid or has expired' });
      }

      const passwordHash = await bcrypt.hash(req.body.password, 12);

      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
        await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
        await recordAuditEvent(tx, {
          actorId: record.userId,
          action: 'PASSWORD_RESET',
          resourceType: 'User',
          resourceId: record.userId,
          ...requestMeta(req),
        });
      });

      await revokeAllSessions(prisma, record.userId, 'password-reset');
      return res.json({ message: 'Password updated. Please log in again.' });
    } catch (error) {
      console.error('Password reset error:', error);
      return res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

// Refresh token: persistent session + one-time rotation.
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token is required', code: 'INVALID_REFRESH_SESSION' });

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
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh session is invalid or expired', code: 'INVALID_REFRESH_SESSION' });
    }

    const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.userId !== payload.sub) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh session is invalid or expired', code: 'INVALID_REFRESH_SESSION' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'User no longer exists' });
    }

    if (user.accountStatus === 'SUSPENDED') {
      await revokeAllSessions(prisma, user.id, 'account-suspended');
      clearRefreshCookie(res);
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
      clearRefreshCookie(res);
      return res.status(401).json({
        error: 'Refresh token is no longer valid. Please sign in again.',
        code: 'REFRESH_SESSION_REVOKED',
      });
    }

    setRefreshCookie(res, newRefreshToken);
    return res.json({
      user: sanitize(user),
      token: signToken(user, nextSessionId),
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
  clearRefreshCookie(res);
  res.json({ message: 'Logged out successfully' });
});

// Revoke every active refresh session for the current account.
router.post('/logout-all', authenticate, async (req, res) => {
  const result = await revokeAllSessions(prisma, req.user.id, 'logout-all');
  clearRefreshCookie(res);
  res.json({ message: 'All sessions have been logged out', revokedSessions: result.count });
});

module.exports = router;
