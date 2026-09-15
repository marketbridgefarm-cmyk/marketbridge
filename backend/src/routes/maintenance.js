'use strict';
const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { runMaintenanceCycle } = require('../services/maintenanceService');
const router = express.Router();
router.post('/run', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try { return res.json({ success: true, result: await runMaintenanceCycle() }); }
  catch (error) { req.log.error({ err: error }, 'MAINTENANCE RUN ERROR:'); return res.status(500).json({ error: 'Maintenance cycle failed' }); }
});
router.get('/status', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  const [expiredOffers, expiredListings, openReconciliation, unpaidOrdersDue] = await Promise.all([
    prisma.offer.count({ where: { status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lte: new Date() } } }),
    prisma.listing.count({ where: { status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] }, category: 'AGRICULTURAL', pickupWindowEnd: { lte: new Date() } } }),
    prisma.paymentReconciliation.count({ where: { status: 'OPEN' } }),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT', paymentDueAt: { lte: new Date() } } }),
  ]);
  res.json({ healthy: true, due: { expiredOffers, expiredListings, openReconciliation, unpaidOrdersDue } });
});
module.exports = router;
