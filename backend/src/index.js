require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { apiLimiter, authLimiter, paymentLimiter, webhookLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const listingRoutes = require('./routes/listings');
const offerRoutes = require('./routes/offers');
const inspectionRoutes = require('./routes/inspections');
const transportRoutes = require('./routes/transport');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const adRoutes = require('./routes/ads');
const disputeRoutes = require('./routes/disputes');
const ratingRoutes = require('./routes/ratings');
const digitalRoutes = require('./routes/digital');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const chapaRoutes = require('./routes/chapa');

const prisma = require('./config/db');

const app = express();

// Trust the first proxy so Express can correctly read X-Forwarded-For
app.set('trust proxy', 1);

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const required = [
      'DATABASE_URL',
      'JWT_SECRET',
      'PAYMENT_WEBHOOK_SECRET',
      'CHAPA_SECRET_KEY',
      'CHAPA_WEBHOOK_SECRET',
      'CLIENT_URL',
      'APP_BASE_URL',
      'API_BASE_URL',
    ];

    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      console.error(`FATAL: Missing required environment variables in production: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Validate minimum lengths
    if (process.env.JWT_SECRET.length < 32) {
      console.error('FATAL: JWT_SECRET must be at least 32 characters');
      process.exit(1);
    }

    if (process.env.PAYMENT_WEBHOOK_SECRET.length < 32) {
      console.error('FATAL: PAYMENT_WEBHOOK_SECRET must be at least 32 characters');
      process.exit(1);
    }
  }
}

validateEnv();

// ============================================================================
// DATABASE CONNECTION TEST
// ============================================================================

async function testDatabase() {
  try {
    await prisma.$connect();
    console.log('✅ Database connection established');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
}

testDatabase();

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

app.use(helmet({
  contentSecurityPolicy: false, // API doesn't serve HTML
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && allowedOrigins.length === 0) {
  console.error('FATAL: CLIENT_URL is not set. Refusing to start in production with an open CORS policy.');
  process.exit(1);
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without Origin header (health checks, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Outside production, allow any origin for dev
      if (!isProduction) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked request from origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(morgan(isProduction ? 'combined' : 'dev'));

app.use(
  express.json({
    limit: '5mb',
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '5mb',
  })
);

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'marketbridge-api',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// ============================================================================
// API ROUTES
// ============================================================================

app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);

app.use('/api/listings', listingRoutes);

app.use('/api/offers', offerRoutes);

app.use('/api/inspections', inspectionRoutes);

app.use('/api/transport', transportRoutes);

app.use('/api/orders', orderRoutes);

app.use('/api/payments', paymentRoutes);

app.use('/api/payments', paymentLimiter); // Additional limiter for payment routes

app.use('/api/ads', adRoutes);

app.use('/api/disputes', disputeRoutes);

app.use('/api/ratings', ratingRoutes);

app.use('/api/digital-products', digitalRoutes);

app.use('/api/messages', messageRoutes);

app.use('/api/admin', adminRoutes);

app.use('/api/chapa', chapaRoutes);

// ============================================================================
// API 404
// ============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
  });
});

// ============================================================================
// CENTRAL ERROR HANDLER
// ============================================================================

app.use((err, req, res, next) => {
  console.error('MarketBridge API error:', err);

  // CORS errors
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({
      error: 'CORS policy blocked this request',
    });
  }

  // Multer errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        maxSizeBytes: Number(process.env.DIGITAL_MAX_FILE_BYTES || 25 * 1024 * 1024),
      });
    }

    return res.status(400).json({
      error: err.message,
    });
  }

  // Rate limit errors
  if (err.name === 'RateLimitError') {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors,
    });
  }

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'A record with this value already exists',
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      error: 'Record not found',
    });
  }

  // Express/route-provided status
  const status = Number(err.status || err.statusCode) || 500;

  res.status(status).json({
    error:
      isProduction && status === 500
        ? 'Internal server error'
        : err.message || 'Internal server error',
    ...(isProduction && status === 500 ? {} : { stack: err.stack }),
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 MarketBridge API listening on port ${PORT}`);
  console.log(`   Environment: ${isProduction ? 'production' : 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
