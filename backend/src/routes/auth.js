const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const OPTIONAL_ROLES = ['INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER'];
const DEFAULT_ROLES = ['BUYER', 'SELLER'];

function signToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    algorithm: 'HS256',
  });
}

function signRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    {
      expiresIn: '7d',
      algorithm: 'HS256',
    }
  );
}

function sanitize(user) {
  const { passwordHash, ...rest } = user;
  return rest;
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

      let roles = Array.isArray(req.body.roles) && req.body.roles.length
        ? [...new Set(req.body.roles)]
        : [...DEFAULT_ROLES];

      const invalidRole = roles.find((r) => ![...DEFAULT_ROLES, ...OPTIONAL_ROLES].includes(r));
      if (invalidRole) {
        return res.status(400).json({ error: `Invalid role: ${invalidRole}` });
      }

      // Check existing user
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create user
      const user = await prisma.user.create({
        data: { name, email, phone, passwordHash, roles, location },
      });

      // Generate tokens
      const token = signToken(user);
      const refreshToken = signRefreshToken(user);

      return res.status(201).json({
        user: sanitize(user),
        token,
        refreshToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '15m',
      });
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
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.accountStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
      }

      // Generate tokens
      const token = signToken(user);
      const refreshToken = signRefreshToken(user);

      return res.json({
        user: sanitize(user),
        token,
        refreshToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '15m',
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Refresh token
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    let payload;
    try {
      payload = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
        { algorithms: ['HS256'] }
      );
    } catch (error) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token type' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    if (user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
    }

    // Generate new tokens
    const token = signToken(user);
    const newRefreshToken = signRefreshToken(user);

    return res.json({
      user: sanitize(user),
      token,
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

// Logout (client-side token removal, but keep endpoint for completeness)
router.post('/logout', authenticate, async (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
