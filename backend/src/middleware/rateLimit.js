const rateLimit = require('express-rate-limit');

// General API limiter: generous, just there to blunt scraping/abuse.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// Tight limiter for auth endpoints (register/login) — these are the
// classic brute-force / credential-stuffing / fake-account targets.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please try again later.' },
});

module.exports = { apiLimiter, authLimiter };
