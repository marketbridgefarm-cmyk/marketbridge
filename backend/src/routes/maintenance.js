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
  const now = new Date();
  const [expiredOffers, inspectionQuotesDue, transportQuotesDue, expiredListings, openReconciliation, unpaidOrdersDue, payoutsDue] = await Promise.all([
    prisma.offer.count({ where: { status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lte: now } } }),
    prisma.inspectionQuote.count({ where: { status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] }, expiresAt: { lte: now } } }),
    prisma.transportQuote.count({ where: { status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] }, expiresAt: { lte: now } } }),
    prisma.listing.count({ where: { status: { in: ['ACTIVE', 'UNDER_NEGOTIATION'] }, category: 'AGRICULTURAL', pickupWindowEnd: { lte: now } } }),
    prisma.paymentReconciliation.count({ where: { status: 'OPEN' } }),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT', paymentDueAt: { lte: now } } }),
    prisma.payout.count({ where: { status: 'HELD', releaseAt: { lte: now } } }),
  ]);
  res.json({ healthy: true, due: { expiredOffers, inspectionQuotesDue, transportQuotesDue, expiredListings, openReconciliation, unpaidOrdersDue, payoutsDue } });
});
module.exports = router;
