const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const userSelect = { id: true, name: true, phone: true, location: true, rating: true, verificationStatus: true };

const transportInclude = {
  truckOwner: { select: { id: true, name: true, phone: true, rating: true, verificationStatus: true } },
  truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
  quotes: {
    include: {
      truckOwner: { select: { id: true, name: true, phone: true, rating: true, verificationStatus: true } },
      truck: { select: { id: true, registration: true, truckType: true, capacity: true, operatingArea: true, availability: true, verificationStatus: true, rating: true } },
    },
    orderBy: { amount: 'asc' },
  },
};

const orderInclude = {
  listing: true,
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: { include: transportInclude },
  payments: {
    include: {
      commission: true,
      ledgerEntries: true,
    },
  },
  disputes: true,
  ratings: true,
  messages: { orderBy: { createdAt: 'asc' } },
};

router.get('/', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.roles?.includes('ADMIN');
    const orders = await prisma.order.findMany({
      where: isAdmin ? {} : { OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }] },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ orders, count: orders.length });
  } catch (error) {
    console.error('GET ORDERS ERROR:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: orderInclude,
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowed = req.user.roles?.includes('ADMIN') ||
      order.buyerId === req.user.id ||
      order.sellerId === req.user.id ||
      order.transportJob?.truckOwnerId === req.user.id;

    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this order' });

    return res.json({ order });
  } catch (error) {
    console.error('GET ORDER ERROR:', error);
    return res.status(500).json({ error: 'Failed to load order' });
  }
});

router.patch('/:id/confirm-receipt', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { transportJob: true, payments: true },
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerId !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm receipt' });
    if (order.status === 'COMPLETED') return res.status(400).json({ error: 'Order has already been completed' });
    if (!order.transportJob) return res.status(400).json({ error: 'No transport record exists for this order' });
    if (order.transportJob.status !== 'DELIVERED') {
      return res.status(400).json({ error: `Receipt cannot be confirmed while transport status is ${order.transportJob.status}` });
    }

    // Verify all payments are PAID
    const marketplacePaid = order.payments.some(p => p.type === 'MARKETPLACE' && p.status === 'PAID');
    if (!marketplacePaid) {
      return res.status(402).json({ error: 'Marketplace payment must be PAID before receipt can be confirmed' });
    }

    if (order.transportJob.method === 'HIRE_TRANSPORTER') {
      const transportPaid = order.payments.some(p => p.type === 'TRANSPORT' && p.status === 'PAID');
      if (!transportPaid) {
        return res.status(402).json({ error: 'Transport payment must be PAID before receipt can be confirmed' });
      }
    }

    const updated = await prisma.$transaction(async tx => {
      const current = await tx.order.findUnique({
        where: { id: order.id },
        include: { transportJob: true },
      });

      if (!current || current.buyerId !== req.user.id) {
        throw new Error('Only the buyer can confirm receipt');
      }

      if (current.status === 'COMPLETED') {
        throw new Error('Order has already been completed');
      }

      if (!current.transportJob || current.transportJob.status !== 'DELIVERED') {
        throw new Error(`Receipt cannot be confirmed while transport status is ${current.transportJob?.status || 'UNKNOWN'}`);
      }

      return tx.order.update({
        where: { id: current.id },
        data: { status: 'COMPLETED' },
        include: orderInclude,
      });
    });

    return res.json({ message: 'Receipt confirmed. Order completed.', order: updated });
  } catch (error) {
    console.error('CONFIRM RECEIPT ERROR:', error);
    if (error.message.includes('confirm receipt') || error.message.includes('already been completed') || error.message.includes('UNKNOWN')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to confirm receipt' });
  }
});

module.exports = router;
