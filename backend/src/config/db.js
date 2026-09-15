const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

// Single shared Prisma instance across the app
// Enhanced with connection pooling and graceful shutdown
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
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
