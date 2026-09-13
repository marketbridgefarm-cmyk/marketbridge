const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { recordAuditEvent } = require('../utils/audit');
const { isAdmin } = require('../utils/authorization');
const { computeOrderWorkflow } = require('../services/orderWorkflowService');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

// Once an order is COMPLETED or already CANCELLED there is nothing left to
// cancel.
const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];

// Once the truck has actually picked up, is moving, or has delivered the
// goods, a plain cancel is the wrong tool — that needs the dispute/refund
// workflow so both sides have a record of why goods that physically moved
// are being unwound.
const TRANSPORT_IN_MOTION_STATUSES = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];

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

// ============================================================================
// GET ORDER WORKFLOW
// ============================================================================
// Server-authoritative summary of where this order stands: current stage,
// whose turn it is, outstanding payment obligations, a progress timeline,
// and the exact set of actions available right now (each tagged with
// whether the requesting user is allowed to perform it). The frontend
// should render from this rather than re-deriving these rules per page.
// ============================================================================

router.get('/:id/workflow', authenticate, async (req, res) => {
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

    const workflow = computeOrderWorkflow(order, req.user.id, req.user.roles || []);

    return res.json({ workflow });
  } catch (error) {
    console.error('GET ORDER WORKFLOW ERROR:', error);
    return res.status(500).json({ error: 'Failed to compute order workflow' });
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

// CANCEL an order.
//   - Buyer: only while PENDING_PAYMENT (backing out before paying).
//   - Seller: while PENDING_PAYMENT or CONFIRMED (killing a stalled order
//     before transport is really underway).
//   - Admin: any order not already COMPLETED/CANCELLED, as an override —
//     including DISPUTED orders, as part of dispute resolution.
// In every case, goods already PICKUP/IN_TRANSIT/DELIVERED block a plain
// cancel; use a dispute instead.
router.patch(
  '/:id/cancel',
  authenticate,
  [
    param('id').isUUID(),
    body('reason').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { transportJob: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      const userIsAdmin = isAdmin(req.user);
      const userIsBuyer = order.buyerId === req.user.id;
      const userIsSeller = order.sellerId === req.user.id;

      if (!userIsAdmin && !userIsBuyer && !userIsSeller) {
        return res.status(403).json({ error: 'Not authorized to cancel this order' });
      }

      if (NON_CANCELLABLE_STATUSES.includes(order.status)) {
        return res.status(400).json({
          error: `Order is already ${order.status.toLowerCase()} and cannot be cancelled`,
        });
      }

      if (order.transportJob && TRANSPORT_IN_MOTION_STATUSES.includes(order.transportJob.status)) {
        return res.status(400).json({
          error: 'Goods are already in transit or delivered for this order. Raise a dispute instead of cancelling.',
        });
      }

      if (userIsBuyer && !userIsAdmin && order.status !== 'PENDING_PAYMENT') {
        return res.status(400).json({
          error: 'You can only cancel an order before it has been paid for. Raise a dispute for orders already in progress.',
        });
      }

      if (userIsSeller && !userIsAdmin && !['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)) {
        return res.status(400).json({
          error: 'This order has moved past the point a seller can cancel directly. An admin can cancel it, or raise a dispute.',
        });
      }

      const reason = req.body?.reason || null;
      const cancelledByRole = userIsAdmin ? 'ADMIN' : userIsBuyer ? 'BUYER' : 'SELLER';

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: order.id },
          include: { transportJob: true, payments: true },
        });

        if (!current || NON_CANCELLABLE_STATUSES.includes(current.status)) {
          throw Object.assign(new Error('Order is no longer cancellable'), { status: 409 });
        }

        await tx.order.update({
          where: { id: current.id },
          data: { status: 'CANCELLED' },
        });

        // Free the listing back up so it can be sold again.
        await tx.listing.update({
          where: { id: current.listingId },
          data: { status: 'ACTIVE' },
        });

        // Cascade-cancel a transport job that hasn't moved yet.
        if (current.transportJob && !['DELIVERED', 'CANCELLED'].includes(current.transportJob.status)) {
          await tx.transportJob.update({
            where: { id: current.transportJob.id },
            data: { status: 'CANCELLED' },
          });
        }

        // Payment gateways are stubbed (see README) — there's no live
        // provider to call for a refund here, so anything already PAID on
        // this order gets flagged REFUNDED as a bookkeeping record rather
        // than silently written off. A real gateway integration should
        // trigger an actual refund call from this same branch.
        const paidOrderPayments = current.payments.filter((p) => p.status === 'PAID');
        const paidTransportPayments = current.transportJob
          ? await tx.payment.findMany({
              where: { transportJobId: current.transportJob.id, status: 'PAID' },
            })
          : [];

        const toRefund = [...paidOrderPayments, ...paidTransportPayments];
        for (const payment of toRefund) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'REFUNDED' },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'ORDER_CANCELLED',
          resourceType: 'Order',
          resourceId: current.id,
          metadata: {
            fromStatus: current.status,
            toStatus: 'CANCELLED',
            cancelledByRole,
            reason,
            refundedPaymentIds: toRefund.map((p) => p.id),
          },
        });

        return tx.order.findUnique({ where: { id: current.id }, include: orderInclude });
      });

      return res.json({ message: 'Order cancelled.', order: updated });
    } catch (error) {
      console.error('CANCEL ORDER ERROR:', error);
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Failed to cancel order',
      });
    }
  }
);

module.exports = router;
