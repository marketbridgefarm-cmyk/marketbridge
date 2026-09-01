const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post(
  '/',
  authenticate,
  [
    body('orderId').notEmpty(),
    body('toUserId').notEmpty(),
    body('role').isIn(['SELLER', 'BUYER', 'INSPECTOR', 'TRUCK_OWNER']),
    body('score').isInt({ min: 1, max: 5 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { orderId, toUserId, role, score, comment } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { transportJob: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (!['COMPLETED', 'DELIVERED'].includes(order.status)) {
      return res.status(400).json({ error: 'You can only rate participants on a completed order' });
    }

    // The rater must actually be a participant on this order.
    const truckOwnerId = order.transportJob?.truckOwnerId;
    const isParticipant = [order.buyerId, order.sellerId, truckOwnerId].includes(req.user.id);
    if (!isParticipant) {
      return res.status(403).json({ error: 'You did not participate in this order' });
    }
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: 'You cannot rate yourself' });
    }
    // The person being rated must also be a real participant in the role claimed.
    // Note: INSPECTOR ratings aren't verifiable yet — Order has no direct
    // inspector link (inspections are tied to the Listing, not the Order) —
    // so INSPECTOR-role ratings are rejected here until that link exists.
    const validTarget =
      (role === 'BUYER' && toUserId === order.buyerId) ||
      (role === 'SELLER' && toUserId === order.sellerId) ||
      (role === 'TRUCK_OWNER' && toUserId === truckOwnerId);
    if (!validTarget) {
      return res.status(400).json({ error: 'toUserId does not match a real, verifiable participant for that role on this order' });
    }

    const existing = await prisma.rating.findUnique({ where: { orderId_fromUserId_toUserId_role: { orderId, fromUserId: req.user.id, toUserId, role } } });
    if (existing) return res.status(409).json({ error: 'You already rated this participant for this order' });

    const rating = await prisma.rating.create({
      data: { orderId, fromUserId: req.user.id, toUserId, role, score, comment },
    });

    // Recalculate the recipient's average rating
    const aggregate = await prisma.rating.aggregate({ where: { toUserId }, _avg: { score: true } });
    await prisma.user.update({ where: { id: toUserId }, data: { rating: aggregate._avg.score || 0 } });

    res.status(201).json({ rating });
  }
);

router.get('/user/:userId', async (req, res) => {
  const ratings = await prisma.rating.findMany({
    where: { toUserId: req.params.userId },
    include: { fromUser: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ ratings });
});

module.exports = router;
