const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();
router.use(authenticate, requireRole('ADMIN'));

router.get('/overview', async (req, res) => {
  const [users, listings, orders, disputes, activeAds, payments] = await Promise.all([
    prisma.user.count(),
    prisma.listing.count(),
    prisma.order.count(),
    prisma.dispute.count({ where: { status: 'OPEN' } }),
    prisma.advertisement.count({ where: { status: 'ACTIVE' } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'PAID' } }),
  ]);
  res.json({
    users, listings, orders, openDisputes: disputes, activeAds,
    totalPaidVolume: payments._sum.amount || 0,
  });
});

router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, roles: true, verificationStatus: true, rating: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ users });
});

router.patch('/users/:id/verify', async (req, res) => {
  const { verificationStatus } = req.body; // VERIFIED | REJECTED | PENDING
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { verificationStatus } });
  res.json({ user });
});

router.get('/fraud-flags', async (req, res) => {
  // Simple heuristic starting point: listings with an unusually high number
  // of rejected offers, or users with multiple open disputes against them.
  const suspiciousUsers = await prisma.user.findMany({
    where: { disputesAgainst: { some: { status: 'OPEN' } } },
    include: { disputesAgainst: { where: { status: 'OPEN' } } },
  });
  res.json({ suspiciousUsers });
});

module.exports = router;
