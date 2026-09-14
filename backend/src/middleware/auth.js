const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

async function authenticate(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      code: 'NO_TOKEN',
    });
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('CRITICAL: JWT_SECRET is missing or too short');
    return res.status(500).json({
      error: 'Server authentication is not configured securely',
      code: 'SERVER_CONFIG_ERROR',
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (!payload.sub || typeof payload.sub !== 'string') {
      return res.status(401).json({
        error: 'Invalid token subject',
        code: 'INVALID_TOKEN_SUBJECT',
      });
    }

    if (payload.sid) {
      const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
      if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) {
        return res.status(401).json({
          error: 'Session is no longer valid',
          code: 'SESSION_REVOKED',
        });
      }
      req.authSessionId = session.id;
      req.authSessionFamilyId = session.familyId;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      return res.status(401).json({
        error: 'User no longer exists',
        code: 'USER_NOT_FOUND',
      });
    }

    if (user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({
        error: 'This account has been suspended. Contact support for assistance.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token has expired. Please log in again.',
        code: 'TOKEN_EXPIRED',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
    }

    console.error('Auth middleware error:', error);
    return res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
}


async function optionalAuthenticate(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return next();
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    // Public requests remain public when authentication is not configured;
    // authenticated requests cannot be trusted without a secure JWT secret.
    return res.status(500).json({
      error: 'Server authentication is not configured securely',
      code: 'SERVER_CONFIG_ERROR',
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (!payload.sub || typeof payload.sub !== 'string') {
      return res.status(401).json({
        error: 'Invalid token subject',
        code: 'INVALID_TOKEN_SUBJECT',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      return res.status(401).json({
        error: 'User no longer exists',
        code: 'USER_NOT_FOUND',
      });
    }

    if (user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({
        error: 'This account has been suspended. Contact support for assistance.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN',
      });
    }

    console.error('Optional auth middleware error:', error);
    return res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
}

module.exports = { authenticate, optionalAuthenticate, getBearerToken };
