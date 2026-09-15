'use strict';

// Access-token authentication middleware.
//
// This is deliberately separate from routes/auth.js (which issues tokens,
// handles login/register/MFA/password-reset). This file only verifies an
// already-issued access token on incoming requests and attaches the user
// (and current session) to `req`.
//
// Contract (see test/security.test.js and test/auth.sessions.test.js):
//   - getBearerToken(req): extracts the token from `Authorization: Bearer <token>`,
//     or null if missing/malformed.
//   - authenticate(req, res, next): 401 with no/garbage/expired token,
//     500 (fail closed) if JWT_SECRET is missing or too short, otherwise
//     attaches req.user / req.authSessionId / req.authSessionFamilyId and
//     calls next(). Also rejects tokens whose backing RefreshSession has
//     been revoked (e.g. after logout) with 401 SESSION_REVOKED, matching
//     "logout revokes the current session and its access token".
//   - optionalAuthenticate(req, res, next): same lookup, but never blocks
//     the request — falls back to req.user = null for any missing/invalid/
//     revoked/expired token, since it's used on public endpoints.

const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

const MIN_SECRET_LENGTH = 32;

function getBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;

  return token;
}

// Verifies the access token and resolves the user + session behind it.
//
// Returns:
//   { ok: true, user, sessionId, familyId }
//   { ok: false, reason: 'invalid' }   -- bad signature, malformed, wrong type
//   { ok: false, reason: 'revoked' }   -- session was logged out / revoked
//   { ok: false, reason: 'no-user' }   -- user no longer exists
//   { ok: false, reason: 'suspended', user }
//
// Throws only for the fail-closed case (missing/short JWT_SECRET), since
// that's a server misconfiguration rather than a client-facing 401.
async function resolveSession(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    const error = new Error('JWT_SECRET is not configured (or is too short) — refusing to authenticate.');
    error.status = 500;
    throw error;
  }

  let payload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (error) {
    return { ok: false, reason: 'invalid' };
  }

  // Only plain access tokens are accepted here. Refresh tokens (`type:
  // 'refresh'`) and MFA challenge tokens (`type: 'mfa_challenge'`) are
  // single-purpose and only valid at their own endpoints.
  if (payload.type || !payload.sub || !payload.sid) {
    return { ok: false, reason: 'invalid' };
  }

  const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
  if (!session || session.userId !== payload.sub || session.revokedAt) {
    return { ok: false, reason: 'revoked' };
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    return { ok: false, reason: 'no-user' };
  }

  if (user.accountStatus === 'SUSPENDED') {
    return { ok: false, reason: 'suspended', user };
  }

  return {
    ok: true,
    user,
    sessionId: payload.sid,
    familyId: session.familyId,
  };
}

async function authenticate(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required', code: 'NOT_AUTHENTICATED' });
    }

    const result = await resolveSession(token);

    if (!result.ok) {
      if (result.reason === 'revoked') {
        return res.status(401).json({
          error: 'Your session has been signed out. Please log in again.',
          code: 'SESSION_REVOKED',
        });
      }

      if (result.reason === 'suspended') {
        return res.status(403).json({
          error: 'This account has been suspended. Contact support for assistance.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }

      return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    }

    req.user = result.user;
    req.authSessionId = result.sessionId;
    req.authSessionFamilyId = result.familyId;

    return next();
  } catch (error) {
    if (error.status === 500) {
      console.error('authenticate() misconfiguration:', error.message);
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    console.error('authenticate() error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

async function optionalAuthenticate(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      req.user = null;
      return next();
    }

    const result = await resolveSession(token);

    if (!result.ok) {
      // Public endpoint — an expired/invalid/revoked token just means
      // "browse as a guest", not a hard failure.
      req.user = null;
      return next();
    }

    req.user = result.user;
    req.authSessionId = result.sessionId;
    req.authSessionFamilyId = result.familyId;

    return next();
  } catch (error) {
    if (error.status === 500) {
      console.error('optionalAuthenticate() misconfiguration:', error.message);
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    console.error('optionalAuthenticate() error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  getBearerToken,
};
