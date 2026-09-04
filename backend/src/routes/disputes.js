const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

router.post(
  '/',
  authenticate,
  [body('orderId').notEmpty(), body('againstId').notEmpty(), body('disputeType').notEmpty(), body('description').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { orderId, againstId, disputeType, description, evidence } = req.body;

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { transportJob: true } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const truckOwnerId = order.transportJob?.truckOwnerId;
    const participants = [order.buyerId, order.sellerId, truckOwnerId].filter(Boolean);

    if (!participants.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a participant on this order' });
    }
    if (againstId === req.user.id) {
      return res.status(400).json({ error: 'You cannot raise a dispute against yourself' });
    }
    if (!participants.includes(againstId)) {
      return res.status(400).json({ error: 'againstId must be another participant on this order' });
    }

    // Already-disputed orders shouldn't be re-escalated on top of themselves;
    // that would overwrite previousOrderStatus with DISPUTED and lose the
    // real status to restore to later.
    if (order.status === 'DISPUTED') {
      return res.status(409).json({ error: 'This order already has an open dispute' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.create({
        data: {
          orderId, raisedById: req.user.id, againstId, disputeType, description,
          evidence: evidence || [],
          previousOrderStatus: order.status,
        },
      });
      await tx.order.update({ where: { id: orderId }, data: { status: 'DISPUTED' } });
      return dispute;
    });

    res.status(201).json({ dispute: result });
  }
);

router.get('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  const disputes = await prisma.dispute.findMany({
    include: { order: true, raisedBy: { select: { id: true, name: true } }, against: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ disputes });
});

router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), async (req, res) => {
  const { resolution, status } = req.body; // status: RESOLVED | REJECTED

  const dispute = await prisma.dispute.findUnique({ where: { id: req.params.id } });
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  if (dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW') {
    return res.status(409).json({ error: `Dispute is already ${dispute.status}` });
  }

  const finalStatus = status || 'RESOLVED';

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.dispute.update({
      where: { id: req.params.id },
      data: { resolution, status: finalStatus },
    });

    // Either way — resolved or rejected — the dispute is no longer open, so
    // the order should return to whatever it was doing before, not stay
    // stuck at DISPUTED. Fall back to CONFIRMED only in the unlikely case
    // an older dispute row predates this field and has no value recorded.
    await tx.order.update({
      where: { id: updated.orderId },
      data: { status: updated.previousOrderStatus || 'CONFIRMED' },
    });

    return updated;
  });

  res.json({ dispute: result });
});

module.exports = router;
