require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { apiLimiter } = require('./middleware/rateLimit');

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

const app = express();

// Railway runs the app behind a reverse proxy.
// Trust the first proxy so Express can correctly read X-Forwarded-For.
app.set('trust proxy', 1);

/*
|--------------------------------------------------------------------------
| Security / Middleware
|--------------------------------------------------------------------------
*/

app.use(helmet());

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const jwtSecret = process.env.JWT_SECRET || '';
  const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (jwtSecret.length < 32 || webhookSecret.length < 32) {
    console.error('FATAL: JWT_SECRET and PAYMENT_WEBHOOK_SECRET must each be at least 32 characters in production.');
    process.exit(1);
  }
}

if (isProduction && allowedOrigins.length === 0) {
  // Fail loudly at startup rather than silently allowing every origin in
  // production — a missing CLIENT_URL should be a deploy-blocking mistake,
  // not a silent open-CORS policy.
  console.error(
    'FATAL: CLIENT_URL is not set. Refusing to start in production with an open CORS policy.'
  );
  process.exit(1);
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header, such as health checks,
      // server-to-server requests, and some development tools.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Outside production, fall back to allowing any origin so local dev
      // (varying ports, tools like Postman/Insomnia) isn't blocked.
      if (!isProduction) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS blocked request from origin: ${origin}`)
      );
    },
    credentials: true,
  })
);

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(
  express.json({
    limit: '5mb',
    verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '5mb',
  })
);

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'marketbridge-api',
    timestamp: new Date().toISOString(),
  });
});

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
*/

app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);

app.use('/api/listings', listingRoutes);

app.use('/api/offers', offerRoutes);

app.use('/api/inspections', inspectionRoutes);

app.use('/api/transport', transportRoutes);

app.use('/api/orders', orderRoutes);

app.use('/api/payments', paymentRoutes);

app.use('/api/ads', adRoutes);

app.use('/api/disputes', disputeRoutes);

app.use('/api/ratings', ratingRoutes);

app.use('/api/digital-products', digitalRoutes);

app.use('/api/messages', messageRoutes);

app.use('/api/admin', adminRoutes);

/*
|--------------------------------------------------------------------------
| API 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
  });
});

/*
|--------------------------------------------------------------------------
| Central Error Handler
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
  console.error('MarketBridge API error:', err);

  // CORS errors
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({
      error: 'CORS policy blocked this request',
    });
  }

  // Express/route-provided status
  const status = Number(err.status || err.statusCode) || 500;

  res.status(status).json({
    error:
      process.env.NODE_ENV === 'production' && status === 500
        ? 'Internal server error'
        : err.message || 'Internal server error',
  });
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MarketBridge API listening on port ${PORT}`);
});
