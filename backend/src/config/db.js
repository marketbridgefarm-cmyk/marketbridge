const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

// Single shared Prisma instance across the app
// Enhanced with connection pooling and graceful shutdown
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // Several interactive $transaction blocks in this codebase do a lot of
  // sequential work (syncOrderPaymentObligations issuing a query per
  // obligation, recordOrderEvent -> notification creation -> SMS-outbox
  // queuing, etc.). Under real network latency (this app's DB is on a
  // different host/provider than the API), that can exceed Prisma's
  // 5-second default interactive-transaction timeout, which force-closes
  // the transaction — any later query in that same transaction then fails
  // with P2028 "Transaction not found... refers to an old closed
  // transaction" even though every individual query was fine on its own.
  // Raising the default here covers every $transaction call in the app
  // (including ones added later) rather than only the specific routes
  // observed hitting this in production.
  transactionOptions: {
    timeout: 20000,
    maxWait: 10000,
  },
});

// Test database connection on startup
async function testConnection() {
  try {
    await prisma.$connect();
    logger.info('Database connection established');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed');
    return false;
  }
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = prisma;
module.exports.testConnection = testConnection;
