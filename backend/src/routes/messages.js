const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin, isConversationParticipant } = require('../utils/authorization');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  next();
};

router.post('/', authenticate, [
  body('receiverId').isUUID().withMessage('receiverId must be a valid user id'),
  body('content').isString().trim().isLength({ min: 1, max: 5000 }),
  body('orderId').optional({ values: 'falsy' }).isUUID(),
], validate, async (req, res) => {
  const { receiverId, content, orderId } = req.body;
  if (receiverId === req.user.id) return res.status(400).json({ error: 'You cannot message yourself' });
  const receiver = await prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } });
  if (!receiver) return res.status(404).json({ error: 'Receiver not found' });

  let order = null;
  if (orderId) {
    order = await prisma.order.findUnique({ where: { id: orderId }, include: { transportJob: { select: { truckOwnerId: true } } } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!isConversationParticipant(req.user.id, order) || !isConversationParticipant(receiverId, order)) {
      return res.status(403).json({ error: 'Both users must be participants in the order to use its conversation' });
    }
  } else if (!isAdmin(req.user)) {
    return res.status(400).json({ error: 'orderId is required for marketplace conversations' });
  }

  const message = await prisma.message.create({ data: { senderId: req.user.id, receiverId, content, orderId: orderId || null } });
  res.status(201).json({ message });
});

router.get('/thread/:userId', authenticate, [param('userId').isUUID()], validate, async (req, res) => {
  const otherUserId = req.params.userId;
  if (otherUserId === req.user.id) return res.status(400).json({ error: 'Invalid conversation participant' });
  const hasRelationship = await prisma.order.findFirst({
    where: { OR: [
      { buyerId: req.user.id, sellerId: otherUserId },
      { buyerId: otherUserId, sellerId: req.user.id },
      { transportJob: { is: { truckOwnerId: req.user.id }, }, buyerId: otherUserId },
      { transportJob: { is: { truckOwnerId: req.user.id }, }, sellerId: otherUserId },
      { transportJob: { is: { truckOwnerId: otherUserId }, }, buyerId: req.user.id },
      { transportJob: { is: { truckOwnerId: otherUserId }, }, sellerId: req.user.id },
    ] },
    select: { id: true },
  });
  if (!hasRelationship && !isAdmin(req.user)) return res.status(403).json({ error: 'You are not authorized to view this conversation' });
  const messages = await prisma.message.findMany({
    where: { OR: [
      { senderId: req.user.id, receiverId: otherUserId },
      { senderId: otherUserId, receiverId: req.user.id },
    ] },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  res.json({ messages });
});

module.exports = router;
