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
const {
  generateSecret,
  buildOtpAuthUri,
  generateQrCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  hashBackupCodes,
  findMatchingBackupCodeIndex,
} = require('../services/mfaService');
const { createResetToken, consumeResetToken } = require('../services/passwordResetService');
const { sendMail } = require('../utils/mailer');
const { normalizeEthiopianPhone } = require('../services/smsService');
const { SUPPORTED_SMS_LANGUAGES } = require('../services/notificationCopy');

const router = express.Router();

const OPTIONAL_ROLES = ['INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER'];
const DEFAULT_ROLES = ['BUYER', 'SELLER'];

// Bcrypt cost factor. 10 rounds is the industry standard (OWASP, Laravel,
// Rails, Django) and takes ~600ms on Render's free-tier CPU. Anything
// higher (11-14) makes login noticeably slow on 0.5 CPU instances.
// Existing hashes with a higher round count are auto-upgraded on next
// successful login (see the login handler below).
const BCRYPT_ROUNDS = 10;

// Refresh tokens live in an HttpOnly cookie, never in the JSON response body
// or localStorage — this is what keeps a stolen/XSS'd page from being able
// to mint fresh sessions indefinitely.
const REFRESH_COOKIE_NAME = 'mb_refresh';
const isProduction = process.env.NODE_ENV === 'production';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
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

// CSRF hardening for the two cookie-authenticated endpoints.
const trustedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

function requireTrustedOrigin(req, res, next) {
  if (!isProduction || trustedOrigins.length === 0) return next();

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  let candidate = origin || null;
  if (!candidate && referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = null;
    }
  }

  if (candidate && trustedOrigins.includes(candidate)) return next();

  return res.status(403).json({ error: 'Request origin not allowed', code: 'UNTRUSTED_ORIGIN' });
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
  const { passwordHash, mfaSecret, mfaBackupCodes, ...rest } = user;
  return rest;
}

// Short-lived, single-purpose token: proves "this device just supplied the
// correct password for this account" without yet granting a session.
const MFA_CHALLENGE_TTL = '5m';

function signMfaChallenge(user) {
  return jwt.sign(
    { sub: user.id, type: 'mfa_challenge' },
    process.env.JWT_SECRET,
    { expiresIn: MFA_CHALLENGE_TTL, algorithm: 'HS256' }
  );
}

function verifyMfaChallenge(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.type !== 'mfa_challenge' || !payload.sub) {
    throw new Error('Not an MFA challenge token');
  }
  return payload.sub;
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

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await prisma.user.create({
        data: { name, email, phone, passwordHash, roles, location },
      });

      const session = await issueSession(user, req);
      setRefreshCookie(res, session.refreshToken);
      return res.status(201).json({ user: sanitize(user), token: session.token, expiresIn: session.expiresIn });
    } catch (error) {
      req.log.error({ err: error }, 'Register error:');
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

      // Auto-upgrade password hash if it was created with an older/higher
      // bcrypt cost factor. bcrypt stores the round count inside the hash
      // itself (the "$12$" prefix), so we can read it and quietly re-hash
      // the password at the current standard. The first login after this
      // change takes the old time; every login after that is fast.
      const currentRounds = Number.parseInt(String(user.passwordHash).split('$')[2], 10);
      if (Number.isFinite(currentRounds) && currentRounds > BCRYPT_ROUNDS) {
        try {
          const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
          await prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: upgraded },
          });
        } catch (rehashError) {
          // Never fail a valid login because of a rehash hiccup.
          req.log.error({ err: rehashError, userId: user.id }, 'Password rehash on login failed');
        }
      }

      if (user.accountStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
      }

      // MFA-enabled accounts don't get a session from a password alone.
      if (user.mfaEnabled) {
        return res.json({
          mfaRequired: true,
          challengeToken: signMfaChallenge(user),
        });
      }

      const session = await issueSession(user, req);
      setRefreshCookie(res, session.refreshToken);
      return res.json({ user: sanitize(user), token: session.token, expiresIn: session.expiresIn });
    } catch (error) {
      req.log.error({ err: error }, 'Login error:');
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Refresh token: persistent session + one-time rotation.
router.post('/refresh', authLimiter, requireTrustedOrigin, async (req, res) => {
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
    req.log.error({ err: error }, 'Refresh token error:');
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: sanitize(req.user) });
});

// Notification/localization preferences.
router.patch(
  '/me/preferences',
  authenticate,
  [
    body('smsNotificationsEnabled').optional().isBoolean(),
    body('preferredLanguage').optional().isIn(SUPPORTED_SMS_LANGUAGES),
    body('phone').optional({ nullable: true }).isString().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const { smsNotificationsEnabled, preferredLanguage, phone } = req.body;

      if (smsNotificationsEnabled === true) {
        const effectivePhone = phone !== undefined ? phone : req.user.phone;
        if (!normalizeEthiopianPhone(effectivePhone)) {
          return res.status(400).json({ error: 'A valid Ethiopian phone number is required to enable SMS notifications.' });
        }
      }

      const user = await prisma.user.update({
        where: { id: req.user.id },
        data: {
          ...(smsNotificationsEnabled !== undefined && { smsNotificationsEnabled }),
          ...(preferredLanguage !== undefined && { preferredLanguage }),
          ...(phone !== undefined && { phone: phone || null }),
        },
      });

      return res.json({ user: sanitize(user) });
    } catch (error) {
      req.log.error({ err: error }, 'Update preferences error:');
      return res.status(500).json({ error: 'Could not update preferences' });
    }
  }
);

// Revoke only the current persistent session.
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

// ============================================================================
// MULTI-FACTOR AUTHENTICATION (TOTP)
// ============================================================================

router.post(
  '/mfa/verify-login',
  authLimiter,
  [
    body('challengeToken').isString().notEmpty(),
    body('code').isString().trim().isLength({ min: 4, max: 12 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      let userId;
      try {
        userId = verifyMfaChallenge(req.body.challengeToken);
      } catch {
        return res.status(401).json({ error: 'This login attempt has expired. Please log in again.', code: 'MFA_CHALLENGE_EXPIRED' });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.mfaEnabled) {
        return res.status(401).json({ error: 'Invalid login attempt' });
      }

      if (user.accountStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
      }

      const code = req.body.code;
      let usedBackupCode = false;

      if (!verifyTotp(user.mfaSecret, code)) {
        const backupIndex = await findMatchingBackupCodeIndex(user.mfaBackupCodes, code);
        if (backupIndex === -1) {
          return res.status(401).json({ error: 'Invalid authentication code', code: 'INVALID_MFA_CODE' });
        }
        usedBackupCode = true;
        const remaining = [...user.mfaBackupCodes];
        remaining.splice(backupIndex, 1);
        await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodes: remaining } });
      }

      const session = await issueSession(user, req);
      setRefreshCookie(res, session.refreshToken);
      return res.json({
        user: sanitize(user),
        token: session.token,
        expiresIn: session.expiresIn,
        usedBackupCode,
      });
    } catch (error) {
      req.log.error({ err: error }, 'MFA verify-login error:');
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

router.get('/mfa/status', authenticate, async (req, res) => {
  res.json({
    mfaEnabled: req.user.mfaEnabled,
    remainingBackupCodes: req.user.mfaEnabled ? req.user.mfaBackupCodes.length : null,
  });
});

router.post('/mfa/setup', authenticate, async (req, res) => {
  try {
    if (req.user.mfaEnabled) {
      return res.status(409).json({ error: 'MFA is already enabled on this account. Disable it first to re-enroll.' });
    }

    const secret = generateSecret();
    await prisma.user.update({ where: { id: req.user.id }, data: { mfaSecret: secret } });

    const otpAuthUri = buildOtpAuthUri(req.user.email, secret);
    const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUri);

    return res.json({ secret, otpAuthUri, qrCodeDataUrl });
  } catch (error) {
    req.log.error({ err: error }, 'MFA setup error:');
    return res.status(500).json({ error: 'Could not start MFA setup' });
  }
});

router.post(
  '/mfa/verify-setup',
  authenticate,
  [
    body('code').isString().trim().isLength({ min: 4, max: 12 }),
    body('password').isString().notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      if (req.user.mfaEnabled) {
        return res.status(409).json({ error: 'MFA is already enabled on this account.' });
      }

      if (!req.user.mfaSecret) {
        return res.status(400).json({ error: 'No MFA setup in progress. Call /auth/mfa/setup first.' });
      }

      const passwordOk = await bcrypt.compare(req.body.password, req.user.passwordHash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Incorrect password' });
      }

      if (!verifyTotp(req.user.mfaSecret, req.body.code)) {
        return res.status(400).json({ error: 'That code did not match. Check the time on your device and try again.', code: 'INVALID_MFA_CODE' });
      }

      const backupCodes = generateBackupCodes();
      const hashed = await hashBackupCodes(backupCodes);

      await prisma.user.update({
        where: { id: req.user.id },
        data: { mfaEnabled: true, mfaBackupCodes: hashed },
      });

      return res.json({
        message: 'MFA is now enabled on your account.',
        backupCodes,
      });
    } catch (error) {
      req.log.error({ err: error }, 'MFA verify-setup error:');
      return res.status(500).json({ error: 'Could not enable MFA' });
    }
  }
);

router.post(
  '/mfa/disable',
  authenticate,
  [
    body('password').isString().notEmpty(),
    body('code').isString().trim().isLength({ min: 4, max: 12 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      if (!req.user.mfaEnabled) {
        return res.status(400).json({ error: 'MFA is not enabled on this account.' });
      }

      const passwordOk = await bcrypt.compare(req.body.password, req.user.passwordHash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Incorrect password' });
      }

      let codeOk = verifyTotp(req.user.mfaSecret, req.body.code);
      if (!codeOk) {
        codeOk = (await findMatchingBackupCodeIndex(req.user.mfaBackupCodes, req.body.code)) !== -1;
      }
      if (!codeOk) {
        return res.status(401).json({ error: 'Invalid authentication code', code: 'INVALID_MFA_CODE' });
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
      });

      return res.json({ message: 'MFA has been disabled on your account.' });
    } catch (error) {
      req.log.error({ err: error }, 'MFA disable error:');
      return res.status(500).json({ error: 'Could not disable MFA' });
    }
  }
);

// ============================================================================
// PASSWORD RECOVERY
// ============================================================================

router.post(
  '/forgot-password',
  authLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const genericResponse = { message: 'If that email is registered, a password reset link has been sent.' };

      const user = await prisma.user.findUnique({ where: { email: req.body.email } });
      if (!user || user.accountStatus === 'SUSPENDED') {
        return res.json(genericResponse);
      }

      const rawToken = await createResetToken(prisma, { userId: user.id, requestedIp: requestIp(req) });
      const resetUrl = `${(process.env.APP_BASE_URL || '').replace(/\/$/, '')}/reset-password?token=${rawToken}`;

      try {
        await sendMail({
          to: user.email,
          subject: 'Reset your MarketBridge password',
          text: `We received a request to reset your MarketBridge password. This link expires in 30 minutes:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
          html: `<p>We received a request to reset your MarketBridge password. This link expires in 30 minutes:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
        });
      } catch (mailError) {
        req.log.error({ err: mailError, userId: user.id }, 'Password-reset email failed to send');
      }

      return res.json({
        ...genericResponse,
        ...(isProduction ? {} : { devResetUrl: resetUrl, devToken: rawToken }),
      });
    } catch (error) {
      req.log.error({ err: error }, 'Forgot-password error:');
      return res.status(500).json({ error: 'Could not process password reset request' });
    }
  }
);

router.post(
  '/reset-password',
  authLimiter,
  [
    body('token').isString().notEmpty(),
    body('password').isString().isLength({ min: 8, max: 128 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
      }

      const result = await prisma.$transaction(async (tx) => {
        const userId = await consumeResetToken(tx, req.body.token);
        if (!userId) return null;

        const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
        const user = await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        return user;
      }, { maxWait: 10000, timeout: 15000 });

      if (!result) {
        return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.', code: 'INVALID_RESET_TOKEN' });
      }

      await revokeAllSessions(prisma, result.id, 'password-reset');

      return res.json({ message: 'Your password has been reset. Please log in again.' });
    } catch (error) {
      req.log.error({ err: error }, 'Reset-password error:');
      return res.status(500).json({ error: 'Could not reset password' });
    }
  }
);

module.exports = router;
