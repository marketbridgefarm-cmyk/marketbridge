const rateLimit = require('express-rate-limit');

// General API limiter: generous, just there to blunt scraping/abuse.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.path === '/health', // Don't rate limit health checks
});

// Tight limiter for auth endpoints (register/login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please try again later.' },
});

// Even tighter limiter for payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please slow down.' },
});

// Webhook limiter - don't rate limit webhooks from providers
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests.' },
  skip: (req) => {
    // Skip rate limiting for verified provider webhooks
    const signature = req.headers['chapa-signature'] || req.headers['x-chapa-signature'];
    return !!signature;
  },
});

module.exports = { apiLimiter, authLimiter, paymentLimiter, webhookLimiter };
