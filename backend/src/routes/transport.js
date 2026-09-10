const express = require('express');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isOrderParticipant, isAdmin } = require('../utils/authorization');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');

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
// VALIDATION
// ============================================================================

const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
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

/**
 * Atomically changes AVAILABLE -> BUSY.
 *
 * This is the critical concurrency guard.
 *
 * Two concurrent transactions can both read AVAILABLE, but only one can
 * successfully execute this conditional update. The second transaction waits
 * for the row lock and then receives count === 0.
 */
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

/**
 * Release a truck after the transport job reaches a terminal state.
 *
 * The conditional BUSY check prevents an unrelated manual state change from
 * being overwritten.
 */
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

/**
 * Lock the truck row before checking whether an active job exists.
 *
 * Updating the row to its current availability causes PostgreSQL to acquire
 * the row lock. This serializes manual availability changes against the
 * transaction that claims a truck for a job.
 */
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

// Register a truck
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
      console.error('REGISTER TRUCK ERROR:', error);

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

// List my trucks
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
      console.error(
        'MY TRUCKS ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not load your trucks',
      });
    }
  }
);

// ============================================================================
// UPDATE TRUCK AVAILABILITY
// ============================================================================
//
// AVAILABLE is special: an owner cannot manually free a truck while an
// active transport job is using it.
//
// BUSY/OFFLINE remain manually selectable, although BUSY should normally be
// controlled by transport-job lifecycle.
// ============================================================================

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
        }
      );

      return res.json({
        truck: result,
      });
    } catch (error) {
      console.error(
        'UPDATE TRUCK AVAILABILITY ERROR:',
        error
      );

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

// ============================================================================
// OPEN TRANSPORT JOBS
// ============================================================================

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
            truckOwnerId: null,
            status: {
              in: ['REQUESTED', 'QUOTED'],
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
              take: 1,
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
      console.error(
        'OPEN TRANSPORT JOBS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load open transport jobs',
      });
    }
  }
);

// ============================================================================
// MY TRANSPORT JOBS
// ============================================================================

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
                listing: {
                  select: {
                    category: true,
                    inspectionRequests: {
                      where: { status: { not: 'CANCELLED' } },
                      select: {
                        id: true,
                        status: true,
                        fee: true,
                        payments: { select: { type: true, status: true } },
                      },
                    },
                  },
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
      console.error(
        'MY TRANSPORT JOBS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load your transport jobs',
      });
    }
  }
);

// ============================================================================
// MATCH AVAILABLE TRUCKS
// ============================================================================

router.get(
  '/match',
  authenticate,
  async (req, res) => {
    try {
      const {
        minCapacity,
        area,
      } = req.query;

      const where = {
        availability: 'AVAILABLE',
      };

      if (minCapacity) {
        where.capacity = {
          gte: Number(minCapacity),
        };
      }

      if (area) {
        where.operatingArea = {
          contains: area,
          mode: 'insensitive',
        };
      }

      const trucks =
        await prisma.truck.findMany({
          where,
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                rating: true,
              },
            },
          },
          orderBy: {
            rating: 'desc',
          },
          take: 50,
        });

      return res.json({
        trucks,
      });
    } catch (error) {
      console.error(
        'MATCH TRUCKS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not find matching trucks',
      });
    }
  }
);

// ============================================================================
// CREATE TRANSPORT JOB
// ============================================================================

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
      .trim(),

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

      if (order.transportJob) {
        return res.status(409).json({
          error:
            'A transport job already exists for this order',
        });
      }

      const isAgricultural =
        order.listing?.category ===
        'AGRICULTURAL';

      if (isAgricultural && order.listing.pickupWindowEnd) {
        const pickupDeadline = new Date(order.listing.pickupWindowEnd).getTime();
        if (Number.isFinite(pickupDeadline) && pickupDeadline <= Date.now()) {
          return res.status(409).json({
            error: 'The agricultural pickup window has expired. Update the listing/pickup window before arranging transport.',
          });
        }
      }

      let resolvedArrangingParty =
        arrangingParty;

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

      // ----------------------------------------------------------------------
      // HIRE_TRANSPORTER
      // ----------------------------------------------------------------------
      //
      // No truck is claimed here. The selected truck is claimed atomically
      // when its quote is accepted.
      //
      // ----------------------------------------------------------------------

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

              if (freshOrder.transportJob) {
                const error = new Error(
                  'A transport job already exists for this order'
                );
                error.statusCode = 409;
                throw error;
              }

              const transportJob =
                await tx.transportJob.create({
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
            }
          );

        return res.status(201).json({
          transportJob: result,
        });
      }

      // ----------------------------------------------------------------------
      // OWN_TRUCK
      // ----------------------------------------------------------------------

      if (!truckId) {
        return res.status(400).json({
          error:
            'truckId is required for OWN_TRUCK',
        });
      }

      const result =
        await prisma.$transaction(
          async (tx) => {
            // Re-read the order inside the transaction so the uniqueness
            // check is not based solely on the earlier snapshot.
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

            if (freshOrder.transportJob) {
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

            // CRITICAL:
            // Atomically claim AVAILABLE -> BUSY.
            //
            // This closes the TOCTOU race between checking availability and
            // creating the transport job.
            await claimAvailableTruck(
              tx,
              truck.id
            );

            const transportJob =
              await tx.transportJob.create({
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

                  // Always bind the actual truck owner.
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
          }
        );

      return res.status(201).json({
        transportJob: result,
      });
    } catch (error) {
      console.error(
        'CREATE TRANSPORT ERROR:',
        error
      );

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

      return res.status(500).json({
        error:
          'Could not create transport job',
      });
    }
  }
);

// ============================================================================
// GET TRANSPORT JOB FOR ORDER
// ============================================================================

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
      console.error(
        'GET TRANSPORT ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load transport job',
      });
    }
  }
);

// ============================================================================
// UPLOAD PICKUP / DELIVERY / INCIDENT EVIDENCE MEDIA
// Returns private object-storage keys for use in POST /:id/evidence.
// ============================================================================

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
      console.error('UPLOAD TRANSPORT EVIDENCE MEDIA ERROR:', error);
      return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
    }
  }
);

// ============================================================================
// ADD PICKUP / DELIVERY / INCIDENT EVIDENCE
// ============================================================================

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
      });

      return res.status(201).json({ evidence });
    } catch (error) {
      console.error('ADD TRANSPORT EVIDENCE ERROR:', error);
      return res.status(500).json({ error: 'Could not add transport evidence' });
    }
  }
);

// ============================================================================
// LIST TRANSPORT EVIDENCE
// ============================================================================

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
      console.error('LIST TRANSPORT EVIDENCE ERROR:', error);
      return res.status(500).json({ error: 'Could not load transport evidence' });
    }
  }
);

// ============================================================================
// SIGN PROTECTED TRANSPORT EVIDENCE MEDIA
// Only authorized order participants, truck owners, or admins can obtain
// short-lived URLs for private object-storage evidence.
// ============================================================================

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
      console.error('SIGN TRANSPORT EVIDENCE MEDIA ERROR:', error);
      return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
    }
  }
);

// ============================================================================
// PAYMENT GATE FOR STARTING TRANSPORT
// ============================================================================
// IN_TRANSIT is the contractual start of the trip. It is server-side locked
// until every payment required by this order is settled.
//
// Required payments:
//   1. MARKETPLACE payment for the agricultural/physical order.
//   2. INSPECTOR payment for every non-cancelled inspection request with a fee.
//   3. TRANSPORT payment when HIRE_TRANSPORTER is used.
//
// MarketBridge commission is already calculated inside each payment and
// recorded in the financial ledger; it is not a second buyer checkout.
// ============================================================================
async function getTransportPaymentGate(client, jobId) {
  const job = await client.transportJob.findUnique({
    where: { id: jobId },
    include: {
      order: {
        include: {
          payments: { select: { id: true, type: true, status: true, amount: true } },
          listing: {
            include: {
              inspectionRequests: {
                where: { status: { not: 'CANCELLED' } },
                include: {
                  payments: { select: { id: true, type: true, status: true, amount: true } },
                },
              },
            },
          },
        },
      },
      payments: { select: { id: true, type: true, status: true, amount: true } },
    },
  });

  if (!job) return { ready: false, missing: ['TRANSPORT_JOB'] };

  const marketplacePaid = job.order.payments.some(
    (p) => p.type === 'MARKETPLACE' && p.status === 'PAID'
  );

  const inspectionRequests = job.order.listing?.inspectionRequests || [];
  const inspectionMissing = inspectionRequests
    .filter((r) => r.fee != null && Number(r.fee) > 0)
    .filter((r) => !r.payments.some((p) => p.type === 'INSPECTOR' && p.status === 'PAID'))
    .map((r) => r.id);

  const transportRequired = job.method === 'HIRE_TRANSPORTER';
  const transportPaid = !transportRequired || job.payments.some(
    (p) => p.type === 'TRANSPORT' && p.status === 'PAID'
  );

  const missing = [];
  if (!marketplacePaid) missing.push('MARKETPLACE');
  if (inspectionMissing.length) missing.push('INSPECTOR');
  if (!transportPaid) missing.push('TRANSPORT');

  return {
    ready: missing.length === 0,
    missing,
    marketplacePaid,
    inspectionPaid: inspectionMissing.length === 0,
    transportRequired,
    transportPaid,
    inspectionRequestIds: inspectionRequests.map((r) => r.id),
  };
}

// ============================================================================
// UPDATE TRANSPORT JOB STATUS
// ============================================================================

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

      // Transport movement is controlled by the assigned transporter.
      // Buyer/seller controls the commercial arrangement and payments, but
      // must not be able to falsely mark a truck as picked up, in transit,
      // or delivered. Admin remains available for controlled intervention.
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
          'CANCELLED',
        ],

        IN_TRANSIT: [
          'DELIVERED',
          'CANCELLED',
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

      // Perishable agricultural loads must be picked up within the seller's
      // advertised pickup window. Once pickup has occurred, later transport
      // states are not blocked by the original window.
      if (next === 'PICKUP' && job.order.listing?.category === 'AGRICULTURAL' && job.order.listing.pickupWindowEnd) {
        const pickupDeadline = new Date(job.order.listing.pickupWindowEnd).getTime();
        if (Number.isFinite(pickupDeadline) && pickupDeadline <= Date.now()) {
          return res.status(409).json({
            error: 'The agricultural pickup window has expired. Pickup cannot be confirmed until the listing window is updated.',
          });
        }
      }

      // Pickup evidence is required before IN_TRANSIT and delivery evidence
      // is required before DELIVERED.
      if (next === 'IN_TRANSIT' && !job.evidence.some((item) => item.type === 'PICKUP')) {
        return res.status(409).json({
          error: 'Pickup evidence is required before transport can enter IN_TRANSIT',
        });
      }

      if (next === 'DELIVERED' && !job.evidence.some((item) => item.type === 'DELIVERY')) {
        return res.status(409).json({
          error: 'Delivery evidence is required before transport can be marked DELIVERED',
        });
      }

      // HARD PAYMENT GATE: no transporter may start the trip until all
      // required buyer payments are PAID.
      if (next === 'IN_TRANSIT') {
        const gate = await getTransportPaymentGate(prisma, job.id);
        if (!gate.ready) {
          return res.status(409).json({
            code: 'PAYMENTS_REQUIRED_BEFORE_IN_TRANSIT',
            error: 'All required payments must be completed before transport can enter IN_TRANSIT.',
            missingPayments: gate.missing,
          });
        }
      }

      const result =
        await prisma.$transaction(
          async (tx) => {
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

            if (next === 'DELIVERED') {
              await tx.order.update({
                where: {
                  id: job.orderId,
                },
                data: {
                  status: 'DELIVERED',
                },
              });

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
        );

      return res.json({
        transportJob: result,
      });
    } catch (error) {
      console.error(
        'UPDATE TRANSPORT STATUS ERROR:',
        error
      );

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          code: error.code,
          error: error.message,
        });
      }

      return res.status(500).json({
        error:
          'Could not update transport status',
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
  requireRole('TRUCK_OWNER'),
  [
    param('id').isUUID(),

    body('amount')
      .isFloat({ gt: 0 })
      .withMessage(
        'Amount must be greater than zero'
      ),

    body('message')
      .optional()
      .isString()
      .trim(),

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
                'ACCEPTED',
              ],
            },
          },
        });

      if (existing) {
        return res.status(409).json({
          error:
            'You already have a pending or accepted quote for this job',
        });
      }

      const quote =
        await prisma.$transaction(
          async (tx) => {
            // Re-check that the chosen truck still belongs to this owner
            // and is available before creating the quote.
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
          }
        );

      return res.status(201).json({
        quote,
      });
    } catch (error) {
      console.error(
        'CREATE QUOTE ERROR:',
        error
      );

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

// ============================================================================
// LIST QUOTES FOR A JOB
// ============================================================================

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
      console.error(
        'LIST QUOTES ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load quotes',
      });
    }
  }
);

// ============================================================================
// ACCEPT / REJECT QUOTE
// ============================================================================

router.patch(
  '/quotes/:quoteId',
  authenticate,
  [
    param('quoteId').isUUID(),

    body('action').isIn([
      'ACCEPT',
      'REJECT',
    ]),
  ],
  validate,
  async (req, res) => {
    try {
      const quote =
        await prisma.transportQuote.findUnique({
          where: {
            id: req.params.quoteId,
          },
          include: {
            transportJob: {
              include: {
                order: true,
              },
            },
          },
        });

      if (!quote) {
        return res.status(404).json({
          error: 'Quote not found',
        });
      }

      if (quote.status !== 'PENDING') {
        return res.status(400).json({
          error:
            `This quote is already ${quote.status.toLowerCase()}`,
        });
      }

      const job =
        quote.transportJob;

      const order = job.order;

      const isArranging =
        (
          job.arrangingParty ===
            'SELLER' &&
          order.sellerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'BUYER' &&
          order.buyerId ===
            req.user.id
        ) ||
        (
          job.arrangingParty ===
            'JOINT' &&
          (
            order.buyerId ===
              req.user.id ||
            order.sellerId ===
              req.user.id
          )
        );

      if (
        !isArranging &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Only the arranging party can accept or reject a quote',
        });
      }

      // ----------------------------------------------------------------------
      // ACCEPT
      // ----------------------------------------------------------------------

      if (
        req.body.action ===
        'ACCEPT'
      ) {
        const result =
          await prisma.$transaction(
            async (tx) => {
              // Re-read quote/job state inside the transaction.
              const freshQuote =
                await tx.transportQuote.findUnique({
                  where: {
                    id: quote.id,
                  },
                  include: {
                    transportJob: {
                      include: {
                        order: true,
                      },
                    },
                  },
                });

              if (!freshQuote) {
                const error = new Error(
                  'Quote not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                freshQuote.status !==
                'PENDING'
              ) {
                const error = new Error(
                  `This quote is already ${freshQuote.status.toLowerCase()}`
                );
                error.statusCode = 409;
                throw error;
              }

              const freshJob =
                freshQuote.transportJob;

              if (
                freshJob.status !==
                  'REQUESTED' &&
                freshJob.status !==
                  'QUOTED'
              ) {
                const error = new Error(
                  `This transport job cannot accept a quote while it is ${freshJob.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              // CRITICAL:
              //
              // Claim the selected truck before accepting the quote.
              // If another active job has already claimed it, this transaction
              // receives a 409 and nothing else is committed.
              await claimAvailableTruck(
                tx,
                freshQuote.truckId
              );

              const updatedQuote =
                await tx.transportQuote.update({
                  where: {
                    id: freshQuote.id,
                  },
                  data: {
                    status:
                      'ACCEPTED',
                  },
                });

              await tx.transportQuote.updateMany({
                where: {
                  transportJobId:
                    freshJob.id,

                  id: {
                    not: freshQuote.id,
                  },

                  status: 'PENDING',
                },

                data: {
                  status:
                    'REJECTED',
                },
              });

              await tx.transportJob.update({
                where: {
                  id: freshJob.id,
                },

                data: {
                  truckOwnerId:
                    freshQuote.truckOwnerId,

                  truckId:
                    freshQuote.truckId,

                  agreedAmount:
                    freshQuote.amount,

                  status:
                    'ACCEPTED',
                },
              });

              if (
                freshJob.order.status ===
                'CONFIRMED'
              ) {
                await tx.order.update({
                  where: {
                    id:
                      freshJob.order.id,
                  },

                  data: {
                    status:
                      'TRANSPORT_ARRANGED',
                  },
                });
              }

              return updatedQuote;
            }
          );

        return res.json({
          message:
            'Quote accepted',
          quote: result,
        });
      }

      // ----------------------------------------------------------------------
      // REJECT
      // ----------------------------------------------------------------------

      const updatedQuote =
        await prisma.transportQuote.update({
          where: {
            id: quote.id,
          },

          data: {
            status: 'REJECTED',
          },
        });

      return res.json({
        message:
          'Quote rejected',
        quote: updatedQuote,
      });
    } catch (error) {
      console.error(
        'ACCEPT/REJECT QUOTE ERROR:',
        error
      );

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

      return res.status(500).json({
        error:
          'Could not process quote action',
      });
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

module.exports = router;



