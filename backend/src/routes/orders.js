const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { recordAuditEvent } = require('../utils/audit');

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
  listing: {
    include: {
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        include: {
          report: true,
          inspector: { select: { id: true, name: true, phone: true } },
          payments: { select: { id: true, type: true, status: true, amount: true, method: true, reference: true } },
        },
      },
    },
  },
  buyer: { select: userSelect },
  seller: { select: userSelect },
  transportJob: { include: transportInclude },
  payments: {
    include: {
      ledgerEntries: true,
    },
  },
  disputes: true,
  ratings: true,
  messages: { orderBy: { createdAt: 'asc' } },
};

// BUY NOW for normal physical products.
// Agricultural listings continue to use the offer/negotiation workflow.
router.post('/buy-now', authenticate, async (req, res) => {
  try {
    if (!req.user.roles?.includes('BUYER')) {
      return res.status(403).json({ error: 'Only buyers can purchase listings' });
    }

    const listingId = String(req.body?.listingId || '').trim();
    if (!listingId) return res.status(400).json({ error: 'listingId is required' });

    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.listing.findUnique({ where: { id: listingId } });
      if (!listing) throw Object.assign(new Error('Listing not found'), { status: 404 });
      if (listing.category !== 'PRODUCT') {
        throw Object.assign(new Error('Buy Now is available for physical product listings. Agricultural listings use offers.'), { status: 400 });
      }
      if (listing.status !== 'ACTIVE') {
        throw Object.assign(new Error('This product is currently unavailable'), { status: 409 });
      }
      if (listing.sellerId === req.user.id) {
        throw Object.assign(new Error('You cannot purchase your own listing'), { status: 400 });
      }

      const existing = await tx.order.findFirst({
        where: {
          listingId,
          status: { notIn: ['CANCELLED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        if (existing.buyerId === req.user.id) return existing;
        throw Object.assign(new Error('This product is currently reserved or sold'), { status: 409 });
      }

      const order = await tx.order.create({
        data: {
          listingId: listing.id,
          buyerId: req.user.id,
          sellerId: listing.sellerId,
          finalPrice: Number(listing.askingPrice),
          status: 'PENDING_PAYMENT',
        },
      });

      await tx.listing.update({
        where: { id: listing.id },
        data: { status: 'SOLD' },
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'ORDER_CREATED',
        resourceType: 'Order',
        resourceId: order.id,
        metadata: {
          listingId: listing.id,
          sellerId: listing.sellerId,
          finalPrice: order.finalPrice,
          via: 'buy-now',
        },
      });

      return order;
    });

    return res.status(201).json({
      message: 'Order created. Complete payment to confirm the purchase.',
      order: result,
      paymentConfirmed: false,
    });
  } catch (error) {
    console.error('BUY NOW ERROR:', error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Could not create order',
    });
  }
});

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

    const assignedInspector = Boolean(
      order.listing?.inspectionRequests?.some(
        (request) => request.inspectorId === req.user.id
      )
    );

    const allowed = req.user.roles?.includes('ADMIN') ||
      order.buyerId === req.user.id ||
      order.sellerId === req.user.id ||
      order.transportJob?.truckOwnerId === req.user.id ||
      assignedInspector;

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

      const updatedOrder = await tx.order.update({
        where: { id: current.id },
        data: { status: 'COMPLETED' },
        include: orderInclude,
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'ORDER_RECEIPT_CONFIRMED',
        resourceType: 'Order',
        resourceId: current.id,
        metadata: {
          fromStatus: current.status,
          toStatus: 'COMPLETED',
        },
      });

      return updatedOrder;
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
