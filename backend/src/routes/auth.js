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

function sanitize(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

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
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, phone, password, location } = req.body;
    let roles = Array.isArray(req.body.roles) && req.body.roles.length ? [...new Set(req.body.roles)] : [...DEFAULT_ROLES];
    const invalidRole = roles.find((r) => ![...DEFAULT_ROLES, ...OPTIONAL_ROLES].includes(r));
    if (invalidRole) return res.status(400).json({ error: `Invalid role: ${invalidRole}` });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, roles, location },
    });

    res.status(201).json({ user: sanitize(user), token: signToken(user) });
  }
);

router.post('/login', authLimiter, [body('email').isEmail().normalizeEmail(), body('password').isString().isLength({ min: 1, max: 128 })], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  res.json({ user: sanitize(user), token: signToken(user) });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: sanitize(req.user) });
});

module.exports = router;
