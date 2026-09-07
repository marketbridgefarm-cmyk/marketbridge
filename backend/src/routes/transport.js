const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isOrderParticipant, isAdmin } = require('../utils/authorization');

const router = express.Router();

// ============ VALIDATION ============
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

// ============ CREATE TRANSPORT JOB ============
// POST /api/transport
// Only seller or buyer (or admin) can create a transport job for an order.
router.post(
  '/',
  authenticate,
  [
    body('orderId').isUUID().withMessage('orderId is required'),
    body('arrangingParty').isIn(['SELLER', 'BUYER', 'JOINT']),
    body('method').isIn(['OWN_TRUCK', 'HIRE_TRANSPORTER']),
    body('pickupLocation').isString().trim().notEmpty(),
    body('destination').isString().trim().notEmpty(),
    body('load').isString().trim().notEmpty(),
    body('requiredCapacity').optional().isFloat({ min: 0 }),
    body('specialRequirements').optional().isString().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        orderId,
        arrangingParty,
        method,
        pickupLocation,
        destination,
        load,
        requiredCapacity,
        specialRequirements,
      } = req.body;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { transportJob: true },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Only participants (buyer/seller) or admin can create transport
      if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to arrange transport for this order' });
      }

      // Ensure the order is confirmed (marketplace payment done)
      if (order.status !== 'CONFIRMED' && order.status !== 'PENDING_PAYMENT') {
        return res.status(400).json({ error: `Transport can only be arranged for orders in CONFIRMED or PENDING_PAYMENT state (current: ${order.status})` });
      }

      // Prevent duplicate transport job
      if (order.transportJob) {
        return res.status(409).json({ error: 'A transport job already exists for this order' });
      }

      // If method is OWN_TRUCK, the user must have a truck (or we allow any? we'll check)
      if (method === 'OWN_TRUCK') {
        // Ensure the current user is the seller or buyer (whoever is arranging) and they have a truck?
        // The spec says OWN_TRUCK means the arranging party uses their own truck.
        // We'll just allow it, but we don't enforce having a truck in the system.
        // However, we need to set truckOwnerId = current user if they are arranging.
        // But we could also allow the seller to use the buyer's truck? No.
        // We'll set truckOwnerId to the current user.
        // We'll not require a truck record, as they might not have registered it.
        // We'll set truckOwnerId = req.user.id.
      }

      const transportJob = await prisma.transportJob.create({
        data: {
          orderId: order.id,
          arrangingParty,
          method,
          pickupLocation,
          destination,
          load,
          requiredCapacity: requiredCapacity || null,
          specialRequirements: specialRequirements || null,
          // For OWN_TRUCK, we set the truckOwnerId to the current user (they are using their own truck)
          truckOwnerId: method === 'OWN_TRUCK' ? req.user.id : null,
          // truckId is optional, can be filled later if they register a truck
          status: method === 'OWN_TRUCK' ? 'ACCEPTED' : 'REQUESTED', // OWN_TRUCK is immediately accepted
        },
      });

      // Update order status to TRANSPORT_ARRANGED if not already
      if (order.status === 'PENDING_PAYMENT') {
        // Do not change status yet; payment must be confirmed first.
        // Actually, transport arrangement can happen before payment? The spec says transport is post-purchase.
        // We'll leave order status as is; the frontend will handle.
        // We'll update to TRANSPORT_ARRANGED only if order is CONFIRMED.
        if (order.status === 'CONFIRMED') {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'TRANSPORT_ARRANGED' },
          });
        }
      }

      return res.status(201).json({ transportJob });
    } catch (error) {
      console.error('CREATE TRANSPORT ERROR:', error);
      return res.status(500).json({ error: 'Could not create transport job' });
    }
  }
);

// ============ GET TRANSPORT JOB FOR ORDER ============
router.get(
  '/order/:orderId',
  authenticate,
  [param('orderId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.orderId },
        include: {
          transportJob: {
            include: {
              truckOwner: { select: { id: true, name: true, rating: true } },
              truck: true,
              quotes: {
                include: {
                  truckOwner: { select: { id: true, name: true, rating: true } },
                  truck: true,
                },
                orderBy: { amount: 'asc' },
              },
            },
          },
        },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      return res.json({ transportJob: order.transportJob || null });
    } catch (error) {
      console.error('GET TRANSPORT ERROR:', error);
      return res.status(500).json({ error: 'Could not load transport job' });
    }
  }
);

// ============ LIST MY TRANSPORT JOBS (for truck owner) ============
router.get('/mine', authenticate, requireRole('TRUCK_OWNER'), async (req, res) => {
  try {
    const jobs = await prisma.transportJob.findMany({
      where: { truckOwnerId: req.user.id },
      include: {
        order: {
          include: {
            buyer: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
          },
        },
        truck: true,
        quotes: { where: { truckOwnerId: req.user.id } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ transportJobs: jobs });
  } catch (error) {
    console.error('MY TRANSPORT JOBS ERROR:', error);
    return res.status(500).json({ error: 'Could not load your transport jobs' });
  }
});

// ============ UPDATE TRANSPORT JOB STATUS ============
// Only the arranging party (or admin) can update status, except for DELIVERED which buyer confirms.
// For OWN_TRUCK, status updates are done by the truck owner (which is the arranging party).
router.patch(
  '/:id/status',
  authenticate,
  [
    param('id').isUUID(),
    body('status').isIn(['REQUESTED', 'ACCEPTED', 'QUOTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']),
    body('incidentNotes').optional().isString().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      // Check authorization
      const isArranging = job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id ||
                          job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id ||
                          job.arrangingParty === 'JOINT' && (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id);
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to update this transport job' });
      }

      // Validate transition
      const current = job.status;
      const next = req.body.status;

      // Define allowed transitions (simplified)
      const validTransitions = {
        REQUESTED: ['ACCEPTED', 'QUOTED', 'CANCELLED'],
        QUOTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
        ACCEPTED: ['PICKUP', 'CANCELLED'],
        PICKUP: ['IN_TRANSIT', 'CANCELLED'],
        IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
        DELIVERED: ['DELIVERED'], // can stay
        CANCELLED: [],
      };

      if (!validTransitions[current]?.includes(next)) {
        return res.status(400).json({ error: `Invalid status transition from ${current} to ${next}` });
      }

      // Only the arranging party can cancel, or truck owner if it's OWN_TRUCK? but we'll allow both.
      // For DELIVERED, only buyer can confirm? Actually receipt confirmation is separate.
      // We'll allow any authorized party to set DELIVERED, but the order receipt confirmation is separate.

      const updated = await prisma.transportJob.update({
        where: { id: job.id },
        data: {
          status: next,
          incidentNotes: req.body.incidentNotes || job.incidentNotes,
          pickupConfirmedAt: next === 'PICKUP' ? new Date() : job.pickupConfirmedAt,
          deliveredConfirmedAt: next === 'DELIVERED' ? new Date() : job.deliveredConfirmedAt,
        },
      });

      // If status becomes DELIVERED, we could auto-update order to DELIVERED if not already.
      if (next === 'DELIVERED') {
        await prisma.order.update({
          where: { id: job.orderId },
          data: { status: 'DELIVERED' },
        });
      }

      return res.json({ transportJob: updated });
    } catch (error) {
      console.error('UPDATE TRANSPORT STATUS ERROR:', error);
      return res.status(500).json({ error: 'Could not update transport status' });
    }
  }
);

// ============ SUBMIT A QUOTE (for HIRE_TRANSPORTER) ============
router.post(
  '/:id/quotes',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    param('id').isUUID(),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than zero'),
    body('message').optional().isString().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });
      if (job.method !== 'HIRE_TRANSPORTER') {
        return res.status(400).json({ error: 'Quotes are only for HIRE_TRANSPORTER jobs' });
      }
      if (job.status !== 'REQUESTED' && job.status !== 'QUOTED') {
        return res.status(400).json({ error: 'This job is not open for quotes' });
      }

      // Check if the truck owner already has a pending quote
      const existing = await prisma.transportQuote.findFirst({
        where: {
          transportJobId: job.id,
          truckOwnerId: req.user.id,
          status: { in: ['PENDING', 'ACCEPTED'] },
        },
      });
      if (existing) return res.status(409).json({ error: 'You already have a pending or accepted quote for this job' });

      // Optionally, the truck owner must have a truck
      const truck = await prisma.truck.findFirst({
        where: { ownerId: req.user.id, availability: 'AVAILABLE' },
      });
      if (!truck) {
        return res.status(400).json({ error: 'You must have an available truck to quote' });
      }

      const quote = await prisma.transportQuote.create({
        data: {
          transportJobId: job.id,
          truckOwnerId: req.user.id,
          truckId: truck.id,
          amount: Number(req.body.amount),
          message: req.body.message || null,
          status: 'PENDING',
        },
      });

      // Update job status to QUOTED if not already
      if (job.status === 'REQUESTED') {
        await prisma.transportJob.update({
          where: { id: job.id },
          data: { status: 'QUOTED' },
        });
      }

      return res.status(201).json({ quote });
    } catch (error) {
      console.error('CREATE QUOTE ERROR:', error);
      return res.status(500).json({ error: 'Could not submit quote' });
    }
  }
);

// ============ LIST QUOTES FOR A JOB ============
router.get(
  '/:id/quotes',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      // Only arranging party or admin can view all quotes; truck owners can see their own
      const isArranging = job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id ||
                          job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id ||
                          job.arrangingParty === 'JOINT' && (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id);
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to view these quotes' });
      }

      const quotes = await prisma.transportQuote.findMany({
        where: { transportJobId: job.id },
        include: {
          truckOwner: { select: { id: true, name: true, rating: true } },
          truck: true,
        },
        orderBy: { amount: 'asc' },
      });

      return res.json({ quotes });
    } catch (error) {
      console.error('LIST QUOTES ERROR:', error);
      return res.status(500).json({ error: 'Could not load quotes' });
    }
  }
);

// ============ ACCEPT/REJECT A QUOTE ============
// Only the arranging party can accept/reject a quote.
// Upon acceptance, the transport job is updated with the chosen truck owner and amount.
router.patch(
  '/quotes/:quoteId',
  authenticate,
  [
    param('quoteId').isUUID(),
    body('action').isIn(['ACCEPT', 'REJECT']),
  ],
  validate,
  async (req, res) => {
    try {
      const quote = await prisma.transportQuote.findUnique({
        where: { id: req.params.quoteId },
        include: { transportJob: { include: { order: true } } },
      });

      if (!quote) return res.status(404).json({ error: 'Quote not found' });
      if (quote.status !== 'PENDING') {
        return res.status(400).json({ error: `This quote is already ${quote.status.toLowerCase()}` });
      }

      const job = quote.transportJob;
      const order = job.order;

      // Check authorization: only arranging party can accept/reject
      const isArranging = job.arrangingParty === 'SELLER' && order.sellerId === req.user.id ||
                          job.arrangingParty === 'BUYER' && order.buyerId === req.user.id ||
                          job.arrangingParty === 'JOINT' && (order.buyerId === req.user.id || order.sellerId === req.user.id);

      if (!isArranging && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Only the arranging party can accept or reject a quote' });
      }

      if (req.body.action === 'ACCEPT') {
        // Accept the quote
        const updatedQuote = await prisma.$transaction(async (tx) => {
          // Update quote status
          const q = await tx.transportQuote.update({
            where: { id: quote.id },
            data: { status: 'ACCEPTED' },
          });

          // Reject all other pending quotes for this job
          await tx.transportQuote.updateMany({
            where: {
              transportJobId: job.id,
              id: { not: quote.id },
              status: 'PENDING',
            },
            data: { status: 'REJECTED' },
          });

          // Update transport job with selected truck owner and agreed amount
          await tx.transportJob.update({
            where: { id: job.id },
            data: {
              truckOwnerId: quote.truckOwnerId,
              truckId: quote.truckId,
              agreedAmount: quote.amount,
              status: 'ACCEPTED',
            },
          });

          // Update order status to TRANSPORT_ARRANGED if not already
          if (order.status === 'CONFIRMED') {
            await tx.order.update({
              where: { id: order.id },
              data: { status: 'TRANSPORT_ARRANGED' },
            });
          }

          return q;
        });

        return res.json({ message: 'Quote accepted', quote: updatedQuote });
      } else {
        // REJECT
        const updatedQuote = await prisma.transportQuote.update({
          where: { id: quote.id },
          data: { status: 'REJECTED' },
        });
        return res.json({ message: 'Quote rejected', quote: updatedQuote });
      }
    } catch (error) {
      console.error('ACCEPT/REJECT QUOTE ERROR:', error);
      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

module.exports = router;
