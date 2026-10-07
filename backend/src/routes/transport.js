const express = require('express');
const { body, param, validationResult } = require('express-validator');


const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { syncOrderPaymentObligations } = require('../services/paymentObligationService');
const { transitionOrderStatus, lockOrderAndAssertNotClosed } = require('../services/orderStateMachine');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { isOrderParticipant, isAdmin } = require('../utils/authorization');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { idempotency } = require('../middleware/idempotency');
const { matchTrucks } = require('../services/transportMatchingService');
const {
  AMOUNT_LIMITS,
  validAmount,
  noContactInfo,
} = require('../utils/contactGuard');
const {
  assertCoordinationStage,
  viewerRoleFor,
  closeCoordination,
  ensureOpenCoordination,
} = require('../services/transportCoordinationService');

const router = express.Router();

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_TRUCK_JOB_STATUSES = [
  'ACCEPTED',
  'PICKUP',
  'IN_TRANSIT',
];

// ============================================================================
// TRANSPORT LOADING REPORT — ENUM VALUES
// ----------------------------------------------------------------------------
// Structured, dropdown-only inputs. No free text can carry a phone number.
// ============================================================================

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

// ============================================================================
// TRANSPORT QUOTE NEGOTIATION HELPERS
// Counter mutates the existing quote row in place (same pattern as the
// inspection quote negotiation) to satisfy the unique
// (transportJobId, truckOwnerId) constraint on TransportQuote.
// ============================================================================

function quoteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'SELECTED') return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function isQuoteExpired(quote) {
  return Boolean(quote.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
}

function quoteExpiry(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// ============================================================================
// SILENT-RELEASE WINDOW (mirrors INSPECTION_RELEASE_AFTER_HOURS)
// ----------------------------------------------------------------------------
// If the requester has selected a truck owner (or countered them) and the
// truck owner goes silent, the requester needs a way to release the abandoned
// negotiation and negotiate with another waiting bid. The window is measured
// from the quote's last update so a fresh counter resets the clock.
// ============================================================================
function transportReleaseAfterHours() {
  const configured = Number(process.env.TRANSPORT_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 72;
}

function transportReleaseAvailableAt(quote) {
  if (!quote) return null;
  const providerTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');
  if (!providerTurn) return null;
  const since = new Date(quote.updatedAt || quote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + transportReleaseAfterHours() * 60 * 60 * 1000);
}

function isArrangingParty(job, order, userId) {
  return (
    (job.arrangingParty === 'SELLER' && order.sellerId === userId) ||
    (job.arrangingParty === 'BUYER' && order.buyerId === userId) ||
    (job.arrangingParty === 'JOINT' && (order.buyerId === userId || order.sellerId === userId))
  );
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
    where: {
      id: truckId,
      availability: 'AVAILABLE',
    },
    data: {
      availability: 'BUSY',
    },
  });

  if (result.count !== 1) {
    throw new TruckConflictError(
      'Selected truck is no longer available'
    );
  }

  return tx.truck.findUnique({
    where: {
      id: truckId,
    },
  });
}

async function releaseTruck(tx, truckId) {
  if (!truckId) return;

  await tx.truck.updateMany({
    where: {
      id: truckId,
      availability: 'BUSY',
    },
    data: {
      availability: 'AVAILABLE',
    },
  });
}

async function lockTruckRow(tx, truckId) {
  const truck = await tx.truck.findUnique({
    where: {
      id: truckId,
    },
  });

  if (!truck) {
    return null;
  }

  await tx.truck.update({
    where: {
      id: truckId,
    },
    data: {
      availability: truck.availability,
    },
  });

  return tx.truck.findUnique({
    where: {
      id: truckId,
    },
  });
}

// ============================================================================
// TRUCK MANAGEMENT
// ============================================================================

router.post(
  '/trucks',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    body('registration').isString().trim().notEmpty(),
    body('truckType').isString().trim().notEmpty(),
    body('capacity').isFloat({ gt: 0 }),
    body('operatingArea').optional().isString().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        registration,
        truckType,
        capacity,
        operatingArea,
      } = req.body;

      const truck = await prisma.truck.create({
        data: {
          ownerId: req.user.id,
          registration: registration.trim(),
          truckType: truckType.trim(),
          capacity: Number(capacity),
          operatingArea: operatingArea?.trim() || '',
        },
      });

      return res.status(201).json({
        truck,
      });
    } catch (error) {
      req.log.error({ err: error }, 'REGISTER TRUCK ERROR:');

      if (error.code === 'P2002') {
        return res.status(409).json({
          error:
            'A truck with this registration already exists',
        });
      }

      return res.status(500).json({
        error: 'Could not register truck',
      });
    }
  }
);

router.get(
  '/trucks/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const trucks =
        await prisma.truck.findMany({
          where: {
            ownerId: req.user.id,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

      return res.json({
        trucks,
      });
    } catch (error) {
      req.log.error({ err: error }, 'MY TRUCKS ERROR:');

      return res.status(500).json({
        error: 'Could not load your trucks',
      });
    }
  }
);

router.patch(
  '/trucks/:id/availability',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    param('id').isUUID(),
    body('availability').isIn([
      'AVAILABLE',
      'BUSY',
      'OFFLINE',
    ]),
  ],
  validate,
  async (req, res) => {
    try {
      const requestedAvailability =
        req.body.availability;

      const result = await prisma.$transaction(
        async (tx) => {
          const truck = await lockTruckRow(
            tx,
            req.params.id
          );

          if (!truck) {
            const error = new Error(
              'Truck not found'
            );
            error.statusCode = 404;
            throw error;
          }

          if (
            truck.ownerId !== req.user.id &&
            !isAdmin(req.user)
          ) {
            const error = new Error(
              'Not your truck'
            );
            error.statusCode = 403;
            throw error;
          }

          if (
            requestedAvailability === 'AVAILABLE'
          ) {
            const activeJob =
              await tx.transportJob.findFirst({
                where: {
                  truckId: truck.id,
                  status: {
                    in:
                      ACTIVE_TRUCK_JOB_STATUSES,
                  },
                },
                select: {
                  id: true,
                  status: true,
                },
              });

            if (activeJob) {
              throw new ActiveTruckAssignmentError(
                'Truck cannot be made AVAILABLE while it has an active transport job'
              );
            }
          }

          return tx.truck.update({
            where: {
              id: truck.id,
            },
            data: {
              availability:
                requestedAvailability,
            },
          });
        },
        { maxWait: 10000, timeout: 15000 }
      );

      return res.json({
        truck: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'UPDATE TRUCK AVAILABILITY ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
        });
      }

      if (
        error.code ===
        'ACTIVE_TRUCK_ASSIGNMENT'
      ) {
        return res.status(409).json({
          error: error.message,
        });
      }

      return res.status(500).json({
        error:
          'Could not update truck availability',
      });
    }
  }
);

router.get(
  '/open',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const jobs =
        await prisma.transportJob.findMany({
          where: {
            method: 'HIRE_TRANSPORTER',
            status: {
              in: ['REQUESTED', 'QUOTED'],
            },
            payments: {
              none: {
                type: 'TRANSPORT',
                status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
              },
            },
          },
          include: {
            order: {
              include: {
                buyer: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
                seller: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            quotes: {
              where: {
                truckOwnerId: req.user.id,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

      return res.json({
        jobs,
      });
    } catch (error) {
      req.log.error({ err: error }, 'OPEN TRANSPORT JOBS ERROR:');

      return res.status(500).json({
        error:
          'Could not load open transport jobs',
      });
    }
  }
);

router.get(
  '/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const jobs =
        await prisma.transportJob.findMany({
          where: {
            truckOwnerId: req.user.id,
          },
          include: {
            order: {
              include: {
                payments: { select: { type: true, status: true } },
                listing: { select: { category: true } },
                inspectionRequests: {
                  where: { status: { not: 'CANCELLED' } },
                  select: { id: true, status: true, fee: true, payments: { select: { type: true, status: true } } },
                },
                buyer: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
                seller: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            truck: true,
            quotes: {
              where: {
                truckOwnerId: req.user.id,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

      return res.json({
        jobs,
      });
    } catch (error) {
      req.log.error({ err: error }, 'MY TRANSPORT JOBS ERROR:');

      return res.status(500).json({
        error:
          'Could not load your transport jobs',
      });
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

router.post(
  '/',
  authenticate,
  [
    body('orderId')
      .isUUID()
      .withMessage('orderId is required'),

    body('arrangingParty').isIn([
      'SELLER',
      'BUYER',
      'JOINT',
    ]),

    body('method').isIn([
      'OWN_TRUCK',
      'HIRE_TRANSPORTER',
    ]),

    body('pickupLocation')
      .isString()
      .trim()
      .notEmpty(),

    body('destination')
      .isString()
      .trim()
      .notEmpty(),

    body('load')
      .isString()
      .trim()
      .notEmpty(),

    body('requiredCapacity')
      .optional()
      .isFloat({ min: 0 }),

    body('specialRequirements')
      .optional()
      .isString()
      .trim()
      .custom(noContactInfo),

    body('truckId')
      .optional()
      .isUUID(),
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
        truckId,
      } = req.body;

      const order =
        await prisma.order.findUnique({
          where: {
            id: orderId,
          },
          include: {
            transportJob: true,
            listing: true,
            payments: true,
            inspectionRequests: { include: { payments: true } },
          },
        });

      if (!order) {
        return res.status(404).json({
          error: 'Order not found',
        });
      }

      if (
        !isOrderParticipant(
          req.user.id,
          order
        ) &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized to arrange transport for this order',
        });
      }

      if (
        order.status !== 'CONFIRMED' &&
        order.status !== 'PENDING_PAYMENT'
      ) {
        return res.status(400).json({
          error:
            `Transport can only be arranged for orders in CONFIRMED or PENDING_PAYMENT state (current: ${order.status})`,
        });
      }

      if (order.transportJob && order.transportJob.status !== 'CANCELLED') {
        return res.status(409).json({
          error:
            'A transport job already exists for this order',
        });
      }

      const isAgricultural = order.listing?.category === 'AGRICULTURAL';
      const isPhysicalGoods = ['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category);

      if (isAgricultural && order.buyerDecision !== 'BUY') {
        return res.status(409).json({
          code: 'BUYER_DECISION_REQUIRED',
          error: 'The buyer must choose BUY after reviewing the agricultural inspection report before transport can be arranged.',
          buyerDecision: order.buyerDecision || null,
        });
      }

      if (isPhysicalGoods) {
        const goodsPaid = order.payments?.some((p) => p.type === 'MARKETPLACE' && p.status === 'PAID');
        if (!goodsPaid) {
          return res.status(409).json({ code: 'GOODS_PAYMENT_REQUIRED', error: 'Pay for the agreed goods before arranging transport.' });
        }
        const inspections = order.inspectionRequests || [];
        const inspectionPaid = inspections.filter(r => r.fee != null && Number(r.fee) > 0)
          .every(r => r.payments?.some(p => p.type === 'INSPECTOR' && p.status === 'PAID'));
        if (!inspectionPaid) {
          return res.status(409).json({ code: 'INSPECTION_PAYMENT_REQUIRED', error: 'All required inspection payments must be completed before arranging transport.' });
        }
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

      if (isPhysicalGoods && method === 'OWN_TRUCK') {
        return res.status(409).json({
          code: 'AGRICULTURAL_TRANSPORT_COMPETITION_REQUIRED',
          error: 'Physical goods use the competitive transporter workflow: the buyer requests transport and registered truck owners submit competing quotes.',
        });
      }

      if (!['SELLER', 'BUYER', 'JOINT'].includes(resolvedArrangingParty)) {
        return res.status(400).json({
          error: 'arrangingParty must be SELLER, BUYER, or JOINT',
        });
      }

      if (method === 'OWN_TRUCK' && resolvedArrangingParty === 'JOINT') {
        return res.status(400).json({
          error: 'JOINT arrangements must use HIRE_TRANSPORTER. Select SELLER or BUYER when using an own truck.',
        });
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
        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOrder =
                await tx.order.findUnique({
                  where: {
                    id: order.id,
                  },
                  include: {
                    transportJob: true,
                  },
                });

              if (!freshOrder) {
                const error = new Error(
                  'Order not found'
                );
                error.statusCode = 404;
                throw error;
              }

              await lockOrderAndAssertNotClosed(tx, freshOrder.id, 'transport cannot be arranged until that is resolved');

              if (freshOrder.transportJob && freshOrder.transportJob.status !== 'CANCELLED') {
                const error = new Error(
                  'A transport job already exists for this order'
                );
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
                      },
                    });
                  })()
                : await tx.transportJob.create({
                  data: {
                    orderId:
                      freshOrder.id,

                    arrangingParty:
                      resolvedArrangingParty,

                    method,

                    pickupLocation,
                    destination,
                    load,

                    requiredCapacity:
                      requiredCapacity ||
                      null,

                    specialRequirements:
                      specialRequirements ||
                      null,

                    truckOwnerId: null,
                    truckId: null,

                    status: 'REQUESTED',
                  },
                });

              await tx.order.update({
                where: {
                  id: freshOrder.id,
                },
                data: {
                  arrangingParty:
                    resolvedArrangingParty,

                  ...(freshOrder.status ===
                  'CONFIRMED'
                    ? {
                        status:
                          'TRANSPORT_ARRANGED',
                      }
                    : {}),
                },
              });

              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: 'TRANSPORT_JOB_CREATED',
                resourceType: 'TransportJob',
                resourceId: transportJob.id,
                metadata: {
                  orderId: freshOrder.id,
                  method,
                  arrangingParty: resolvedArrangingParty,
                  truckId: null,
                  status: transportJob.status,
                },
              });

              return transportJob;
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.status(201).json({
          transportJob: result,
        });
      }

      if (!truckId) {
        return res.status(400).json({
          error:
            'truckId is required for OWN_TRUCK',
        });
      }

      const result =
        await prisma.$transaction(
          async (tx) => {
            const freshOrder =
              await tx.order.findUnique({
                where: {
                  id: order.id,
                },
                include: {
                  transportJob: true,
                },
              });

            if (!freshOrder) {
              const error = new Error(
                'Order not found'
              );
              error.statusCode = 404;
              throw error;
            }

            await lockOrderAndAssertNotClosed(tx, freshOrder.id, 'transport cannot be arranged until that is resolved');

            if (freshOrder.transportJob && freshOrder.transportJob.status !== 'CANCELLED') {
              const error = new Error(
                'A transport job already exists for this order'
              );
              error.statusCode = 409;
              throw error;
            }

            const truck =
              await tx.truck.findUnique({
                where: {
                  id: truckId,
                },
              });

            if (!truck) {
              const error = new Error(
                'Truck not found'
              );
              error.statusCode = 404;
              throw error;
            }

            if (
              truck.ownerId !==
                req.user.id &&
              !isAdmin(req.user)
            ) {
              const error = new Error(
                'You do not own this truck'
              );
              error.statusCode = 403;
              throw error;
            }

            await claimAvailableTruck(
              tx,
              truck.id
            );

            const transportJob = freshOrder.transportJob?.status === 'CANCELLED'
              ? await (async () => {
                  await tx.transportQuote.deleteMany({ where: { transportJobId: freshOrder.transportJob.id } });
                  return tx.transportJob.update({
                    where: { id: freshOrder.transportJob.id },
                    data: {
                      arrangingParty: resolvedArrangingParty, method, pickupLocation, destination, load,
                      requiredCapacity: requiredCapacity || null, specialRequirements: specialRequirements || null,
                      truckOwnerId: truck.ownerId, truckId: truck.id, agreedAmount: null, status: 'ACCEPTED',
                      pickupConfirmedAt: null, deliveredConfirmedAt: null, incidentNotes: null,
                    },
                  });
                })()
              : await tx.transportJob.create({
                data: {
                  orderId:
                    freshOrder.id,

                  arrangingParty:
                    resolvedArrangingParty,

                  method,

                  pickupLocation,
                  destination,
                  load,

                  requiredCapacity:
                    requiredCapacity ||
                    null,

                  specialRequirements:
                    specialRequirements ||
                    null,

                  truckOwnerId:
                    truck.ownerId,

                  truckId:
                    truck.id,

                  status: 'ACCEPTED',
                },
              });

            await tx.order.update({
              where: {
                id: freshOrder.id,
              },
              data: {
                arrangingParty:
                  resolvedArrangingParty,

                ...(freshOrder.status ===
                'CONFIRMED'
                  ? {
                      status:
                        'TRANSPORT_ARRANGED',
                    }
                  : {}),
              },
            });

            await recordAuditEvent(tx, {
              actorId: req.user.id,
              action: 'TRANSPORT_ASSIGNED',
              resourceType: 'TransportJob',
              resourceId: transportJob.id,
              metadata: {
                orderId: freshOrder.id,
                method,
                arrangingParty: resolvedArrangingParty,
                truckId: truck.id,
                truckOwnerId: truck.ownerId,
                status: transportJob.status,
              },
            });

            return transportJob;
          },
          { maxWait: 10000, timeout: 15000 }
        );

      return res.status(201).json({
        transportJob: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE TRANSPORT ERROR:');

      if (error.statusCode) {
        return res.status(
          error.statusCode
        ).json({
          error: error.message,
        });
      }

      if (
        error.code ===
        'TRUCK_CONFLICT'
      ) {
        return res.status(409).json({
          error: error.message,
        });
      }

      if (error.code === 'P2002') {
        return res.status(409).json({
          error:
            'A transport job already exists for this order',
        });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({
        error:
          'Could not create transport job',
      });
    }
  }
);

router.get(
  '/order/:orderId',
  authenticate,
  [
    param('orderId').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id: req.params.orderId,
          },
          include: {
            transportJob: {
              include: {
                truckOwner: {
                  select: {
                    id: true,
                    name: true,
                    rating: true,
                  },
                },

                truck: true,

                quotes: {
                  include: {
                    truckOwner: {
                      select: {
                        id: true,
                        name: true,
                        rating: true,
                      },
                    },
                    truck: true,
                  },
                  orderBy: {
                    amount: 'asc',
                  },
                },
              },
            },
          },
        });

      if (!order) {
        return res.status(404).json({
          error: 'Order not found',
        });
      }

      if (
        !isOrderParticipant(
          req.user.id,
          order
        ) &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error: 'Not authorized',
        });
      }

      return res.json({
        transportJob:
          order.transportJob ||
          null,
      });
    } catch (error) {
      req.log.error({ err: error }, 'GET TRANSPORT ERROR:');

      return res.status(500).json({
        error:
          'Could not load transport job',
      });
    }
  }
);

router.post(
  '/:id/evidence/media',
  authenticate,
  [param('id').isUUID()],
  validate,
  evidenceUpload.array('files', 5),
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) {
        return res.status(404).json({ error: 'Transport job not found' });
      }

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' &&
          (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized to add transport evidence' });
      }

      if (job.status === 'CANCELLED') {
        return res.status(400).json({ error: 'Cannot add evidence to a cancelled transport job' });
      }

      if (!req.files?.length) {
        return res.status(400).json({ error: 'At least one file is required' });
      }

      const { photoKeys, videoKeys } = await uploadEvidenceFiles('transport', job.id, req.files);

      return res.status(201).json({ photoKeys, videoKeys });
    } catch (error) {
      req.log.error({ err: error }, 'UPLOAD TRANSPORT EVIDENCE MEDIA ERROR:');
      return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
    }
  }
);

router.post(
  '/:id/evidence',
  authenticate,
  [
    param('id').isUUID(),
    body('type').isIn(['PICKUP', 'DELIVERY', 'INCIDENT']),
    body('photos').optional().isArray(),
    body('videos').optional().isArray(),
    body('gpsLocation').optional().isString().trim(),
    body('notes').optional().isString().trim(),
    body('capturedAt').optional().isISO8601(),
  ],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });

      if (!job) {
        return res.status(404).json({ error: 'Transport job not found' });
      }

      const isArranging =
        (job.arrangingParty === 'SELLER' && job.order.sellerId === req.user.id) ||
        (job.arrangingParty === 'BUYER' && job.order.buyerId === req.user.id) ||
        (job.arrangingParty === 'JOINT' &&
          (job.order.buyerId === req.user.id || job.order.sellerId === req.user.id));
      const isTruckOwner = job.truckOwnerId === req.user.id;

      if (!isArranging && !isTruckOwner && !isAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized to add transport evidence' });
      }

      if (job.status === 'CANCELLED') {
        return res.status(400).json({ error: 'Cannot add evidence to a cancelled transport job' });
      }

      const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
      const videos = Array.isArray(req.body.videos) ? req.body.videos.filter(Boolean) : [];
      const notes = req.body.notes?.trim() || null;
      const gpsLocation = req.body.gpsLocation?.trim() || null;

      if (!photos.length && !videos.length && !notes && !gpsLocation) {
        return res.status(400).json({
          error: 'At least one evidence item (photo, video, GPS or notes) is required',
        });
      }

      const evidence = await prisma.$transaction(async (tx) => {
        const created = await tx.transportEvidence.create({
          data: {
            transportJobId: job.id,
            type: req.body.type,
            photos,
            videos,
            gpsLocation,
            notes,
            capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(),
            createdById: req.user.id,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_EVIDENCE_ADDED',
          resourceType: 'TransportEvidence',
          resourceId: created.id,
          metadata: {
            transportJobId: job.id,
            orderId: job.orderId,
            type: created.type,
            photoCount: photos.length,
            videoCount: videos.length,
            hasGps: Boolean(gpsLocation),
          },
        });

        return created;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({ evidence });
    } catch (error) {
      req.log.error({ err: error }, 'ADD TRANSPORT EVIDENCE ERROR:');
      return res.status(500).json({ error: 'Could not add transport evidence' });
    }
  }
);

router.get(
  '/:id/evidence',
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
      if (!isParticipant && !isAdmin(req) && job.truckOwnerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const evidence = await prisma.transportEvidence.findMany({
        where: { transportJobId: job.id },
        orderBy: { capturedAt: 'asc' },
      });

      return res.json({ evidence });
    } catch (error) {
      req.log.error({ err: error }, 'LIST TRANSPORT EVIDENCE ERROR:');
      return res.status(500).json({ error: 'Could not load transport evidence' });
    }
  }
);

router.get(
  '/:id/evidence/:evidenceId/media',
  authenticate,
  [param('id').isUUID(), param('evidenceId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const job = await prisma.transportJob.findUnique({
        where: { id: req.params.id },
        include: { order: true },
      });
      if (!job) return res.status(404).json({ error: 'Transport job not found' });

      const isParticipant = isOrderParticipant(req.user.id, job.order);
      if (!isParticipant && !isAdmin(req) && job.truckOwnerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const evidence = await prisma.transportEvidence.findFirst({
        where: { id: req.params.evidenceId, transportJobId: job.id },
      });
      if (!evidence) return res.status(404).json({ error: 'Transport evidence not found' });

      const sign = async (ref, kind, index) => {
        const metadata = await privateMediaMetadata(ref);
        const url = await signedMediaUrl({
          key: metadata.key,
          fileName: `${kind.toLowerCase()}-${evidence.id}-${index + 1}`,
          contentType: metadata.contentType || undefined,
        });
        return { index, url, key: metadata.key, contentType: metadata.contentType, size: metadata.contentLength, etag: metadata.etag, lastModified: metadata.lastModified };
      };

      const media = { photos: [], videos: [], unsupported: [] };
      for (let i = 0; i < evidence.photos.length; i += 1) {
        try { media.photos.push(await sign(evidence.photos[i], 'photo', i)); }
        catch (error) { media.unsupported.push({ kind: 'photo', index: i, reason: error.message }); }
      }
      for (let i = 0; i < evidence.videos.length; i += 1) {
        try { media.videos.push(await sign(evidence.videos[i], 'video', i)); }
        catch (error) { media.unsupported.push({ kind: 'video', index: i, reason: error.message }); }
      }

      await prisma.auditEvent.create({
        data: {
          actorId: req.user.id,
          action: 'TRANSPORT_EVIDENCE_MEDIA_ACCESSED',
          resourceType: 'TransportEvidence',
          resourceId: evidence.id,
          metadata: { transportJobId: job.id, orderId: job.orderId, photoCount: media.photos.length, videoCount: media.videos.length, unsupportedCount: media.unsupported.length },
        },
      });

      return res.json({ evidenceId: evidence.id, expiresInSeconds: Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900), media });
    } catch (error) {
      req.log.error({ err: error }, 'SIGN TRANSPORT EVIDENCE MEDIA ERROR:');
      return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
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
  return {
    ready: missing.length === 0,
    missing,
    transportRequired,
    transportPaid,
  };
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

  const goodsPaid = (job.order.payments || []).some(
    (p) => p.type === 'MARKETPLACE' && p.status === 'PAID'
  );
  if (!goodsPaid) missing.push('MARKETPLACE');

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
      await tx.transportQuote.updateMany({ where: { transportJobId: fresh.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } }, data: { status: 'EXPIRED' } });
      const updated = await tx.transportJob.update({ where: { id: fresh.id }, data: { truckOwnerId: null, truckId: null, agreedAmount: null, status: 'REQUESTED' } });
      await closeCoordination(tx, fresh.id, 'ADMIN_REOPENED_BIDDING');
      await recordOrderEvent(tx, { orderId: fresh.orderId, actorId: req.user.id, type: 'TRANSPORT_COORDINATION_CLOSED', metadata: { transportJobId: fresh.id, reason: 'ADMIN_REOPENED_BIDDING' } });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'TRANSPORT_BIDDING_REOPENED', resourceType: 'TransportJob', resourceId: fresh.id, metadata: { orderId: fresh.orderId } });
      return updated;
    }, { maxWait: 10000, timeout: 15000 });
    return res.json({ message: 'Transport bidding reopened. Previous bids were expired.', transportJob: reopened });
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
    await recordAuditEvent(prisma, { actorId: req.user.id, action: 'TRANSPORT_SELLER_PICKUP_CONFIRMED', resourceType: 'TransportJob', resourceId: job.id, metadata: { orderId: job.orderId, message: req.body?.message || null } }).catch(() => {});
    await recordOrderEvent(prisma, { orderId: job.orderId, actorId: req.user.id, type: 'TRANSPORT_SELLER_PICKUP_CONFIRMED', metadata: { transportJobId: job.id, message: req.body?.message || null } }).catch(() => {});
    return res.json({ message: 'Pickup readiness confirmed. The transporter may now record pickup.', sellerPickupConfirmedAt: new Date().toISOString() });
  } catch (error) {
    req.log.error({ err: error }, 'SELLER TRANSPORT PICKUP CONFIRM ERROR');
    return res.status(500).json({ error: 'Could not confirm transport pickup readiness' });
  }
});

router.patch(
  '/:id/status',
  authenticate,
  [
    param('id').isUUID(),

    body('status').isIn([
      'REQUESTED',
      'ACCEPTED',
      'QUOTED',
      'PICKUP',
      'IN_TRANSIT',
      'DELIVERED',
      'CANCELLED',
    ]),

    body('incidentNotes')
      .optional()
      .isString()
      .trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const job =
        await prisma.transportJob.findUnique({
          where: {
            id: req.params.id,
          },
          include: {
            order: { include: { listing: true } },
            evidence: {
              select: { id: true, type: true },
            },
          },
        });

      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }

      const isArranging =
        (
          job.arrangingParty ===
            'SELLER' &&
          job.order.sellerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'BUYER' &&
          job.order.buyerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'JOINT' &&
          (
            job.order.buyerId ===
              req.user.id ||
            job.order.sellerId ===
              req.user.id
          )
        );

      const isTruckOwner =
        job.truckOwnerId ===
        req.user.id;

      if (
        !isArranging &&
        !isTruckOwner &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized to update this transport job',
        });
      }

      const current = job.status;
      const next = req.body.status;

      if (next === 'PICKUP' && job.order.sellerId && !job.sellerPickupConfirmedAt && !isAdmin(req.user)) {
        return res.status(409).json({
          code: 'SELLER_PICKUP_CONFIRMATION_REQUIRED',
          error: 'The seller must confirm that the goods are ready and authorize pickup before the transporter can mark the load as picked up.',
        });
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
        REQUESTED: [
          'ACCEPTED',
          'QUOTED',
          'CANCELLED',
        ],

        QUOTED: [
          'ACCEPTED',
          'CANCELLED',
        ],

        ACCEPTED: [
          'PICKUP',
          'CANCELLED',
        ],

        PICKUP: [
          'IN_TRANSIT',
        ],

        IN_TRANSIT: [
          'DELIVERED',
        ],

        DELIVERED: [
          'DELIVERED',
        ],

        CANCELLED: [],
      };

      if (
        !validTransitions[
          current
        ]?.includes(next)
      ) {
        return res.status(400).json({
          error:
            `Invalid status transition from ${current} to ${next}`,
        });
      }

      if (next === 'CANCELLED' && ['PICKUP', 'IN_TRANSIT'].includes(current) && !isAdmin(req.user)) {
        return res.status(409).json({
          code: 'TRANSPORT_MOVEMENT_STARTED',
          error: 'Transport cannot be cancelled after pickup has started. Open or resolve a dispute instead.',
        });
      }

      if (next === 'CANCELLED' && job.method === 'HIRE_TRANSPORTER') {
        const activePayment = await prisma.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
          },
          select: { id: true, status: true },
        });
        if (activePayment && !isAdmin(req.user)) {
          return res.status(409).json({
            code: 'TRANSPORT_PAYMENT_ACTIVE',
            error: 'Transport cannot be cancelled while the transport payment is pending, processing, or paid. Resolve the payment/dispute first.',
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
        return res.status(409).json({
          error: 'Pickup evidence is required before transport can enter IN_TRANSIT',
        });
      }

      if (next === 'DELIVERED' && !job.evidence.some((item) => item.type === 'DELIVERY')) {
        return res.status(409).json({
          error: 'Delivery evidence is required before transport can be marked DELIVERED',
        });
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

      const result =
        await prisma.$transaction(
          async (tx) => {
            await lockOrderAndAssertNotClosed(tx, job.orderId, 'transport cannot proceed until the order dispute is resolved');

            const updated =
              await tx.transportJob.update({
                where: {
                  id: job.id,
                },

                data: {
                  status: next,

                  incidentNotes:
                    req.body.incidentNotes ||
                    job.incidentNotes,

                  pickupConfirmedAt:
                    next === 'PICKUP'
                      ? new Date()
                      : job.pickupConfirmedAt,

                  deliveredConfirmedAt:
                    next === 'DELIVERED'
                      ? new Date()
                      : job.deliveredConfirmedAt,
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
                transportJobId: job.id,
                truckId: job.truckId,
                arrangingParty: job.arrangingParty,
                method: job.method,
              },
            });

            if (next === 'IN_TRANSIT') {
              const freshOrder = await tx.order.findUnique({ where: { id: job.orderId }, select: { status: true } });
              if (freshOrder?.status === 'TRANSPORT_ARRANGED') {
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

              await releaseTruck(
                tx,
                job.truckId
              );
            }

            if (next === 'CANCELLED') {
              await releaseTruck(
                tx,
                job.truckId
              );
            }

            await recordAuditEvent(tx, {
              actorId: req.user.id,
              action: 'TRANSPORT_STATUS_CHANGED',
              resourceType: 'TransportJob',
              resourceId: job.id,
              metadata: {
                orderId: job.orderId,
                fromStatus: current,
                toStatus: next,
                truckId: job.truckId,
              },
            });

            return updated;
          }
        , {
          maxWait: 10000,
          timeout: 20000,
        });

      return res.json({
        transportJob: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'UPDATE TRANSPORT STATUS ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          code: error.code,
          error: error.message,
        });
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

      return res.status(500).json({
        error: error?.message || 'Could not update transport status',
      });
    }
  }
);

// ============================================================================
// SUBMIT TRANSPORT QUOTE
// ============================================================================

router.post(
  '/:id/quotes',
  authenticate,
  idempotency('transport.quote-create'),
  requireRole('TRUCK_OWNER'),
  [
    param('id').isUUID(),

    body('amount').custom(validAmount(AMOUNT_LIMITS.transport)),

    body('message')
      .optional()
      .isString()
      .trim()
      .custom(noContactInfo),

    body('truckId')
      .optional()
      .isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const job =
        await prisma.transportJob.findUnique({
          where: {
            id: req.params.id,
          },
          include: {
            order: true,
          },
        });

      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }

      if (
        job.method !==
        'HIRE_TRANSPORTER'
      ) {
        return res.status(400).json({
          error:
            'Quotes are only for HIRE_TRANSPORTER jobs',
        });
      }

      if (
        job.status !== 'REQUESTED' &&
        job.status !== 'QUOTED'
      ) {
        return res.status(400).json({
          error:
            'This job is not open for quotes',
        });
      }

      // Once the arranging party selects a transporter bid, the competition
      // phase is frozen: only that selected negotiation thread may counter.
      // Other already-submitted PENDING bids remain available as waiting
      // alternatives and can be selected if the provisional agreement is
      // released before payment. This prevents a new provider from entering
      // midway through an active bilateral negotiation.
      const activeNegotiation = await prisma.transportQuote.findFirst({
        where: {
          transportJobId: job.id,
          status: { in: ['SELECTED', 'COUNTERED', 'ACCEPTED'] },
        },
        select: { id: true, truckOwnerId: true, status: true },
      });
      if (activeNegotiation) {
        return res.status(409).json({
          code: 'TRANSPORT_COMPETITION_FROZEN',
          error: 'A transporter has already been selected for negotiation. Existing waiting bids remain available; new bids cannot join this negotiation.',
        });
      }

      let truckId =
        req.body.truckId;

      if (!truckId) {
        const truck =
          await prisma.truck.findFirst({
            where: {
              ownerId: req.user.id,
              availability: 'AVAILABLE',
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

        if (!truck) {
          return res.status(400).json({
            error:
              'You must have an available truck to quote',
          });
        }

        truckId = truck.id;
      } else {
        const truck =
          await prisma.truck.findUnique({
            where: {
              id: truckId,
            },
          });

        if (!truck) {
          return res.status(404).json({
            error: 'Truck not found',
          });
        }

        if (
          truck.ownerId !==
          req.user.id
        ) {
          return res.status(403).json({
            error: 'Not your truck',
          });
        }

        if (
          truck.availability !==
          'AVAILABLE'
        ) {
          return res.status(400).json({
            error:
              'Selected truck is not available',
          });
        }
      }

      const existing =
        await prisma.transportQuote.findFirst({
          where: {
            transportJobId: job.id,
            truckOwnerId:
              req.user.id,
            status: {
              in: [
                'PENDING',
                'COUNTERED',
                'ACCEPTED',
              ],
            },
            childQuotes: { none: {} },
          },
        });

      if (existing) {
        return res.status(409).json({
          error:
            'You already have a pending, negotiating, or accepted quote for this job',
        });
      }

      const quote =
        await prisma.$transaction(
          async (tx) => {
            const truck =
              await tx.truck.findUnique({
                where: {
                  id: truckId,
                },
              });

            if (!truck) {
              const error = new Error(
                'Truck not found'
              );
              error.statusCode = 404;
              throw error;
            }

            if (
              truck.ownerId !==
              req.user.id
            ) {
              const error = new Error(
                'Not your truck'
              );
              error.statusCode = 403;
              throw error;
            }

            if (
              truck.availability !==
              'AVAILABLE'
            ) {
              throw new TruckConflictError(
                'Selected truck is no longer available'
              );
            }

            const createdQuote =
              await tx.transportQuote.create({
                data: {
                  transportJobId:
                    job.id,

                  truckOwnerId:
                    req.user.id,

                  truckId,

                  amount:
                    Number(
                      req.body.amount
                    ),

                  message:
                    req.body.message ||
                    null,

                  status: 'PENDING',
                  expiresAt: quoteExpiry(),
                },
              });

            if (
              job.status ===
              'REQUESTED'
            ) {
              await tx.transportJob.update({
                where: {
                  id: job.id,
                },
                data: {
                  status: 'QUOTED',
                },
              });
            }

            return createdQuote;
          },
          { maxWait: 10000, timeout: 15000 }
        );

      return res.status(201).json({
        quote,
      });
    } catch (error) {
      req.log.error({ err: error }, 'CREATE QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(
          error.statusCode
        ).json({
          error: error.message,
        });
      }

      if (
        error.code ===
        'TRUCK_CONFLICT'
      ) {
        return res.status(409).json({
          error: error.message,
        });
      }

      if (error.code === 'P2002') {
        return res.status(409).json({
          error:
            'A quote for this truck and job already exists',
        });
      }

      return res.status(500).json({
        error:
          'Could not submit quote',
      });
    }
  }
);

router.get(
  '/:id/quotes',
  authenticate,
  [
    param('id').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const job =
        await prisma.transportJob.findUnique({
          where: {
            id: req.params.id,
          },
          include: {
            order: true,
          },
        });

      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }

      const isArranging =
        (
          job.arrangingParty ===
            'SELLER' &&
          job.order.sellerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'BUYER' &&
          job.order.buyerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'JOINT' &&
          (
            job.order.buyerId ===
              req.user.id ||
            job.order.sellerId ===
              req.user.id
          )
        );

      const isTruckOwner =
        job.truckOwnerId ===
        req.user.id;

      if (
        !isArranging &&
        !isTruckOwner &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized to view these quotes',
        });
      }

      const quotes =
        await prisma.transportQuote.findMany({
          where: {
            transportJobId: job.id,
          },

          include: {
            truckOwner: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },

            truck: true,
          },

          orderBy: {
            amount: 'asc',
          },
        });

      return res.json({
        quotes,
      });
    } catch (error) {
      req.log.error({ err: error }, 'LIST QUOTES ERROR:');

      return res.status(500).json({
        error:
          'Could not load quotes',
      });
    }
  }
);


// ============================================================================
// SHARED LOOKUP: quote + job + order, with the caller's role in the
// negotiation (REQUESTER = arranging party, PROVIDER = truck owner).
// ============================================================================

async function loadTransportQuoteForNegotiation(req, res) {
  const quote = await prisma.transportQuote.findUnique({
    where: { id: req.params.quoteId },
    include: {
      transportJob: {
        include: { order: true },
      },
    },
  });

  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return null;
  }

  const job = quote.transportJob;

  // Route shape is /transport/:id/quotes/:quoteId/<action>, matching the
  // inspection quote routes. Refuse to serve a quote whose parent job does
  // not match :id, so a caller cannot address a quote by its ID alone.
  if (req.params.id && job.id !== req.params.id) {
    res.status(404).json({ error: 'Quote not found for this transport job' });
    return null;
  }

  const order = job.order;

  // Parity with the inspection loader: refuse negotiation operations while
  // the parent order is disputed or cancelled. Without this, a transporter
  // or arranger could still act on a quote attached to a frozen order.
  if (order && ['DISPUTED', 'CANCELLED'].includes(order.status)) {
    res.status(409).json({
      code: 'ORDER_DISPUTED',
      error: `This order is ${order.status.toLowerCase()}. Transport quote proceedings are paused until it is resolved.`,
    });
    return null;
  }

  const isRequester = isArrangingParty(job, order, req.user.id);
  const isProvider = quote.truckOwnerId === req.user.id;

  if (!isRequester && !isProvider && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Not authorized for this transport quote negotiation' });
    return null;
  }

  return {
    quote,
    job,
    order,
    actorRole: isRequester ? 'REQUESTER' : 'PROVIDER',
  };
}

// ============================================================================
// SHARED LOOKUP: transport job + coordination row, with the caller's role
// ============================================================================

async function loadCoordinationContext(req, res) {
  const job = await prisma.transportJob.findUnique({
    where: { id: req.params.id },
    include: {
      order: { select: { id: true, sellerId: true, buyerId: true, status: true } },
      coordination: true,
      availability: { orderBy: [{ date: 'asc' }, { startTime: 'asc' }] },
    },
  });

  if (!job) {
    res.status(404).json({ error: 'Transport job not found' });
    return null;
  }

  const { allowed, role } = viewerRoleFor(job, req.user);
  if (!allowed) {
    res.status(403).json({ error: 'You are not authorized to view transport coordination' });
    return null;
  }

  try {
    assertCoordinationStage(job);
  } catch (err) {
    res.status(err.statusCode || 409).json({
      error: err.message,
      code: err.code || 'COORDINATION_NOT_OPEN',
    });
    return null;
  }

  return { job, role };
}

// ============================================================================
// SELECT TRANSPORT BID FOR DEAL NEGOTIATION
// ============================================================================
// Mirrors the inspection select route: only one negotiation thread may be
// active at a time. Selecting a new PENDING bid is refused while another
// bid is SELECTED or COUNTERED, so the requester cannot hop between bids
// without explicitly releasing the current thread first.

router.patch(
  '/:id/quotes/:quoteId/select',
  authenticate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      if (actorRole !== 'REQUESTER') return res.status(403).json({ error: 'Only the arranging party can select a transport bid' });
      if (!['REQUESTED', 'QUOTED'].includes(job.status)) return res.status(400).json({ error: 'This transport request is no longer accepting bids' });
      if (quote.status !== 'PENDING') return res.status(400).json({ error: `Only a pending bid can be selected (current: ${quote.status})` });
      if (isQuoteExpired(quote)) return res.status(409).json({ error: 'This quote has expired' });

      const selected = await prisma.$transaction(async (tx) => {
        // Serialize quote selection against transport-payment creation. Both
        // operations lock the same job row, so a payment can never bind to a
        // quote that is simultaneously being replaced.
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true, status: true, transportQuoteId: true },
        });
        if (activePayment) {
          throw quoteError(
            'Transporter selection is locked because a transport payment has already started. Wait for that payment to fail/cancel before selecting another quote.',
            409
          );
        }

        const freshJob = await tx.transportJob.findUnique({
          where: { id: job.id },
          select: { id: true, status: true },
        });
        if (!freshJob || !['REQUESTED', 'QUOTED'].includes(freshJob.status)) {
          throw quoteError('This transport request is no longer accepting bids', 409);
        }

        const fresh = await tx.transportQuote.findUnique({ where: { id: quote.id } });
        if (!fresh || fresh.status !== 'PENDING') throw quoteError('This bid is no longer available', 409);
        if (isQuoteExpired(fresh)) throw quoteError('This quote has expired', 409);

        // Lock the competition to the current negotiation thread. Once a
        // transporter is SELECTED or COUNTERED, no other bid (existing or
        // incoming) may be selected until that thread is explicitly released.
        // Mirrors the inspection select route's findCompetingLiveQuote guard.
        const competingThread = await tx.transportQuote.findFirst({
          where: {
            transportJobId: job.id,
            id: { not: fresh.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          select: { id: true },
        });
        if (competingThread) {
          throw quoteError(
            'Another transporter bid is already in active negotiation. Release or reject that thread before selecting a different bid.',
            409
          );
        }

        // A previously ACCEPTED quote is only provisional until transport
        // payment. Selecting another pending bid therefore releases the old
        // provisional transporter rather than consuming/closing the order.
        await tx.transportQuote.updateMany({
          where: { transportJobId: job.id, id: { not: fresh.id }, status: 'ACCEPTED' },
          data: { status: 'WITHDRAWN' },
        });

        const selected = await tx.transportQuote.update({ where: { id: fresh.id }, data: { status: 'SELECTED' } });
        await tx.transportJob.update({
          where: { id: job.id },
          data: { truckOwnerId: null, truckId: null, agreedAmount: null, status: 'QUOTED' },
        });
        return selected;
      }, { maxWait: 10000, timeout: 15000 });
      return res.json({ message: 'Transporter bid selected for price negotiation', quote: selected });
    } catch (error) {
      req.log.error({ err: error }, 'SELECT TRANSPORT QUOTE ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not select transport bid' });
    }
  }
);

// ============================================================================
// ACCEPT A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/accept',
  authenticate,
  idempotency('transport.quote-accept'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({
          error: `This quote is already ${quote.status.toLowerCase()}`,
        });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      if (quoteTurn(quote) !== effectiveRole && !isAdmin(req.user)) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const finalAmount = quote.status === 'COUNTERED' ? quote.counterAmount ?? quote.amount : quote.amount;

      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await tx.transportQuote.findUnique({
          where: { id: quote.id },
          include: { transportJob: { include: { order: true } } },
        });

        if (!freshQuote) {
          const error = new Error('Quote not found');
          error.statusCode = 404;
          throw error;
        }

        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          const error = new Error(`This quote is already ${freshQuote.status.toLowerCase()}`);
          error.statusCode = 409;
          throw error;
        }

        const competingThread = await tx.transportQuote.findFirst({
          where: {
            transportJobId: job.id,
            id: { not: freshQuote.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          select: { id: true },
        });
        if (competingThread) {
          throw quoteError('Another transporter bid is already in active negotiation. This quote cannot be accepted until the competing thread is released.', 409);
        }

        const freshJob = freshQuote.transportJob;

        if (freshJob.status !== 'REQUESTED' && freshJob.status !== 'QUOTED') {
          const error = new Error(`This transport job cannot accept a quote while it is ${freshJob.status}`);
          error.statusCode = 409;
          throw error;
        }

        await lockOrderAndAssertNotClosed(tx, freshJob.orderId, 'a transport quote cannot be accepted until that is resolved');

        const updatedQuote = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: {
            status: 'ACCEPTED',
            amount: finalAmount,
          },
        });

        await tx.transportQuote.updateMany({
          where: {
            transportJobId: freshJob.id,
            id: { not: freshQuote.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          data: { status: 'REJECTED' },
        });

        await tx.transportJob.update({
          where: { id: freshJob.id },
          data: {
            truckOwnerId: freshQuote.truckOwnerId,
            truckId: freshQuote.truckId,
            agreedAmount: finalAmount,
            status: 'QUOTED',
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_ACCEPTED',
          resourceType: 'TransportQuote',
          resourceId: updatedQuote.id,
          metadata: { transportJobId: freshJob.id, truckOwnerId: updatedQuote.truckOwnerId, acceptedBy: effectiveRole, amount: finalAmount },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({
        message: 'Quote accepted',
        quote: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ACCEPT TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// REJECT A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/reject',
  authenticate,
  idempotency('transport.quote-reject'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (quote.status === 'PENDING') {
        return res.status(409).json({
          error: 'Waiting bids cannot be rejected. Select the bid you want to negotiate with; the others will keep waiting.',
        });
      }

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({
          error: `This quote is already ${quote.status.toLowerCase()}`,
        });
      }

      if (quoteTurn(quote) !== effectiveRole && !isAdmin(req.user)) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const updatedQuote = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await tx.transportQuote.findUnique({ where: { id: quote.id } });
        if (!freshQuote || !['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError('This quote is no longer available for rejection', 409);
        }
        const competingThread = await tx.transportQuote.findFirst({
          where: {
            transportJobId: job.id,
            id: { not: freshQuote.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          select: { id: true },
        });
        if (competingThread) {
          throw quoteError('This quote is not the sole active negotiation thread', 409);
        }

        return tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'REJECTED' },
        });
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({
        message: 'Quote rejected',
        quote: updatedQuote,
      });
    } catch (error) {
      req.log.error({ err: error }, 'REJECT TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// COUNTER A TRANSPORT QUOTE
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/counter',
  authenticate,
  idempotency('transport.quote-counter'),
  [
    param('id').isUUID(),
    param('quoteId').isUUID(),
    body('counterAmount').custom(validAmount(AMOUNT_LIMITS.transport)),
    body('message')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: 1000 })
      .custom(noContactInfo),
  ],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      if (!['SELECTED', 'COUNTERED'].includes(quote.status)) {
        return res.status(400).json({
          error: `Quote cannot be countered because it is ${quote.status}`,
        });
      }

      if (isQuoteExpired(quote)) {
        return res.status(409).json({ error: 'This quote has expired' });
      }

      if (quoteTurn(quote) !== effectiveRole) {
        return res.status(409).json({
          error: 'It is the other party\u2019s turn to respond to this negotiation',
        });
      }

      const counterAmount = Number(req.body.counterAmount);

      const counterQuote = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: job.id,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true },
        });
        if (activePayment) {
          throw quoteError('Transport negotiation is locked because a transport payment has already started', 409);
        }

        const freshQuote = await tx.transportQuote.findUnique({ where: { id: quote.id } });
        if (!freshQuote) throw quoteError('Quote not found', 404);
        if (!['SELECTED', 'COUNTERED'].includes(freshQuote.status)) {
          throw quoteError(`Quote cannot be countered because it is ${freshQuote.status}`, 409);
        }
        const competingThread = await tx.transportQuote.findFirst({
          where: {
            transportJobId: job.id,
            id: { not: freshQuote.id },
            status: { in: ['SELECTED', 'COUNTERED'] },
          },
          select: { id: true },
        });
        if (competingThread) {
          throw quoteError('Another transporter bid is already in active negotiation. Refresh and select only after that negotiation is released.', 409);
        }
        if (quoteTurn(freshQuote) !== effectiveRole) {
          throw quoteError('It is the other party\u2019s turn to respond to this negotiation', 409);
        }

        const updated = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: {
            status: 'COUNTERED',
            counterAmount,
            counteredBy: effectiveRole,
            message: req.body.message || freshQuote.message,
            expiresAt: quoteExpiry(12),
          },
          include: {
            truckOwner: { select: { id: true, name: true, rating: true } },
            truck: true,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_COUNTERED',
          resourceType: 'TransportQuote',
          resourceId: updated.id,
          metadata: {
            transportJobId: freshQuote.transportJobId,
            counteredBy: effectiveRole,
            previousAmount: String(freshQuote.counterAmount ?? freshQuote.amount),
            counterAmount: String(counterAmount),
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.status(201).json({
        message: effectiveRole === 'REQUESTER'
          ? 'Counter-offer sent. The transporter must respond next.'
          : 'Counter-offer sent. The requester must respond next.',
        quote: counterQuote,
      });
    } catch (error) {
      req.log.error({ err: error }, 'COUNTER TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// WITHDRAW / RELEASE A TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/withdraw',
  authenticate,
  idempotency('transport.quote-withdraw'),
  [param('id').isUUID(), param('quoteId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;
      const effectiveRole = actorRole;

      const isAcceptedRelease = quote.status === 'ACCEPTED';
      const isSilentRelease =
        quote.status === 'SELECTED' ||
        (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');

      if (!isAcceptedRelease && !isSilentRelease) {
        return res.status(400).json({
          error: `This quote cannot be released in its current state (current: ${quote.status})`,
        });
      }

      if (isSilentRelease) {
        const availableAt = transportReleaseAvailableAt(quote);
        if (availableAt && availableAt.getTime() > Date.now()) {
          return res.status(409).json({
            error: `This truck owner has not been inactive long enough. You can release them from ${availableAt.toISOString()}.`,
            releaseAvailableAt: availableAt,
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "TransportJob" WHERE "id" = $1 FOR UPDATE',
          job.id
        );

        const freshQuote = await tx.transportQuote.findUnique({
          where: { id: quote.id },
          include: { transportJob: { include: { order: true } } },
        });
        if (!freshQuote) throw quoteError('Quote not found', 404);

        const activePayment = await tx.payment.findFirst({
          where: {
            transportJobId: freshQuote.transportJobId,
            type: 'TRANSPORT',
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true, status: true },
        });
        if (activePayment) {
          throw quoteError('This transporter cannot be released after transport payment has started or completed', 409);
        }

        if (freshQuote.transportJob.status !== 'QUOTED') {
          throw quoteError(`This transport agreement cannot be released while the job is ${freshQuote.transportJob.status}`, 409);
        }

        if (isSilentRelease) {
          const freshAvailableAt = transportReleaseAvailableAt(freshQuote);
          if (freshAvailableAt && freshAvailableAt.getTime() > Date.now()) {
            throw quoteError('This negotiation changed. Refresh and try again.', 409);
          }
        }

        const updatedQuote = await tx.transportQuote.update({
          where: { id: freshQuote.id },
          data: { status: 'WITHDRAWN' },
        });

        if (isAcceptedRelease) {
          await tx.transportJob.update({
            where: { id: freshQuote.transportJobId },
            data: {
              truckOwnerId: null,
              truckId: null,
              agreedAmount: null,
              status: 'QUOTED',
            },
          });

          await closeCoordination(tx, freshQuote.transportJobId, 'TRANSPORTER_RELEASED');

          await recordOrderEvent(tx, {
            orderId: freshQuote.transportJob.orderId,
            actorId: req.user.id,
            type: 'TRANSPORT_COORDINATION_CLOSED',
            metadata: {
              transportJobId: freshQuote.transportJobId,
              reason: 'TRANSPORTER_RELEASED',
            },
          });
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: isAcceptedRelease ? 'TRANSPORT_QUOTE_WITHDRAWN' : 'TRANSPORT_SILENT_QUOTE_RELEASED',
          resourceType: 'TransportQuote',
          resourceId: updatedQuote.id,
          metadata: {
            transportJobId: freshQuote.transportJobId,
            orderId: freshQuote.transportJob.orderId,
            releasedBy: effectiveRole,
            previousStatus: freshQuote.status,
          },
        });

        return updatedQuote;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({
        message: isAcceptedRelease
          ? 'Provisional transporter agreement released. Other transport bids are available again.'
          : 'Silent truck owner released. Other transport bids are available again.',
        quote: result,
      });
    } catch (error) {
      req.log.error({ err: error }, 'WITHDRAW TRANSPORT QUOTE ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error.code === 'TRUCK_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'ORDER_NOT_ACTIONABLE') {
        return res.status(error.status || 409).json({ error: error.message });
      }

      return res.status(500).json({ error: 'Could not process quote action' });
    }
  }
);

// ============================================================================
// TRUCK OWNER WITHDRAWS A WAITING BID
// ============================================================================

router.post(
  '/:id/quotes/:quoteId/withdraw-bid',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const loaded = await loadTransportQuoteForNegotiation(req, res);
      if (!loaded) return;
      const { quote, job, actorRole } = loaded;

      if (actorRole !== 'PROVIDER') {
        return res.status(403).json({
          error: 'Only the truck owner who submitted the bid can withdraw it',
        });
      }

      if (quote.status !== 'PENDING') {
        return res.status(409).json({
          error: `Only a waiting bid can be withdrawn (current: ${quote.status})`,
        });
      }

      const withdrawn = await prisma.$transaction(async (tx) => {
        const fresh = await tx.transportQuote.findUnique({ where: { id: quote.id } });
        if (!fresh || fresh.status !== 'PENDING') {
          throw quoteError('This bid is no longer waiting. Refresh and try again.', 409);
        }

        const updated = await tx.transportQuote.update({
          where: { id: fresh.id },
          data: { status: 'WITHDRAWN' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'TRANSPORT_QUOTE_WITHDRAWN_BY_PROVIDER',
          resourceType: 'TransportQuote',
          resourceId: updated.id,
          metadata: {
            transportJobId: job.id,
            truckOwnerId: fresh.truckOwnerId,
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      return res.json({ message: 'Your bid has been withdrawn.', quote: withdrawn });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      req.log.error({ err: error }, 'TRUCK OWNER WITHDRAW BID ERROR:');
      return res.status(500).json({ error: 'Could not withdraw bid' });
    }
  }
);

// ============================================================================
// TESTABLE INTERNAL CONSTANTS
// ============================================================================

router.ACTIVE_TRUCK_JOB_STATUSES =
  ACTIVE_TRUCK_JOB_STATUSES;

router.claimAvailableTruck =
  claimAvailableTruck;

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
        return res.status(403).json({
          error: 'Only the assigned transporter can submit the loading report',
        });
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

      const issues = Array.isArray(req.body.visibleIssues)
        ? req.body.visibleIssues.filter(Boolean)
        : [];
      const unknownIssues = issues.filter((i) => !LOADING_ISSUE_OPTIONS.includes(i));
      if (unknownIssues.length) {
        return res.status(400).json({
          error: `Unknown issue flags: ${unknownIssues.join(', ')}`,
        });
      }

      const parseOpt = (v) =>
        v == null || v === '' ? null : new Date(v);
      const arrivedAt = parseOpt(req.body.arrivedAt);
      const loadingStartedAt = parseOpt(req.body.loadingStartedAt);
      const loadingFinishedAt = parseOpt(req.body.loadingFinishedAt);

      if (arrivedAt && loadingStartedAt && arrivedAt > loadingStartedAt) {
        return res.status(400).json({ error: 'arrivedAt cannot be later than loadingStartedAt' });
      }
      if (loadingStartedAt && loadingFinishedAt && loadingStartedAt > loadingFinishedAt) {
        return res.status(400).json({ error: 'loadingStartedAt cannot be later than loadingFinishedAt' });
      }

      const gate = await checkLoadingReportGate(prisma, job.id);
      if (!gate.ready) {
        return res.status(409).json({
          code: 'PAYMENTS_REQUIRED_BEFORE_LOADING',
          error: 'The truck cannot begin loading until every required payment on this order is settled (goods, inspection, transport).',
          missingPayments: gate.missing,
        });
      }

      const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
      const videos = Array.isArray(req.body.videos) ? req.body.videos.filter(Boolean) : [];
      if (!photos.length && !videos.length) {
        return res.status(400).json({
          error: 'At least one photo or video of the loaded goods is required',
        });
      }

      const report = await prisma.$transaction(async (tx) => {
        await lockOrderAndAssertNotClosed(tx, job.orderId, 'loading cannot begin until the order dispute is resolved');

        const fresh = await tx.transportJob.findUnique({ where: { id: job.id } });
        if (!fresh || fresh.status !== 'ACCEPTED') {
          throw quoteError('This transport is no longer awaiting pickup', 409);
        }

        const existing = await tx.transportLoadingReport.findUnique({
          where: { transportJobId: job.id },
        });
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
            arrivedAt,
            loadingStartedAt,
            loadingFinishedAt,
            gpsLocation: req.body.gpsLocation || null,
            notes: req.body.notes || null,
          },
        });

        await tx.transportEvidence.create({
          data: {
            transportJobId: job.id,
            type: 'LOADING',
            photos,
            videos,
            gpsLocation: req.body.gpsLocation || null,
            notes: req.body.notes || null,
            capturedAt: loadingFinishedAt || new Date(),
            createdById: req.user.id,
          },
        });

        await tx.transportJob.update({
          where: { id: job.id },
          data: {
            status: 'PICKUP',
            pickupConfirmedAt: new Date(),
          },
        });

        await recordOrderEvent(tx, {
          orderId: job.orderId,
          actorId: req.user.id,
          type: 'TRANSPORT_LOADING_REPORT_SUBMITTED',
          fromStatus: 'ACCEPTED',
          toStatus: 'PICKUP',
          metadata: {
            transportJobId: job.id,
            whatLoaded: created.whatLoaded,
            quantityLoaded: String(created.quantityLoaded),
            quantityUnit: created.quantityUnit,
            qualityAtLoading: created.qualityAtLoading,
            visibleIssues: issues,
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

      return res.status(201).json({
        message: 'Loading report recorded. Transport is now marked as picked up.',
        loadingReport: report,
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
        include: {
          submittedBy: { select: { id: true, name: true } },
        },
      });

      if (!report) return res.json({ loadingReport: null, evidence: null });

      const evidence = await prisma.transportEvidence.findFirst({
        where: { transportJobId: job.id, type: 'LOADING' },
        select: {
          id: true,
          photos: true,
          videos: true,
          gpsLocation: true,
          notes: true,
          capturedAt: true,
        },
        orderBy: { capturedAt: 'desc' },
      });

      return res.json({ loadingReport: report, evidence });
    } catch (error) {
      req.log.error({ err: error }, 'GET TRANSPORT LOADING REPORT ERROR:');
      return res.status(500).json({ error: 'Could not load loading report' });
    }
  }
);

// ============================================================================
// TRANSPORT COORDINATION (seller <-> transporter only)
// ============================================================================

router.get('/:id/coordination', authenticate, async (req, res) => {
  try {
    const ctx = await loadCoordinationContext(req, res);
    if (!ctx) return;

    const { job, role } = ctx;
    const coordination = job.coordination && !job.coordination.supersededAt
      ? job.coordination
      : null;

    return res.json({
      role,
      coordination,
      availability: job.availability || [],
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET TRANSPORT COORDINATION ERROR:');
    return res.status(500).json({ error: 'Could not load transport coordination' });
  }
});

router.put(
  '/:id/coordination',
  authenticate,
  [
    body('sellerContactName').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('sellerPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('sellerAlternativePhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('sellerEmail').optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body('sellerPreferredContact').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('pickupSite').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('meetingPoint').optional({ nullable: true }).isString().trim().isLength({ max: 240 }),
    body('accessInstructions').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('sellerPrepNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('sellerSitePhotos').optional().isArray(),
    body('sellerPrepPhotos').optional().isArray(),

    body('driverContactName').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('driverPhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverAlternativePhone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverEmail').optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body('driverPreferredContact').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
    body('driverArrivalEta').optional({ nullable: true }).isISO8601(),
    body('driverArrivalNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('driverEquipment').optional().isArray(),
    body('driverNotes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  ],
  validate,
  async (req, res) => {
    try {
      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { job, role } = ctx;

      if (role === 'ADMIN') {
        return res.status(403).json({ error: 'Administrators may view coordination but not write it' });
      }

      const SELLER_FIELDS = [
        'sellerContactName', 'sellerPhone', 'sellerAlternativePhone', 'sellerEmail',
        'sellerPreferredContact', 'pickupSite', 'meetingPoint', 'accessInstructions',
        'sellerPrepNotes', 'sellerSitePhotos', 'sellerPrepPhotos',
      ];
      const DRIVER_FIELDS = [
        'driverContactName', 'driverPhone', 'driverAlternativePhone', 'driverEmail',
        'driverPreferredContact', 'driverArrivalEta', 'driverArrivalNotes',
        'driverEquipment', 'driverNotes',
      ];
      const allowedFields = role === 'SELLER' ? SELLER_FIELDS : DRIVER_FIELDS;

      const data = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          const value = req.body[field];
          if (Array.isArray(value)) {
            data[field] = value.filter((v) => typeof v === 'string' && v.trim()).slice(0, 20);
          } else if (field === 'driverArrivalEta') {
            data[field] = value ? new Date(value) : null;
          } else {
            data[field] = value === '' || value === undefined ? null : value;
          }
        }
      }

      if (role === 'SELLER') data.sellerSubmittedAt = new Date();
      else data.driverSubmittedAt = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const row = await ensureOpenCoordination(tx, job.id);
        return tx.transportCoordination.update({
          where: { id: row.id },
          data,
        });
      }, { maxWait: 10000, timeout: 15000 });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: role === 'SELLER'
          ? 'TRANSPORT_COORDINATION_SELLER_SUBMITTED'
          : 'TRANSPORT_COORDINATION_DRIVER_SUBMITTED',
        resourceType: 'TransportCoordination',
        resourceId: updated.id,
        metadata: {
          transportJobId: job.id,
          orderId: job.orderId,
          role,
          fields: Object.keys(data).filter((k) => !k.endsWith('SubmittedAt')),
        },
      });

      return res.json({ message: 'Coordination information saved', coordination: updated });
    } catch (error) {
      req.log.error({ err: error }, 'PUT TRANSPORT COORDINATION ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not save transport coordination' });
    }
  }
);

router.post(
  '/:id/coordination/availability',
  authenticate,
  [
    body('date').isISO8601().withMessage('date must be a valid date'),
    body('startTime').matches(/^\d{2}:\d{2}$/).withMessage('startTime must be HH:MM'),
    body('endTime').matches(/^\d{2}:\d{2}$/).withMessage('endTime must be HH:MM'),
  ],
  validate,
  async (req, res) => {
    try {
      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { job, role } = ctx;

      if (role !== 'SELLER' && role !== 'TRANSPORTER') {
        return res.status(403).json({ error: 'Only the seller or transporter can add availability slots' });
      }

      const { date, startTime, endTime } = req.body;
      if (startTime >= endTime) {
        return res.status(400).json({ error: 'startTime must be before endTime' });
      }

      const slot = await prisma.transportAvailability.create({
        data: {
          transportJobId: job.id,
          party: role,
          date: new Date(date),
          startTime,
          endTime,
        },
      });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'TRANSPORT_AVAILABILITY_ADDED',
        resourceType: 'TransportAvailability',
        resourceId: slot.id,
        metadata: { transportJobId: job.id, party: role, date, startTime, endTime },
      });

      return res.status(201).json({ availability: slot });
    } catch (error) {
      req.log.error({ err: error }, 'POST TRANSPORT AVAILABILITY ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not add availability slot' });
    }
  }
);

router.delete(
  '/:id/coordination/availability/:slotId',
  authenticate,
  async (req, res) => {
    try {
      const ctx = await loadCoordinationContext(req, res);
      if (!ctx) return;
      const { job, role } = ctx;

      const slot = await prisma.transportAvailability.findUnique({
        where: { id: req.params.slotId },
      });
      if (!slot || slot.transportJobId !== job.id) {
        return res.status(404).json({ error: 'Availability slot not found' });
      }
      if (slot.party !== role) {
        return res.status(403).json({ error: 'You can only remove your own availability slots' });
      }

      await prisma.transportAvailability.delete({ where: { id: slot.id } });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'TRANSPORT_AVAILABILITY_REMOVED',
        resourceType: 'TransportAvailability',
        resourceId: slot.id,
        metadata: { transportJobId: job.id, party: role },
      });

      return res.json({ message: 'Availability slot removed' });
    } catch (error) {
      req.log.error({ err: error }, 'DELETE TRANSPORT AVAILABILITY ERROR:');
      return res.status(error.statusCode || 500).json({ error: error.message || 'Could not remove availability slot' });
    }
  }
);

module.exports = router;
