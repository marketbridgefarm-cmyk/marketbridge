'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// -----------------------------------------------------------------------------
// APP
// -----------------------------------------------------------------------------

const app = express();

// -----------------------------------------------------------------------------
// SECURITY / BASIC MIDDLEWARE
// -----------------------------------------------------------------------------

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: process.env.APP_BASE_URL
      ? process.env.APP_BASE_URL.replace(/\/$/, '')
      : true,
    credentials: true,
  })
);

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// -----------------------------------------------------------------------------
// RAW BODY CAPTURE
//
// IMPORTANT:
// Payment webhooks, especially Chapa webhook verification, may require the
// exact raw request body. This middleware stores it before JSON parsing.
// -----------------------------------------------------------------------------

app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '2mb',
  })
);

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'MarketBridge API',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------
//
// Keep these paths synchronized with your existing frontend API client.
//
// -----------------------------------------------------------------------------

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const listingRoutes = require('./routes/listings');
const offerRoutes = require('./routes/offers');
const orderRoutes = require('./routes/orders');
const transportRoutes = require('./routes/transport');
const inspectionRoutes = require('./routes/inspections');
const paymentRoutes = require('./routes/payments');
const digitalProductRoutes = require('./routes/digitalProducts');
const advertisementRoutes = require('./routes/advertisements');
const disputeRoutes = require('./routes/disputes');
const ratingRoutes = require('./routes/ratings');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');

// -----------------------------------------------------------------------------
// ROUTE MOUNTS
// -----------------------------------------------------------------------------

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/transport', transportRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/digital-products', digitalProductRoutes);
app.use('/api/advertisements', advertisementRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/admin', adminRoutes);

// -----------------------------------------------------------------------------
// 404 HANDLER
// -----------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  });
});

// -----------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// -----------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err);

  if (res.headersSent) {
    return next(err);
  }

  const status = Number(err.status || err.statusCode || 500);

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error:
      status >= 500
        ? 'Internal server error'
        : err.message || 'Request failed',
  });
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`MarketBridge API running on port ${PORT}`);
});

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);

  server.close(async () => {
    try {
      const prisma = require('./config/db');

      if (prisma && typeof prisma.$disconnect === 'function') {
        await prisma.$disconnect();
      }

      console.log('MarketBridge API stopped.');
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
