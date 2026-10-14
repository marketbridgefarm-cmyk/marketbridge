const express = require('express');
const { body, param, validationResult } = require('express-validator');


const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const paymentService = require('../services/paymentService');
const { transitionOrderStatus, lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { isOrderParticipant, isAdmin } = require('../utils/authorization');
const { buildBuyerReportEnvelope } = require('../utils/reportContract');
const { idempotency } = require('../middleware/idempotency');
const { matchTrucks } = require('../services/transportMatchingService');

// FIXED: added computePaymentDueAt so confirm-loading can reset the goods
// payment deadline after the buyer approves the loading report.
const {
  computeSellerTransportPreparationDueAt: computeSellerPreparationDueAt,
  computeBuyerDecisionDueAt,
  computeLoadingApprovalDueAt: computeBuyerLoadingDueAt,
  computePaymentDueAt,
} = require('../utils/orderTiming');

const {
  noContactInfo,
} = require('../utils/contactGuard');

const {
  closeCoordination,
} = require('../services/transportCoordinationService');

const {
  noticeTransportWaitingUnlocked,
  releaseWaitingTransporters,
} = require('../services/waitingListService');

const router = express.Router();

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_TRUCK_JOB_STATUSES = [
  'ACCEPTED',
  'PICKUP',
  'IN_TRANSIT',
];

const LOADING_WHAT_OPTIONS = [
  'AS_LISTED',
  'SAME_PRODUCT_DIFFERENT_VARIETY',
  'PARTIAL_OF_LISTED',
  'DIFFERENT_PRODUCT',
  'REFUSED_TO_LOAD',
];

const LOADING_QUALITY_OPTIONS = [
  'AS_INSPECTED',
  'MINOR_VARIANCE',
  'MAJOR_VARIANCE',
  'DAMAGED',
  'NOT_INSPECTED',
];

const LOADING_ISSUE_OPTIONS = [
  'NONE',
  'FRESHNESS_CONCERN',
  'PHYSICAL_DAMAGE',
  'PACKAGING_DAMAGE',
  'QUANTITY_SHORTFALL',
  'WRONG_PRODUCT',
  'CONTAMINATION',
  'WEATHER_EXPOSURE',
];

// ============================================================================
// VALIDATION
// ============================================================================

const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }

  next();
};

// ============================================================================
// INTERNAL ERROR HELPERS
// ============================================================================

class TruckConflictError extends Error {
  constructor(message = 'Truck is no longer available') {
    super(message);
    this.name = 'TruckConflictError';
    this.code = 'TRUCK_CONFLICT';
    this.statusCode = 409;
  }
}

function quoteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

class ActiveTruckAssignmentError extends Error {
  constructor(
    message = 'Truck cannot be made available while it has an active transport job'
  ) {
    super(message);
    this.name = 'ActiveTruckAssignmentError';
    this.code = 'ACTIVE_TRUCK_ASSIGNMENT';
    this.statusCode = 409;
  }
}

// ============================================================================
// TRUCK STATE HELPERS
// ============================================================================

async function claimAvailableTruck(tx, truckId) {
  const result = await tx.truck.updateMany({
    where: { id: truckId, availability: 'AVAILABLE' },
    data: { availability: 'BUSY' },
  });

  if (result.count !== 1) {
    throw new TruckConflictError('Selected truck is no longer available');
  }

  return tx.truck.findUnique({ where: { id: truckId } });
}

async function releaseTruck(tx, truckId) {
  if (!truckId) return;
  await tx.truck.updateMany({
    where: { id: truckId, availability: 'BUSY' },
    data: { availability: 'AVAILABLE' },
  });
}

async function lockTruckRow(tx, truckId) {
  const truck = await tx.truck.findUnique({ where: { id: truckId } });
  if (!truck) return null;
  await tx.truck.update({ where: { id: truckId }, data: { availability: truck.availability } });
  return tx.truck.findUnique({ where: { id: truckId } });
}

// ============================================================================
// TRUCK MANAGEMENT
// ============================================================================

router.post(
  '/trucks',
  authenticate,
  // FIXED: Any authenticated user can register a truck. Buyers and sellers
  // who want to use their own vehicle must register it on the platform first.
  [
    // FIXED: Strict registration format + contact-info leak guard.
    // Blocks phone numbers (pure 7+ digit strings), emails, URLs, etc.
    body('registration')
      .isString().trim().notEmpty()
      .isLength({ min: 3, max: 15 })
      .matches(/^[A-Za-z0-9\-\s]+$/)
      .custom((v) => {
        if (/^\d{7,}$/.test(String(v).replace(/\s/g, ''))) {
          throw new Error('Registration cannot be a pure digit sequence');
        }
        return true;
      })
      .custom(noContactInfo),
    // FIXED: Contact-info leak guard. Dropdown on the frontend keeps the
    // value in a small closed set; this guard catches direct API calls.
    body('truckType')
      .isString().trim().notEmpty()
      .isLength({ min: 2, max: 40 })
      .custom(noContactInfo),
    body('capacity').isFloat({ gt: 0, lt: 200 }),
    // FIXED: Contact-info leak guard for free-form area text.
    body('operatingArea')
      .optional({ nullable: true })
      .isString().trim()
      .isLength({ max: 120 })
      .custom(noContactInfo),
  ],
  validate,
  async (req, res) => {
    try {
      const { registration, truckType, capacity, operatingArea } = req.body;

      const truck = await prisma.truck.create({
        data: {
          ownerId: req.user.id,
          registration: registration.trim(),
          truckType: truckType.trim(),
          capacity: Number(capacity),
          operatingArea: operatingArea?.trim() || '',
        },
      });

      return res.status(201).json({ truck });
    } catch (error) {
      req.log.error({ err: error }, 'REGISTER TRUCK ERROR:');

      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A truck with this registration already exists' });
      }

      return res.status(500).json({ error: 'Could not register truck' });
    }
  }
);

router.get(
  '/trucks/mine',
  authenticate,
  // FIXED: Any authenticated user can list their own trucks.
  async (req, res) => {
    try {
      const trucks = await prisma.truck.findMany({
        where: { ownerId: req.user.id },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ trucks });
    } catch (error) {
      req.log.error({ err: error }, 'MY TRUCKS ERROR:');
      return res.status(500).json({ error: 'Could not load your trucks' });
    }
  }
);

router.patch(
  '/trucks/:id/availability',
  authenticate,
  // FIXED: Any authenticated user can manage their own truck's availability.
  [
    param('id').isUUID(),
    body('availability').isIn(['AVAILABLE', 'BUSY', 'OFFLINE']),
  ],
  validate,
  async (req, res) => {
    try {
      const requestedAvailability = req.body.availability;

      const result = await prisma.$transaction(async (tx) => {
        const truck = await lockTruckRow(tx, req.params.id);

        if (!truck) {
          const error = new Error('Truck not found');
          error.statusCode = 404;
          throw error;
        }

        if (truck.ownerId !== req.user.id && !isAdmin(req.user)) {
          const error = new Error('Not your truck');
          error.statusCode = 403;
          throw error;
        }

        if (requestedAvailability === 'AVAILABLE') {
          const activeJob = await tx.transportJob.findFirst({
            where: { truckId: truck.id, status: { in: ACTIVE_TRUCK_JOB_STATUSES } },
            select: { id: true, status: true },
          });

          if (activeJob) {
            throw new ActiveTruckAssignmentError(
              'Truck cannot be made AVAILABLE while it has an active transport job'
            );
          }
        }

        return tx.truck.update({
          where: { id: truck.id },
          data: { availability: requestedAvailability },
        });
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ truck: result });
    } catch (error) {
      req.log.error({ err: error }, 'UPDATE TRUCK AVAILABILITY ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'ACTIVE_TRUCK_ASSIGNMENT') {
        return res.status(409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not update truck availability' });
    }
  }
);

// ============================================================================
// OPEN TRANSPORT JOBS (provider side)
// ----------------------------------------------------------------------------
// FIXED: Jobs remain visible and biddable from the moment they are requested
// until the work is delivered or the order is closed. The old filter dropped
// the job the moment a transport payment even existed (PENDING included), so
// a single abandoned Chapa checkout permanently hid the job from every other
// truck owner, contradicting the requirement that the request stays public
// until the buyer receives the goods. Waiting bids are now null-expiry (see
// POST /:id/quotes), which keeps the replacement pool alive for the buyer.
// ============================================================================

router.get(
  '/open',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const jobs = await prisma.transportJob.findMany({
        where: {
          method: 'HIRE_TRANSPORTER',
          // FIXED: Keep the job visible until completed, cancelled, or disputed.
          // This allows new truck owners to bid while work is in progress and
          // keeps the buyer's waiting list continuously replenished.
          status: { in: ['REQUESTED', 'QUOTED', 'ACCEPTED', 'PICKUP', 'IN_TRANSIT'] },
          // FIXED: only the order's own terminal states take the job off the
          // public list. A disputed order is paused; a cancelled or completed
          // order is done.
          order: {
            status: { notIn: ['DISPUTED', 'CANCELLED', 'COMPLETED'] },
          },
        },
        // FIXED: Explicitly select only non-sensitive fields
        select: {
          id: true,
          orderId: true,
          status: true,
          method: true,
          pickupLocation: true,
          destination: true,
          load: true,
          requiredCapacity: true,
          specialRequirements: true,
          createdAt: true,
          // DO NOT SELECT: agreedAmount, sellerPreparationDueAt, buyerLoadingDueAt
          order: {
            select: {
              buyer: { select: { id: true, name: true } },
              seller: { select: { id: true, name: true } },
            },
          },
          // Provide the active truck owner's name, but NOT their agreed fee
          truckOwner: {
            select: { id: true, name: true, rating: true },
          },
          truck: {
            select: { id: true, registration: true, truckType: true, capacity: true },
          },
          // FIXED: Only return the quotes belonging to the calling truck owner
          // (Sealed Bid). The extra fields are required for the dashboard to
          // (a) find the leaf quote via parentQuoteId, (b) determine whose
          // turn it is via counteredBy, and (c) surface a correct expiry via
          // expiresAt. Without them, a countered bid renders as "WAITING" on
          // the transporter's side even when it is their turn to respond.
          quotes: {
            where: {
              truckOwnerId: req.user.id,
            },
            select: {
              id: true,
              amount: true,
              status: true,
              message: true,
              createdAt: true,
              updatedAt: true,
              parentQuoteId: true,
              counterAmount: true,
              counteredBy: true,
              expiresAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ jobs });
    } catch (error) {
      req.log.error({ err: error }, 'OPEN TRANSPORT JOBS ERROR:');
      return res.status(500).json({ error: 'Could not load open transport jobs' });
    }
  }
);

router.get(
  '/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const jobs = await prisma.transportJob.findMany({
        where: { truckOwnerId: req.user.id },
        include: {
          // FIXED: expose the loading report status so the transporter's own
          // job list reflects buyer review state without a second request.
          loadingReport: { select: { id: true, buyerReviewStatus: true, submittedAt: true } },
          order: {
            include: {
              payments: { select: { type: true, status: true } },
              listing: { select: { category: true } },
              inspectionRequests: {
                where: { status: { not: 'CANCELLED' } },
                select: { id: true, status: true, fee: true, payments: { select: { type: true, status: true } } },
              },
              buyer: { select: { id: true, name: true } },
              seller: { select: { id: true, name: true } },
            },
          },
          truck: true,
          quotes: {
            where: { truckOwnerId: req.user.id },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ jobs });
    } catch (error) {
      req.log.error({ err: error }, 'MY TRANSPORT JOBS ERROR:');
      return res.status(500).json({ error: 'Could not load your transport jobs' });
    }
  }
);

router.get('/match', authenticate, async (req, res) => {
  try {
    const trucks = await matchTrucks({
      area: req.query.area,
      requiredCapacity: req.query.minCapacity,
      limit: req.query.limit,
    });
    return res.json({ trucks });
  } catch (error) {
    req.log.error({ err: error }, 'MATCH TRUCKS ERROR:');
    return res.status(500).json({ error: 'Could not find matching trucks' });
  }
});


// ============================================================================
// MY ACTIVE QUOTES (provider side)
// ============================================================================
router.get(
  '/my-quotes',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const quotes = await prisma.transportQuote.findMany({
        where: {
          truckOwnerId: req.user.id,
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
          childQuotes: { none: {} },
        },
        include: {
          transportJob: {
            include: {
              order: {
                include: {
                  buyer: { select: { id: true, name: true } },
                  seller: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({ quotes });
    } catch (error) {
      req.log.error({ err: error }, 'MY TRANSPORT QUOTES ERROR:');
      return res.status(500).json({ error: 'Could not load your transport quotes' });
    }
  }
);

// ============================================================================
// CREATE TRANSPORT JOB
// ----------------------------------------------------------------------------
// FIXED: Transport is now gated on buyerDecision === 'BUY' (the buyer's
// purchase commitment), not on the inspection report. What gets transported
// is goods, not paperwork. Inspection safety is preserved upstream in the
// buyer-decision endpoint.
// ============================================================================

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
    body('specialRequirements').optional().isString().trim().custom(noContactInfo),
    body('truckId').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        orderId, arrangingParty, method, pickupLocation, destination,
        load, requiredCapacity, specialRequirements, truckId,
      } = req.body;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          transportJob: true,
          listing: true,
          payments: true,
          inspectionRequests: { include: { payments: true } },
        },
      });

      if (!order) return res.status(404).json({ error: 'Order not found' });

      if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to arrange transport for this order' });
      }

      if (order.status !== 'CONFIRMED' && order.status !== 'PENDING_PAYMENT' && order.status !== 'TRANSPORT_ARRANGED') {
        return res.status(400).json({
          error: `Transport can only be arranged for orders in CONFIRMED, PENDING_PAYMENT, or TRANSPORT_ARRANGED state (current: ${order.status})`,
        });
      }

      if (order.transportJob && order.transportJob.status !== 'CANCELLED') {
        return res.status(409).json({ error: 'A transport job already exists for this order' });
      }

      const isAgricultural = order.listing?.category === 'AGRICULTURAL';
      const isPhysicalGoods = ['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category);

      // FIXED: Transport is gated on the buyer's purchase decision, not on
      // the inspection report. Once the buyer commits (BUY), the goods are
      // contractually moving and transport can be arranged.
      if (isPhysicalGoods && order.buyerDecision !== 'BUY') {
        return res.status(409).json({
          code: 'BUYER_DECISION_REQUIRED',
          error: 'The buyer must decide to purchase before transport can be arranged.',
        });
      }

      if (isAgricultural && order.listing.pickupWindowEnd) {
        const pickupDeadline = new Date(order.listing.pickupWindowEnd).getTime();
        if (Number.isFinite(pickupDeadline) && pickupDeadline <= Date.now()) {
          return res.status(409).json({
            error: 'The agricultural pickup window has expired. Update the listing/pickup window before arranging transport.',
          });
        }
      }

      let resolvedArrangingParty = arrangingParty;

      if (isPhysicalGoods && method === 'HIRE_TRANSPORTER' && resolvedArrangingParty !== 'BUYER') {
        return res.status(409).json({
          code: 'BUYER_TRANSPORT_COMPETITION_REQUIRED',
          error: 'Physical-goods hired transport is buyer-controlled: registered truck owners submit competing quotes and the buyer selects and negotiates the transporter.',
        });
      }

      if (!['SELLER', 'BUYER', 'JOINT'].includes(resolvedArrangingParty)) {
        return res.status(400).json({ error: 'arrangingParty must be SELLER, BUYER, or JOINT' });
      }

      if (method === 'OWN_TRUCK' && resolvedArrangingParty === 'JOINT') {
        return res.status(400).json({ error: 'JOINT arrangements must use HIRE_TRANSPORTER. Select SELLER or BUYER when using an own truck.' });
      }

      if (resolvedArrangingParty === 'SELLER' && order.sellerId !== req.user.id && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Only the seller can create a SELLER-arranged transport job' });
      }

      if (resolvedArrangingParty === 'BUYER' && order.buyerId !== req.user.id && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Only the buyer can create a BUYER-arranged transport job' });
      }

      if (resolvedArrangingParty === 'JOINT' && !isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Only the buyer or seller can create a JOINT transport arrangement' });
      }

      if (method === 'HIRE_TRANSPORTER') {
        const result = await prisma.$transaction(async (tx) => {
          const freshOrder = await tx.order.findUnique({
            where: { id: order.id },
            include: { transportJob: true },
          });

          if (!freshOrder) {
            const error = new Error('Order not found');
            error.statusCode = 404;
            throw error;
          }

          await lockOrderAndAssertNotClosed(tx, freshOrder.id, 'transport cannot be arranged until that is resolved');

          if (freshOrder.transportJob && freshOrder.transportJob.status !== 'CANCELLED') {
            const error = new Error('A transport job already exists for this order');
            error.statusCode = 409;
            throw error;
          }

          const transportJob = freshOrder.transportJob?.status === 'CANCELLED'
            ? await (async () => {
                await tx.transportQuote.deleteMany({ where: { transportJobId: freshOrder.transportJob.id } });
                return tx.transportJob.update({
                  where: { id: freshOrder.transportJob.id },
                  data: {
                    arrangingParty: resolvedArrangingParty, method, pickupLocation, destination, load,
                    requiredCapacity: requiredCapacity || null, specialRequirements: specialRequirements || null,
                    truckOwnerId: null, truckId: null, agreedAmount: null, status: 'REQUESTED',
                    pickupConfirmedAt: null, deliveredConfirmedAt: null, incidentNotes: null,
                    sellerPickupConfirmedAt: null,
                    sellerPreparationDueAt: null,
                    buyerLoadingConfirmedAt: null,
                    buyerLoadingDueAt: null,
                    truckArrivedAt: null,
                    truckArrivedConfirmedBy: null,
                    acceptedReleaseCount: 0,
                  },
                });
              })()
            : await tx.transportJob.create({
              data: {
                orderId: freshOrder.id,
                arrangingParty: resolvedArrangingParty,
                method, pickupLocation, destination, load,
                requiredCapacity: requiredCapacity || null,
                specialRequirements: specialRequirements || null,
                truckOwnerId: null, truckId: null,
                status: 'REQUESTED',
              },
            });

          await tx.order.update({
            where: { id: freshOrder.id },
            data: {
              arrangingParty: resolvedArrangingParty,
              ...(freshOrder.status === 'CONFIRMED' ? { status: 'TRANSPORT_ARRANGED' } : {}),
            },
          });

          await recordAuditEvent(tx, {
            actorId: req.user.id,
            action: 'TRANSPORT_JOB_CREATED',
            resourceType: 'TransportJob',
            resourceId: transportJob.id,
            metadata: { orderId: freshOrder.id, method, arrangingParty: resolvedArrangingParty, truckId: null, status: transportJob.status },
          });

          return transportJob;
        }, { maxWait: 10000, timeout: 15000 });

        return res.status(201).json({ transportJob: result });
      }

      if (!truckId) {
        return res.status(400).json({ error: 'truckId is required for OWN_TRUCK' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const freshOrder = await tx.order.findUnique({
          where: { id: order.id },
          include: { transportJob: true },
        });

        if (!freshOrder) {
          const error = new Error('Order not found');
          error.statusCode = 404;
          throw error;
        }

        await lockOrderAndAssertNotClosed(tx, freshOrder.id, 'transport cannot be arranged until that is resolved');

        if (freshOrder.transportJob && freshOrder.transportJob.status !== 'CANCELLED') {
          const error = new Error('A transport job already exists for this order');
          error.statusCode = 409;
          throw error;
        }

        const truck = await tx.truck.findUnique({ where: { id: truckId } });

        if (!truck) {
          const error = new Error('Truck not found');
          error.statusCode = 404;
          throw error;
        }

        if (truck.ownerId !== req.user.id && !isAdmin(req.user)) {
          const error = new Error('You do not own this truck');
          error.statusCode = 403;
          throw error;
        }

        await claimAvailableTruck(tx, truck.id);

        const transportJob = freshOrder.transportJob?.status === 'CANCELLED'
          ? await (async () => {
              await tx.transportQuote.deleteMany({ where: { transportJobId: freshOrder.transportJob.id } });
              return tx.transportJob.update({
                where: { id: freshOrder.transportJob.id },
                data: {
                  arrangingParty: resolvedArrangingParty, method, pickupLocation, destination, load,
                  requiredCapacity: requiredCapacity || null, specialRequirements: specialRequirements || null,
                  truckOwnerId: truck.ownerId, truckId: truck.id, agreedAmount: null, status: 'ACCEPTED',
                  sellerPreparationDueAt: computeSellerPreparationDueAt(), buyerLoadingDueAt: null,
                  pickupConfirmedAt: null, deliveredConfirmedAt: null, incidentNotes: null,
                  sellerPickupConfirmedAt: null,
                  buyerLoadingConfirmedAt: null,
                  truckArrivedAt: null,
                  truckArrivedConfirmedBy: null,
                  acceptedReleaseCount: 0,
                },
              });
            })()
          : await tx.transportJob.create({
            data: {
              orderId: freshOrder.id,
              arrangingParty: resolvedArrangingParty,
              method, pickupLocation, destination, load,
              requiredCapacity: requiredCapacity || null,
              specialRequirements: specialRequirements || null,
              truckOwnerId: truck.ownerId,
              truckId: truck.id,
              status: 'ACCEPTED',
              sellerPreparationDueAt: computeSellerPreparationDueAt(),
              buyerLoadingDueAt: null,
            },
          });

        await tx.order.update({
          where: { id: freshOrder.id },
          data: {
            arrangingParty: resolvedArrangingParty,
            ...(freshOrder.status === 'CONFIRMED' ? { status: 'TRANSPORT_ARRANGED' } : {}),
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_ASSIGNED',
          resourceType: 'TransportJob',
          resourceId: transportJob.id,
          metadata: {
            orderId: freshOrder.id, method, arrangingParty: resolvedArrangingParty,
            truckId: truck.id, truckOwnerId: truck.ownerId, status: transportJob.status,
          },
        });

        return transportJob;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ transportJob: result });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE TRANSPORT ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A transport job already exists for this order' });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not create transport job' });
    }
  }
);

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
      req.log.error({ err: error }, 'GET TRANSPORT ERROR:');
      return res.status(500).json({ error: 'Could not load transport job' });
    }
  }
);

async function getTransportPaymentGate(client, jobId) {
  const job = await client.transportJob.findUnique({
    where: { id: jobId },
    include: {
      order: {
        include: {
          payments: { select: { id: true, type: true, status: true, amount: true } },
          inspectionRequests: {
            where: { status: { not: 'CANCELLED' } },
            include: { payments: { select: { id: true, type: true, status: true, amount: true } } },
          },
          listing: { select: { category: true, pickupWindowEnd: true } },
        },
      },
      payments: { select: { id: true, type: true, status: true, amount: true } },
    },
  });

  if (!job) return { ready: false, missing: ['TRANSPORT_JOB'] };

  const transportRequired = job.method === 'HIRE_TRANSPORTER';
  const transportPaid = !transportRequired || job.payments.some(
    (p) => p.type === 'TRANSPORT' && p.status === 'PAID'
  );
  const missing = transportPaid ? [] : ['TRANSPORT'];
  return { ready: missing.length === 0, missing, transportRequired, transportPaid };
}

async function checkLoadingReportGate(client, jobId) {
  const job = await client.transportJob.findUnique({
    where: { id: jobId },
    include: {
      order: {
        include: {
          payments: { select: { id: true, type: true, status: true } },
          inspectionRequests: {
            where: { status: { not: 'CANCELLED' } },
            include: { payments: { select: { id: true, type: true, status: true } } },
          },
        },
      },
      payments: { select: { id: true, type: true, status: true } },
    },
  });

  if (!job) return { ready: false, missing: ['TRANSPORT_JOB'] };

  const missing = [];

  for (const r of job.order.inspectionRequests || []) {
    if (r.fee == null || Number(r.fee) <= 0) continue;
    const paid = (r.payments || []).some(
      (p) => p.type === 'INSPECTOR' && p.status === 'PAID'
    );
    if (!paid) missing.push(`INSPECTOR:${r.id}`);
  }

  if (job.method === 'HIRE_TRANSPORTER') {
    const transportPaid = (job.payments || []).some(
      (p) => p.type === 'TRANSPORT' && p.status === 'PAID'
    );
    if (!transportPaid) missing.push('TRANSPORT');
  }

  return { ready: missing.length === 0, missing };
}

router.patch('/:id/reopen-bidding', authenticate, requireRole('ADMIN'), requireMfa(), async (req, res) => {
  try {
    const job = await prisma.transportJob.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!job) return res.status(404).json({ error: 'Transport job not found' });
    if (!['REQUESTED', 'QUOTED'].includes(job.status)) return res.status(409).json({ error: `Transport bidding cannot be reopened while the job is ${job.status.toLowerCase()}` });
    const activePayment = await prisma.payment.findFirst({ where: { transportJobId: job.id, type: 'TRANSPORT', status: { in: ['PENDING', 'PROCESSING', 'PAID'] } }, select: { id: true, status: true } });
    if (activePayment) return res.status(409).json({ error: 'Bidding cannot be reopened after transport payment has started or completed' });

    const reopened = await prisma.$transaction(async (tx) => {
      await lockOrderAndAssertNotClosed(tx, job.orderId, 'transport bidding cannot be reopened until the order dispute is resolved');
      const fresh = await tx.transportJob.findUnique({ where: { id: job.id } });
      if (!fresh) throw Object.assign(new Error('Transport job not found'), { statusCode: 404 });
      if (!['REQUESTED', 'QUOTED'].includes(fresh.status)) throw Object.assign(new Error(`Transport bidding cannot be reopened while the job is ${fresh.status.toLowerCase()}`), { statusCode: 409 });
      const liveBidders = await tx.transportQuote.count({ where: { transportJobId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } } });
      if (liveBidders > 0) {
        throw Object.assign(new Error(`A fresh transport form cannot be released while ${liveBidders} transporter bid(s) are still waiting or pending. They stay pending until the selected transporter delivers or they release themselves.`), { statusCode: 409 });
      }
      const updated = await tx.transportJob.update({
        where: { id: fresh.id },
        data: {
          truckOwnerId: null,
          truckId: null,
          agreedAmount: null,
          status: 'REQUESTED',
          truckArrivedAt: null,
          truckArrivedConfirmedBy: null,
          sellerPickupConfirmedAt: null,
          sellerPreparationDueAt: null,
          buyerLoadingConfirmedAt: null,
          buyerLoadingDueAt: null,
          acceptedReleaseCount: 0,
        },
      });
      await closeCoordination(tx, fresh.id, 'ADMIN_REOPENED_BIDDING');
      await recordOrderEvent(tx, { orderId: fresh.orderId, actorId: req.user.id, type: 'TRANSPORT_COORDINATION_CLOSED', metadata: { transportJobId: fresh.id, reason: 'ADMIN_REOPENED_BIDDING' } });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'TRANSPORT_BIDDING_REOPENED', resourceType: 'TransportJob', resourceId: fresh.id, metadata: { orderId: fresh.orderId } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });

    await noticeTransportWaitingUnlocked(prisma, {
      transportJobId: reopened.id,
      reason: 'ADMIN_REOPENED_BIDDING',
    });

    return res.json({ message: 'Fresh transport form released.', transportJob: reopened });
  } catch (error) {
    req.log.error({ err: error }, 'REOPEN TRANSPORT BIDDING ERROR:');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not reopen transport bidding' });
  }
});

router.post('/:id/seller-confirm-pickup', authenticate, requireRole('SELLER'), [param('id').isUUID(), body('message').optional().isString().trim().isLength({ max: 500 })], validate, async (req, res) => {
  try {
    const job = await prisma.transportJob.findUnique({ where: { id: req.params.id }, include: { order: { select: { id: true, sellerId: true } } } });
    if (!job) return res.status(404).json({ error: 'Transport job not found' });
    if (job.order.sellerId !== req.user.id) return res.status(403).json({ error: 'Only the listing seller can confirm pickup readiness' });
    if (job.status !== 'ACCEPTED') return res.status(409).json({ error: 'Seller pickup confirmation is available only after the transporter is selected and accepted' });
    if (job.sellerPickupConfirmedAt) return res.status(409).json({ error: 'Pickup readiness was already confirmed' });
    const updated = await prisma.transportJob.updateMany({ where: { id: job.id, status: 'ACCEPTED', sellerPickupConfirmedAt: null }, data: { sellerPickupConfirmedAt: new Date(), sellerPickupMessage: req.body?.message || null, sellerPickupMessageAt: req.body?.message ? new Date() : null } });
    if (!updated.count) return res.status(409).json({ error: 'Transport status changed; refresh and try again' });
    await prisma.transportJob.updateMany({
      where: { id: job.id, status: 'ACCEPTED' },
      data: { sellerPreparationDueAt: null },
    });
    await recordAuditEvent(prisma, { actorId: req.user.id, action: 'TRANSPORT_SELLER_PICKUP_CONFIRMED', resourceType: 'TransportJob', resourceId: job.id, metadata: { orderId: job.orderId, message: req.body?.message || null } }).catch(() => {});
    await recordOrderEvent(prisma, { orderId: job.orderId, actorId: req.user.id, type: 'TRANSPORT_SELLER_PICKUP_CONFIRMED', metadata: { transportJobId: job.id, message: req.body?.message || null } }).catch(() => {});
    return res.json({ message: 'Transporter preparation confirmed. The transporter may now proceed with loading preparation.', sellerPickupConfirmedAt: new Date().toISOString() });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER TRANSPORT PICKUP CONFIRM ERROR');
    return res.status(500).json({ error: 'Could not confirm transport pickup readiness' });
  }
});

router.post('/:id/truck-arrived', authenticate, async (req, res) => {
  try {
    const job = await prisma.transportJob.findUnique({
      where: { id: req.params.id },
      include: { order: { select: { id: true, sellerId: true, buyerId: true, status: true } } },
    });
    if (!job) return res.status(404).json({ error: 'Transport job not found' });
    if (job.method !== 'HIRE_TRANSPORTER') {
      return res.status(409).json({ error: 'Truck arrival confirmation only applies to hired transport' });
    }
    if (job.status !== 'ACCEPTED') {
      return res.status(409).json({ error: `Truck arrival can only be confirmed while the job is ACCEPTED (current: ${job.status})` });
    }

    const isSeller = job.order?.sellerId === req.user.id;
    const isTransporter = job.truckOwnerId === req.user.id;
    if (!isSeller && !isTransporter && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Only the seller or the assigned transporter can confirm truck arrival' });
    }
    if (!job.sellerPickupConfirmedAt) {
      return res.status(409).json({
        code: 'SELLER_LOADING_PREPARATION_REQUIRED',
        error: 'The seller must first confirm that goods are prepared for loading.',
      });
    }
    if (job.truckArrivedAt) {
      return res.status(409).json({ error: 'Truck arrival was already confirmed' });
    }

    const now = new Date();
    const role = isSeller ? 'SELLER' : isTransporter ? 'TRANSPORTER' : 'ADMIN';

    const changed = await prisma.transportJob.updateMany({
      where: { id: job.id, status: 'ACCEPTED', truckArrivedAt: null },
      data: { truckArrivedAt: now, truckArrivedConfirmedBy: req.user.id },
    });
    if (!changed.count) {
      return res.status(409).json({ error: 'Transport status changed; refresh and try again' });
    }

    await syncOrderPaymentObligations(prisma, job.orderId).catch(() => {});

    await recordAuditEvent(prisma, {
      actorId: req.user.id,
      action: 'TRANSPORT_TRUCK_ARRIVED',
      resourceType: 'TransportJob',
      resourceId: job.id,
      metadata: { orderId: job.orderId, role },
    }).catch(() => {});
    await recordOrderEvent(prisma, {
      orderId: job.orderId,
      actorId: req.user.id,
      type: 'TRANSPORT_TRUCK_ARRIVED',
      metadata: { transportJobId: job.id, role },
    }).catch(() => {});

    return res.json({
      message: 'Truck arrival confirmed.',
      truckArrivedAt: now.toISOString(),
    });
  } catch (error) {
    req.log.error({ err: error }, 'TRANSPORT TRUCK ARRIVED ERROR');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not confirm truck arrival' });
  }
});

router.post(
  '/:id/confirm-loading',
  authenticate,
  requireRole('BUYER'),
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });
      if (!job) return res.status(404).json({ error: 'Transport job not found' });
      if (job.order.buyerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Only the buyer can confirm the loading report' });
      if (job.status !== 'ACCEPTED') return res.status(409).json({ error: 'Loading can only be confirmed while the transporter is accepted and waiting for loading' });
      if (!job.sellerPickupConfirmedAt) return res.status(409).json({ code: 'SELLER_TRANSPORT_PREPARATION_CONFIRMATION_REQUIRED', error: 'The seller must confirm transporter preparation first.' });
      if (!job.truckArrivedAt) return res.status(409).json({ code: 'TRUCK_ARRIVAL_REQUIRED', error: 'The truck must be on site before the loading report can be approved.' });
      const report = await prisma.transportLoadingReport.findUnique({ where: { transportJobId: job.id } });
      if (!report) return res.status(409).json({ code: 'LOADING_REPORT_REQUIRED', error: 'The transporter must submit the loading report before it can be approved.' });
      if (job.order.buyerDecision !== 'BUY') return res.status(409).json({ code: 'BUYER_DECISION_REQUIRED', error: 'The buyer must make the final BUY decision first.' });

      // FIXED: The loading-prep report approval is what unlocks goods payment.
      // Only the transport fee must be settled at this stage; goods payment
      // is created HERE, after approval.
      const transportPaid = await prisma.payment.findFirst({ where: { transportJobId: job.id, type: 'TRANSPORT', status: 'PAID' }, select: { id: true } });
      if (!transportPaid) return res.status(409).json({ code: 'TRANSPORT_PAYMENT_REQUIRED', error: 'The transporter must be paid before the loading report can be approved.' });

      const reviewAt = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.transportJob.updateMany({ where: { id: job.id, status: 'ACCEPTED', buyerLoadingConfirmedAt: null }, data: { buyerLoadingConfirmedAt: reviewAt, buyerLoadingDueAt: null } });
        if (!changed.count) return 0;
        const reviewed = await tx.transportLoadingReport.updateMany({
          where: { id: report.id, buyerReviewStatus: 'PENDING' },
          data: { buyerReviewStatus: 'ACCEPTED', buyerReviewedAt: reviewAt, buyerReviewedById: req.user.id, buyerReviewNotes: 'Buyer approved the loading report.' },
        });
        if (!reviewed.count) throw Object.assign(new Error('LOADING_REPORT_REVIEW_CHANGED'), { status: 409 });
        return 1;
      });
      if (!updated) return res.status(409).json({ error: 'Loading confirmation changed; refresh and try again.' });
      await recordAuditEvent(prisma, { actorId: req.user.id, action: 'TRANSPORT_LOADING_CONFIRMED_BY_BUYER', resourceType: 'TransportJob', resourceId: job.id, metadata: { orderId: job.orderId, loadingReportId: report.id } }).catch(() => {});
      await recordOrderEvent(prisma, { orderId: job.orderId, actorId: req.user.id, type: 'TRANSPORT_LOADING_CONFIRMED_BY_BUYER', metadata: { transportJobId: job.id, loadingReportId: report.id } }).catch(() => {});

      // FIXED: The approval of the loading-prep report is the event that
      // creates the goods payment obligation.
      await syncOrderPaymentObligations(prisma, job.orderId).catch(() => {});

      // FIXED: reset the goods payment deadline now that goods payment
      // has just been unlocked. Without this the order's paymentDueAt
      // stays stale and the buyer's payment window is miscomputed.
      await prisma.order.update({
        where: { id: job.orderId },
        data: { paymentDueAt: computePaymentDueAt() },
      }).catch(() => {});

      return res.json({ message: 'Loading report approved. Goods payment is now unlocked. The transporter may proceed with loading once the seller payment is settled.', buyerLoadingConfirmedAt: new Date().toISOString() });
    } catch (error) {
      req.log.error({ err: error }, 'BUYER LOADING CONFIRM ERROR');
      return res.status(500).json({ error: 'Could not confirm the loading report' });
    }
  }
);

// ============================================================================
// UPDATE TRANSPORT STATUS
// ----------------------------------------------------------------------------
// Cancellation is no longer blocked by a settled transport payment. If the
// transport was paid, the transaction queues a refund through the normal
// Chapa flow. Only an in-flight payment (PENDING / PROCESSING) blocks the
// cancel, so the amount is not duplicated by a second refund request.
// ============================================================================

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
        include: {
          order: { include: { listing: true } },
          evidence: { select: { id: true, type: true } },
        },
      });

      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' && (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));

      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized to update this transport job' });
      }

      const current = job.status;
      const next = req.body.status;

      if (next === 'PICKUP' && !isAdmin(req.user)) {
        if (job.order.sellerId && !job.sellerPickupConfirmedAt) {
          return res.status(409).json({ code: 'SELLER_PICKUP_CONFIRMATION_REQUIRED', error: 'The seller must confirm goods are prepared for loading.' });
        }
        if (!job.truckArrivedAt) {
          return res.status(409).json({ code: 'TRUCK_ARRIVAL_REQUIRED', error: 'The truck must be on site before pickup can be recorded.' });
        }
        const loadingReport = await prisma.transportLoadingReport.findUnique({ where: { transportJobId: job.id }, select: { id: true } });
        if (!loadingReport) return res.status(409).json({ code: 'LOADING_REPORT_REQUIRED', error: 'The transporter must submit the loading report before pickup.' });
        if (!job.buyerLoadingConfirmedAt) return res.status(409).json({ code: 'BUYER_LOADING_CONFIRMATION_REQUIRED', error: 'The buyer must review and approve the loading report before pickup.' });

        // FIXED: PICKUP means "loaded and awaiting goods payment". The buyer
        // must settle the seller before the truck can be marked as loaded.
        const goodsPaid = await prisma.payment.findFirst({ where: { orderId: job.orderId, type: 'MARKETPLACE', status: 'PAID' }, select: { id: true } });
        if (!goodsPaid) {
          return res.status(409).json({ code: 'GOODS_PAYMENT_REQUIRED', error: 'The buyer must pay for the goods before the truck can be marked as loaded.' });
        }
      }

      if (job.method === 'HIRE_TRANSPORTER' && next === 'ACCEPTED') {
        return res.status(409).json({
          code: 'PAYMENT_BACKED_ACCEPTANCE_REQUIRED',
          error: 'Hired transport becomes committed only through the accepted quote and transport payment workflow.',
        });
      }

      if (job.order?.status === 'DISPUTED') {
        return res.status(409).json({
          code: 'ORDER_DISPUTED',
          error: 'This order is under dispute. Transport proceedings are paused until the dispute is resolved.',
        });
      }

      const movementStatus = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];
      if (movementStatus.includes(next) && !isTruckOwner && !isAdmin(req.user)) {
        return res.status(403).json({
          code: 'TRANSPORTER_ACTION_REQUIRED',
          error: `Only the assigned transporter can mark transport as ${next.replace('_', ' ').toLowerCase()}.`,
        });
      }

      const validTransitions = {
        REQUESTED: ['ACCEPTED', 'QUOTED', 'CANCELLED'],
        QUOTED: ['ACCEPTED', 'CANCELLED'],
        ACCEPTED: ['PICKUP', 'CANCELLED'],
        PICKUP: ['IN_TRANSIT'],
        IN_TRANSIT: ['DELIVERED'],
        DELIVERED: ['DELIVERED'],
        CANCELLED: [],
      };

      if (!validTransitions[current]?.includes(next)) {
        return res.status(400).json({ error: `Invalid status transition from ${current} to ${next}` });
      }

      if (next === 'CANCELLED' && ['PICKUP', 'IN_TRANSIT'].includes(current) && !isAdmin(req.user)) {
        return res.status(409).json({
          code: 'TRANSPORT_MOVEMENT_STARTED',
          error: 'Transport cannot be cancelled after pickup has started. Open or resolve a dispute instead.',
        });
      }

      if (next === 'CANCELLED' && job.method === 'HIRE_TRANSPORTER') {
        const inFlightPayment = await prisma.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          select: { id: true, status: true },
        });
        if (inFlightPayment && !isAdmin(req.user)) {
          return res.status(409).json({
            code: 'TRANSPORT_PAYMENT_ACTIVE',
            error: 'A transport payment is still in flight. Wait for it to settle or fail, then try again.',
          });
        }
      }

      if (next === 'PICKUP' && job.order.listing?.category === 'AGRICULTURAL' && job.order.listing.pickupWindowEnd) {
        const pickupDeadline = new Date(job.order.listing.pickupWindowEnd).getTime();
        if (Number.isFinite(pickupDeadline) && pickupDeadline <= Date.now()) {
          return res.status(409).json({
            error: 'The agricultural pickup window has expired. Pickup cannot be confirmed until the listing window is updated.',
          });
        }
      }

      if (next === 'IN_TRANSIT' && !job.evidence.some((item) => item.type === 'PICKUP' || item.type === 'LOADING')) {
        return res.status(409).json({ error: 'Pickup evidence is required before transport can enter IN_TRANSIT' });
      }

      if (next === 'DELIVERED' && !job.evidence.some((item) => item.type === 'DELIVERY')) {
        return res.status(409).json({ error: 'Delivery evidence is required before transport can be marked DELIVERED' });
      }

      if (next === 'IN_TRANSIT') {
        const gate = await getTransportPaymentGate(prisma, job.id);
        if (!gate.ready) {
          return res.status(409).json({
            code: 'PAYMENTS_REQUIRED_BEFORE_TRANSIT',
            error: 'Required payments must be completed before the truck can enter IN_TRANSIT.',
            missingPayments: gate.missing,
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, job.orderId, 'transport cannot proceed until the order dispute is resolved');

        const updated = await tx.transportJob.update({
          where: { id: job.id },
          data: {
            status: next,
            incidentNotes: req.body.incidentNotes || job.incidentNotes,
            pickupConfirmedAt: next === 'PICKUP' ? new Date() : job.pickupConfirmedAt,
            deliveredConfirmedAt: next === 'DELIVERED' ? new Date() : job.deliveredConfirmedAt,
          },
        });

        await syncOrderPaymentObligations(tx, job.orderId);
        await recordOrderEvent(tx, {
          orderId: job.orderId,
          actorId: req.user.id,
          type: 'TRANSPORT_STATUS_CHANGED',
          fromStatus: current,
          toStatus: next,
          metadata: {
            transportJobId: job.id, truckId: job.truckId,
            arrangingParty: job.arrangingParty, method: job.method,
          },
        });

        if (next === 'IN_TRANSIT') {
          const freshOrder = await tx.order.findUnique({ where: { id: job.orderId }, select: { status: true } });
          if (freshOrder?.status === 'TRANSPORT_ARRANGED') {
            await transitionOrderStatus(tx, job.orderId, 'TRANSPORT_ARRANGED', 'IN_TRANSIT');
          }
          // FIXED: if the order is still CONFIRMED (e.g. own-truck path or
          // legacy data), walk the order through TRANSPORT_ARRANGED so the
          // state machine's CONFIRMED -> IN_TRANSIT jump is not rejected.
          if (freshOrder?.status === 'CONFIRMED') {
            await transitionOrderStatus(tx, job.orderId, 'CONFIRMED', 'TRANSPORT_ARRANGED');
            await transitionOrderStatus(tx, job.orderId, 'TRANSPORT_ARRANGED', 'IN_TRANSIT');
          }
        }

        if (next === 'DELIVERED') {
          const freshOrder = await tx.order.findUnique({ where: { id: job.orderId }, select: { status: true } });
          if (freshOrder?.status === 'TRANSPORT_ARRANGED') {
            await transitionOrderStatus(tx, job.orderId, 'TRANSPORT_ARRANGED', 'DELIVERED');
          } else if (freshOrder?.status === 'IN_TRANSIT') {
            await transitionOrderStatus(tx, job.orderId, 'IN_TRANSIT', 'DELIVERED');
          } else if (freshOrder?.status === 'CONFIRMED') {
            await transitionOrderStatus(tx, job.orderId, 'CONFIRMED', 'TRANSPORT_ARRANGED');
            await transitionOrderStatus(tx, job.orderId, 'TRANSPORT_ARRANGED', 'DELIVERED');
          }

          await releaseTruck(tx, job.truckId);
        }

        if (next === 'CANCELLED') {
          await releaseTruck(tx, job.truckId);

          const paidTransportPayments = await tx.payment.findMany({
            where: { transportJobId: job.id, type: 'TRANSPORT', status: 'PAID' },
            select: { id: true },
          });
          for (const p of paidTransportPayments) {
            await paymentService.requestRefund(tx, {
              paymentId: p.id,
              reason: 'Transport cancelled — refunding paid amount',
              requestedById: req.user.id,
            });
          }
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_STATUS_CHANGED',
          resourceType: 'TransportJob',
          resourceId: job.id,
          metadata: { orderId: job.orderId, fromStatus: current, toStatus: next, truckId: job.truckId },
        });

        return updated;
      }, { maxWait: 10000, timeout: 20000 });

      if (next === 'DELIVERED') {
        await releaseWaitingTransporters(prisma, {
          transportJobId: job.id,
          actorId: req.user.id,
          reason: 'TRANSPORT_DELIVERED',
        });
      }

      if (next === 'CANCELLED') {
        await releaseWaitingTransporters(prisma, {
          transportJobId: job.id,
          actorId: req.user.id,
          reason: 'TRANSPORT_CANCELLED',
        });
      }

      return res.json({ transportJob: result });
    } catch (error) {
      req.log.error({ err: error }, 'UPDATE TRANSPORT STATUS ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      }

      if (error?.code === 'P2028') {
        return res.status(503).json({
          code: 'TRANSPORT_STATUS_TIMEOUT',
          error: 'Transport status update timed out. Refresh the order and try again.',
        });
      }

      if (error?.code === 'P2025') {
        return res.status(409).json({
          code: 'TRANSPORT_STATUS_CONFLICT',
          error: 'The transport status changed before this action completed. Refresh the order and try again.',
        });
      }

      return res.status(500).json({ error: error?.message || 'Could not update transport status' });
    }
  }
);

// ============================================================================
// TESTABLE INTERNAL CONSTANTS
// ============================================================================

router.ACTIVE_TRUCK_JOB_STATUSES = ACTIVE_TRUCK_JOB_STATUSES;
router.claimAvailableTruck = claimAvailableTruck;

// ============================================================================
// TRANSPORT LOADING REPORT
// ============================================================================

router.post(
  '/:id/loading-report',
  authenticate,
  requireRole('TRUCK_OWNER'),
  idempotency('transport.loading-report'),
  [
    param('id').isUUID(),
    body('whatLoaded').isIn(LOADING_WHAT_OPTIONS),
    body('quantityLoaded').isFloat({ gt: 0 }),
    body('quantityUnit').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('qualityAtLoading').optional({ nullable: true }).isIn(LOADING_QUALITY_OPTIONS),
    body('visibleIssues').optional().isArray(),
    body('arrivedAt').optional({ nullable: true }).isISO8601(),
    body('loadingStartedAt').optional({ nullable: true }).isISO8601(),
    body('loadingFinishedAt').optional({ nullable: true }).isISO8601(),
    body('gpsLocation').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }).custom(noContactInfo),
    body('photos').optional().isArray(),
    body('videos').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    try {
      const isAdminUser = isAdmin(req.user);

      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });
      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      if (job.truckOwnerId !== req.user.id && !isAdminUser) {
        return res.status(403).json({ error: 'Only the assigned transporter can submit the loading report' });
      }
      if (job.status !== 'ACCEPTED') {
        return res.status(409).json({
          code: 'LOADING_REPORT_NOT_OPEN',
          error: `The loading report can be submitted only while the transport is ACCEPTED (current: ${job.status})`,
        });
      }
      if (!job.sellerPickupConfirmedAt && !isAdminUser) {
        return res.status(409).json({
          code: 'SELLER_PICKUP_CONFIRMATION_REQUIRED',
          error: 'The seller must confirm that the goods are ready for pickup before the loading report can be submitted.',
        });
      }
      if (!job.truckArrivedAt && !isAdminUser) {
        return res.status(409).json({
          code: 'TRUCK_ARRIVAL_REQUIRED',
          error: 'The truck must be on site before the loading report can be submitted.',
        });
      }

      const issues = Array.isArray(req.body.visibleIssues) ? req.body.visibleIssues.filter(Boolean) : [];
      const unknownIssues = issues.filter((i) => !LOADING_ISSUE_OPTIONS.includes(i));
      if (unknownIssues.length) {
        return res.status(400).json({ error: `Unknown issue flags: ${unknownIssues.join(', ')}` });
      }

      const parseOpt = (v) => (v == null || v === '' ? null : new Date(v));
      const arrivedAt = parseOpt(req.body.arrivedAt);
      const loadingStartedAt = parseOpt(req.body.loadingStartedAt);
      const loadingFinishedAt = parseOpt(req.body.loadingFinishedAt);

      if (arrivedAt && loadingStartedAt && arrivedAt > loadingStartedAt) {
        return res.status(400).json({ error: 'arrivedAt cannot be later than loadingStartedAt' });
      }
      if (loadingStartedAt && loadingFinishedAt && loadingStartedAt > loadingFinishedAt) {
        return res.status(400).json({ error: 'loadingStartedAt cannot be later than loadingFinishedAt' });
      }

      // FIXED: The loading-prep report comes BEFORE goods payment. Its
      // approval is what unlocks goods payment. Only the transport fee must
      // be settled at this point.
      const transportPaid = await prisma.payment.findFirst({ where: { transportJobId: job.id, type: 'TRANSPORT', status: 'PAID' }, select: { id: true } });
      if (!transportPaid) return res.status(409).json({ code: 'TRANSPORT_PAYMENT_REQUIRED', error: 'The transporter must be paid before the loading report can be submitted.' });

      const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
      const videos = Array.isArray(req.body.videos) ? req.body.videos.filter(Boolean) : [];
      if (!photos.length && !videos.length) {
        return res.status(400).json({ error: 'At least one photo or video of the loaded goods is required' });
      }

      const report = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, job.orderId, 'loading cannot begin until the order dispute is resolved');

        const fresh = await tx.transportJob.findUnique({ where: { id: job.id } });
        if (!fresh || fresh.status !== 'ACCEPTED') {
          throw quoteError('This transport is no longer awaiting pickup', 409);
        }

        const existing = await tx.transportLoadingReport.findUnique({ where: { transportJobId: job.id } });
        if (existing) {
          throw quoteError('A loading report has already been submitted for this transport', 409);
        }

        const created = await tx.transportLoadingReport.create({
          data: {
            transportJobId: job.id,
            submittedById: req.user.id,
            whatLoaded: req.body.whatLoaded,
            quantityLoaded: Number(req.body.quantityLoaded),
            quantityUnit: req.body.quantityUnit || null,
            qualityAtLoading: req.body.qualityAtLoading || null,
            visibleIssues: issues,
            arrivedAt, loadingStartedAt, loadingFinishedAt,
            gpsLocation: req.body.gpsLocation || null,
            notes: req.body.notes || null,
          },
        });

        await tx.transportEvidence.create({
          data: {
            transportJobId: job.id,
            type: 'LOADING',
            photos, videos,
            gpsLocation: req.body.gpsLocation || null,
            notes: req.body.notes || null,
            capturedAt: loadingFinishedAt || new Date(),
            createdById: req.user.id,
          },
        });

        const buyerLoadingDueAt = computeBuyerLoadingDueAt();
        await tx.transportJob.update({
          where: { id: job.id },
          data: { buyerLoadingDueAt },
        });

        await recordOrderEvent(tx, {
          orderId: job.orderId,
          actorId: req.user.id,
          type: 'TRANSPORT_LOADING_REPORT_SUBMITTED',
          fromStatus: 'ACCEPTED',
          toStatus: 'ACCEPTED',
          metadata: {
            transportJobId: job.id,
            whatLoaded: created.whatLoaded,
            quantityLoaded: String(created.quantityLoaded),
            quantityUnit: created.quantityUnit,
            qualityAtLoading: created.qualityAtLoading,
            visibleIssues: issues,
            buyerLoadingDueAt: buyerLoadingDueAt.toISOString(),
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_LOADING_REPORT_SUBMITTED',
          resourceType: 'TransportLoadingReport',
          resourceId: created.id,
          metadata: { transportJobId: job.id, orderId: job.orderId },
        });

        return created;
      }, { maxWait: 10000, timeout: 20000 });

      const loadingDeadline = await prisma.transportJob.findUnique({
        where: { id: job.id },
        select: { buyerLoadingDueAt: true },
      });

      return res.status(201).json({
        message: 'Loading report recorded. The buyer can now review and approve the loading plan before physical loading.',
        loadingReport: report,
        reportEnvelope: buildBuyerReportEnvelope(report, 'TRANSPORT_LOADING'),
        buyerLoadingDueAt: loadingDeadline?.buyerLoadingDueAt?.toISOString() || null,
      });
    } catch (error) {
      req.log.error({ err: error }, 'TRANSPORT LOADING REPORT ERROR:');
      if (error.statusCode) {
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      }
      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ code: error.code, error: error.message });
      }
      return res.status(500).json({ error: error.message || 'Could not record loading report' });
    }
  }
);

router.get(
  '/:id/loading-report',
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

      const isParticipant = isOrderParticipant(req.user.id, job.order);
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isParticipant && !isTruckOwner && !isAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized to view this loading report' });
      }

      const report = await prisma.transportLoadingReport.findUnique({
        where: { transportJobId: job.id },
        include: { submittedBy: { select: { id: true, name: true } } },
      });

      if (!report) return res.json({ loadingReport: null, evidence: null });

      const evidence = await prisma.transportEvidence.findFirst({
        where: { transportJobId: job.id, type: 'LOADING' },
        select: { id: true, photos: true, videos: true, gpsLocation: true, notes: true, capturedAt: true },
        orderBy: { capturedAt: 'desc' },
      });

      return res.json({ loadingReport: report, reportEnvelope: buildBuyerReportEnvelope(report, 'TRANSPORT_LOADING'), evidence });
    } catch (error) {
      req.log.error({ err: error }, 'GET TRANSPORT LOADING REPORT ERROR:');
      return res.status(500).json({ error: 'Could not load loading report' });
    }
  }
);

module.exports = router;
