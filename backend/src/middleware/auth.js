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
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    return res.status(500).json({ error: 'Server authentication is not configured securely' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.sub !== 'string') return res.status(401).json({ error: 'Invalid token subject' });
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    if (user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account has been suspended. Contact support for assistance.' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate, getBearerToken };
