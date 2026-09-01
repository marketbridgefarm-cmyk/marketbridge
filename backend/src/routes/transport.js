const express = require('express');
const { body, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| MARKETBRIDGE TRANSPORT ROUTES
|--------------------------------------------------------------------------
|
| Transport responsibilities:
|
| 1. Buyer can request hired transport.
| 2. Seller can arrange transport.
| 3. Buyer/seller can use their own truck only if they own it.
| 4. Truck owners can register trucks.
| 5. Registered available trucks can appear in matching/search results.
| 6. Truck owners can see open transport requests.
| 7. Truck owners can accept requests and assign one of their trucks.
| 8. Transport status controls the physical delivery workflow.
|
| IMPORTANT:
| OWN_TRUCK:
|   - No transporter hiring commission.
|
| HIRE_TRANSPORTER:
|   - Transporter/truck owner is selected through the platform.
|
|--------------------------------------------------------------------------
*/


// ============================================================================
// HELPERS
// ============================================================================

function isBuyer(order, userId) {
  return order.buyerId === userId;
}

function isSeller(order, userId) {
  return order.sellerId === userId;
}

function hasRole(user, role) {
  return Array.isArray(user.roles) && user.roles.includes(role);
}

function normalizeRegistration(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function positiveNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0
    ? number
    : null;
}


// ============================================================================
// CREATE TRANSPORT JOB
// ============================================================================
//
// Buyer or Seller may arrange transport.
//
// Methods:
//   OWN_TRUCK
//   HIRE_TRANSPORTER
//
// Parties:
//   BUYER
//   SELLER
//   JOINT
//
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),
  [
    body('orderId')
      .trim()
      .notEmpty()
      .withMessage('Order ID is required'),

    body('arrangingParty')
      .isIn(['SELLER', 'BUYER', 'JOINT'])
      .withMessage('Invalid arranging party'),

    body('method')
      .isIn(['OWN_TRUCK', 'HIRE_TRANSPORTER'])
      .withMessage('Invalid transport method'),

    body('pickupLocation')
      .trim()
      .notEmpty()
      .withMessage('Pickup location is required'),

    body('destination')
      .trim()
      .notEmpty()
      .withMessage('Destination is required'),

    body('load')
      .trim()
      .notEmpty()
      .withMessage('Load is required'),

    body('requiredCapacity')
      .optional({ values: 'falsy' })
      .isFloat({ gt: 0 })
      .withMessage('Required capacity must be greater than zero'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: errors.array(),
        });
      }

      const {
        orderId,
        arrangingParty,
        method,
        truckOwnerId,
        truckId,
        pickupLocation,
        destination,
        load,
        requiredCapacity,
        specialRequirements,
      } = req.body;

      const order = await prisma.order.findUnique({
        where: {
          id: orderId,
        },
        include: {
          transportJob: true,
        },
      });

      if (!order) {
        return res.status(404).json({
          error: 'Order not found',
        });
      }

      // Only buyer or seller attached to the order may arrange transport.
      if (
        !isBuyer(order, req.user.id) &&
        !isSeller(order, req.user.id)
      ) {
        return res.status(403).json({
          error:
            'Only the buyer or seller on this order may arrange transport',
        });
      }

      // Do not create duplicate transport jobs.
      if (order.transportJob) {
        return res.status(409).json({
          error: 'Transport has already been arranged for this order',
          transportJob: order.transportJob,
        });
      }

      // Transport can normally be arranged after offer acceptance/order creation.
      const allowedOrderStatuses = [
        'PENDING_PAYMENT',
        'CONFIRMED',
      ];

      if (!allowedOrderStatuses.includes(order.status)) {
        return res.status(400).json({
          error:
            `Order status ${order.status} does not allow transport arrangement`,
        });
      }

      // ----------------------------------------------------------------------
      // ARRANGING PARTY AUTHORIZATION
      // ----------------------------------------------------------------------

      if (
        arrangingParty === 'BUYER' &&
        !isBuyer(order, req.user.id)
      ) {
        return res.status(403).json({
          error: 'Only the buyer can arrange transport as BUYER',
        });
      }

      if (
        arrangingParty === 'SELLER' &&
        !isSeller(order, req.user.id)
      ) {
        return res.status(403).json({
          error: 'Only the seller can arrange transport as SELLER',
        });
      }

      if (arrangingParty === 'JOINT') {
        if (
          !isBuyer(order, req.user.id) &&
          !isSeller(order, req.user.id)
        ) {
          return res.status(403).json({
            error:
              'Only the buyer or seller may create a joint transport arrangement',
          });
        }
      }

      // ----------------------------------------------------------------------
      // OWN TRUCK
      // ----------------------------------------------------------------------

      if (method === 'OWN_TRUCK') {
        if (!truckId) {
          return res.status(400).json({
            error:
              'truckId is required when using your own truck',
          });
        }

        const truck = await prisma.truck.findUnique({
          where: {
            id: truckId,
          },
        });

        if (!truck) {
          return res.status(404).json({
            error: 'Selected truck was not found',
          });
        }

        if (truck.ownerId !== req.user.id) {
          return res.status(403).json({
            error:
              'You can only use a truck registered under your own account',
          });
        }

        if (truck.availability !== 'AVAILABLE') {
          return res.status(400).json({
            error:
              `Selected truck is currently ${truck.availability}`,
          });
        }
      }

      // ----------------------------------------------------------------------
      // HIRE TRANSPORTER
      // ----------------------------------------------------------------------
      // Hiring is quote-based. The arranger creates an open request;
      // registered truck owners submit quotes, and the buyer/seller later
      // accepts one quote.
      if (method === 'HIRE_TRANSPORTER' && (truckOwnerId || truckId)) {
        return res.status(400).json({
          error: 'HIRE_TRANSPORTER uses the TransportQuote workflow; do not select a transporter or truck when creating the request',
        });
      }

      const capacity = positiveNumber(requiredCapacity);

      const job = await prisma.$transaction(async (tx) => {
        /*
         * For OWN_TRUCK, the authenticated user is automatically
         * the truck owner.
         *
         * For HIRE_TRANSPORTER:
         *   - truckOwnerId can be null
         *   - truckId can be null
         *
         * This allows an open hiring request.
         */

        const createdJob = await tx.transportJob.create({
          data: {
            orderId: order.id,

            arrangingParty,

            method,

            truckOwnerId:
              method === 'OWN_TRUCK'
                ? req.user.id
                : truckOwnerId || null,

            truckId:
              truckId || null,

            pickupLocation:
              normalizeString(pickupLocation),

            destination:
              normalizeString(destination),

            load:
              normalizeString(load),

            requiredCapacity:
              capacity,

            specialRequirements:
              normalizeString(specialRequirements) || null,

            /*
             * Own truck is ready for pickup.
             *
             * Hired transport without a selected transporter:
             * REQUESTED.
             *
             * Hired transport with a selected transporter:
             * ACCEPTED.
             */

            status:
              method === 'OWN_TRUCK' ? 'PICKUP' : 'REQUESTED',
          },
        });

        await tx.order.update({
          where: {
            id: order.id,
          },

          data: {
            arrangingParty,

            status:
              method === 'OWN_TRUCK'
                ? 'TRANSPORT_ARRANGED'
                : 'TRANSPORT_ARRANGED',
          },
        });

        // Own truck becomes BUSY immediately.
        if (method === 'OWN_TRUCK' && truckId) {
          await tx.truck.update({
            where: {
              id: truckId,
            },

            data: {
              availability: 'BUSY',
            },
          });
        }

        return createdJob;
      });

      return res.status(201).json({
        message:
          method === 'OWN_TRUCK'
            ? 'Own-truck transport arrangement created successfully'
            : truckOwnerId
              ? 'Transporter selected successfully'
              : 'Transport request created successfully',

        transportJob: job,

        /*
         * OWN_TRUCK never generates transporter commission.
         */
        commissionGenerated: false,
      });
    } catch (error) {
      console.error(
        'CREATE TRANSPORT JOB ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not create transport job',

        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================================
// FIND AVAILABLE TRUCKS
// ============================================================================
//
// Used by:
// - Buyer dashboard
// - Transport hiring screen
// - Seller transport screen
//
// Example:
// GET /api/transport/match
//
// Optional:
// ?area=Adama
// ?minCapacity=10
// ?truckType=Flatbed
//
// ============================================================================

router.get(
  '/match',
  authenticate,
  async (req, res) => {
    try {
      const area = normalizeString(req.query.area);
      const truckType = normalizeString(req.query.truckType);

      let capacity;

      if (
        req.query.minCapacity !== undefined &&
        req.query.minCapacity !== ''
      ) {
        capacity = positiveNumber(req.query.minCapacity);

        if (!capacity) {
          return res.status(400).json({
            error:
              'minCapacity must be a positive number',
          });
        }
      }

      const trucks = await prisma.truck.findMany({
        where: {
          availability: 'AVAILABLE',

          ...(area
            ? {
                operatingArea: {
                  contains: area,
                  mode: 'insensitive',
                },
              }
            : {}),

          ...(truckType
            ? {
                truckType: {
                  contains: truckType,
                  mode: 'insensitive',
                },
              }
            : {}),

          ...(capacity
            ? {
                capacity: {
                  gte: capacity,
                },
              }
            : {}),
        },

        include: {
          owner: {
            select: {
              id: true,
              name: true,
              phone: true,
              rating: true,
              verificationStatus: true,
            },
          },
        },

        orderBy: [
          {
            rating: 'desc',
          },
          {
            createdAt: 'desc',
          },
        ],
      });

      return res.json({
        trucks,
        count: trucks.length,
      });
    } catch (error) {
      console.error(
        'TRUCK MATCH ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not find available trucks',
      });
    }
  }
);


// ============================================================================
// TRUCK OWNER — MY TRUCKS
// ============================================================================
//
// IMPORTANT FIX:
// This endpoint now returns:
//
// {
//   trucks: [...],
//   count: 3,
//   stats: {
//      total: 3,
//      available: 2,
//      busy: 1,
//      offline: 0
//   }
// }
//
// Therefore the frontend can update both the truck list and statistics.
// ============================================================================

router.get(
  '/trucks/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const trucks = await prisma.truck.findMany({
        where: {
          ownerId: req.user.id,
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      const stats = {
        total: trucks.length,

        available: trucks.filter(
          (truck) =>
            truck.availability === 'AVAILABLE'
        ).length,

        busy: trucks.filter(
          (truck) =>
            truck.availability === 'BUSY'
        ).length,

        offline: trucks.filter(
          (truck) =>
            truck.availability === 'OFFLINE'
        ).length,
      };

      return res.json({
        trucks,

        count: trucks.length,

        stats,
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
// TRUCK OWNER — TRANSPORT JOBS
// ============================================================================

router.get(
  '/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const jobs = await prisma.transportJob.findMany({
        where: {
          truckOwnerId: req.user.id,
        },

        include: {
          truck: true,

          order: {
            include: {
              listing: true,

              buyer: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },

              seller: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({
        jobs,
        count: jobs.length,
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
// TRUCK OWNER — OPEN HIRE REQUESTS
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

          truckOwnerId: null,

          status: { in: ['REQUESTED','QUOTED'] },
        },

        include: {
          order: {
            include: {
              listing: true,

              buyer: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },

              seller: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({
        jobs,
        count: jobs.length,
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
// TRANSPORT QUOTES
// ============================================================================

// Truck owner submits a quote for an open hire request.
router.post(
  '/:id/quotes',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    body('truckId').trim().notEmpty().withMessage('truckId is required'),
    body('amount').isFloat({ gt: 0 }).withMessage('amount must be greater than zero'),
    body('message').optional().isString().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error:'Validation failed', errors:errors.array() });
      const job = await prisma.transportJob.findUnique({ where:{id:req.params.id} });
      if (!job) return res.status(404).json({error:'Transport job not found'});
      if (job.method !== 'HIRE_TRANSPORTER' || !['REQUESTED','QUOTED'].includes(job.status) || job.truckOwnerId) return res.status(400).json({error:'This transport job is not open for quotes'});
      const truck = await prisma.truck.findUnique({where:{id:req.body.truckId}});
      if (!truck) return res.status(404).json({error:'Truck not found'});
      if (truck.ownerId !== req.user.id) return res.status(403).json({error:'You can only quote with your own truck'});
      if (truck.availability !== 'AVAILABLE') return res.status(400).json({error:`Selected truck is currently ${truck.availability}`});
      if (job.requiredCapacity && truck.capacity < job.requiredCapacity) return res.status(400).json({error:'Selected truck does not meet required capacity'});
      const quote = await prisma.transportQuote.create({data:{transportJobId:job.id,truckOwnerId:req.user.id,truckId:truck.id,amount:Number(req.body.amount),message:req.body.message?.trim()||null}});
      await prisma.transportJob.update({where:{id:job.id},data:{status:'QUOTED'}});
      res.status(201).json({message:'Transport quote submitted',quote});
    } catch(e) {
      console.error('CREATE TRANSPORT QUOTE',e);
      if(e.code==='P2002') return res.status(409).json({error:'You already submitted this truck quote for this request'});
      res.status(500).json({error:'Could not submit transport quote'});
    }
  }
);

// Participants can view quotes for a transport job.
router.get('/:id/quotes', authenticate, async (req,res)=>{
  try {
    const job = await prisma.transportJob.findUnique({where:{id:req.params.id},include:{order:true}});
    if(!job) return res.status(404).json({error:'Transport job not found'});
    const allowed = req.user.roles?.includes('ADMIN') || job.order.buyerId===req.user.id || job.order.sellerId===req.user.id || job.truckOwnerId===req.user.id;
    if(!allowed) return res.status(403).json({error:'Not authorized to view transport quotes'});
    const quotes=await prisma.transportQuote.findMany({where:{transportJobId:job.id},include:{truckOwner:{select:{id:true,name:true,phone:true,rating:true,verificationStatus:true}},truck:true},orderBy:{amount:'asc'}});
    res.json({quotes,count:quotes.length});
  } catch(e){console.error('GET TRANSPORT QUOTES',e);res.status(500).json({error:'Could not load transport quotes'});}
});

// Buyer/seller who arranged the order accepts one quote.
router.patch('/quotes/:quoteId/accept', authenticate, async (req,res)=>{
  try {
    const quote=await prisma.transportQuote.findUnique({where:{id:req.params.quoteId},include:{transportJob:{include:{order:true}}}});
    if(!quote) return res.status(404).json({error:'Transport quote not found'});
    const order=quote.transportJob.order;
    if(order.buyerId!==req.user.id && order.sellerId!==req.user.id) return res.status(403).json({error:'Only the buyer or seller on the order can accept a transport quote'});
    if(order.arrangingParty && ((order.arrangingParty==='BUYER'&&order.buyerId!==req.user.id)||(order.arrangingParty==='SELLER'&&order.sellerId!==req.user.id))) return res.status(403).json({error:'Only the party who arranged transport can accept the quote'});
    if(quote.status!=='PENDING') return res.status(400).json({error:`Quote is already ${quote.status}`});
    if(quote.transportJob.status!=='REQUESTED' && quote.transportJob.status!=='QUOTED') return res.status(400).json({error:`Transport job is ${quote.transportJob.status} and cannot accept quotes`});
    const result=await prisma.$transaction(async tx=>{
      const currentTruck=await tx.truck.findUnique({where:{id:quote.truckId}});
      if(!currentTruck || currentTruck.availability!=='AVAILABLE') throw new Error('Selected truck is no longer available');
      const accepted=await tx.transportQuote.update({where:{id:quote.id},data:{status:'ACCEPTED'}});
      await tx.transportQuote.updateMany({where:{transportJobId:quote.transportJobId,id:{not:quote.id},status:'PENDING'},data:{status:'REJECTED'}});
      const job=await tx.transportJob.update({where:{id:quote.transportJobId},data:{truckOwnerId:quote.truckOwnerId,truckId:quote.truckId,status:'ACCEPTED'}});
      await tx.truck.update({where:{id:quote.truckId},data:{availability:'BUSY'}});
      await tx.order.update({where:{id:order.id},data:{status:'TRANSPORT_ARRANGED'}});
      return {accepted,job};
    });
    res.json({message:'Transport quote accepted',quote:result.accepted,transportJob:result.job,commissionGenerated:true});
  } catch(e){console.error('ACCEPT TRANSPORT QUOTE',e);res.status(400).json({error:e.message==='Selected truck is no longer available'?e.message:'Could not accept transport quote'});}
});

// ============================================================================
// UPDATE TRANSPORT STATUS
// ============================================================================
//
// Workflow:
//
// REQUESTED
//     ↓
// ACCEPTED
//     ↓
// PICKUP
//     ↓
// IN_TRANSIT
//     ↓
// DELIVERED
//     ↓
// BUYER CONFIRMS RECEIPT
//     ↓
// ORDER COMPLETED
//
// Cancellation is possible before delivery.
//
// ============================================================================

router.patch(
  '/:id/status',
  authenticate,
  [
    body('status')
      .isIn([
        'PICKUP',
        'IN_TRANSIT',
        'DELIVERED',
        'CANCELLED',
      ])
      .withMessage(
        'Invalid transport status'
      ),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: errors.array(),
        });
      }

      const {
        status,
        incidentNotes,
      } = req.body;

      const job =
        await prisma.transportJob.findUnique({
          where: {
            id: req.params.id,
          },

          include: {
            order: true,
            truck: true,
          },
        });

      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }

      const isBuyer =
        job.order.buyerId === req.user.id;

      const isSeller =
        job.order.sellerId === req.user.id;

      const isTruckOwner =
        job.truckOwnerId === req.user.id;

      if (
        !isBuyer &&
        !isSeller &&
        !isTruckOwner
      ) {
        return res.status(403).json({
          error:
            'You are not authorized to update this transport job',
        });
      }

      // ----------------------------------------------------------------------
      // STATUS TRANSITIONS
      // ----------------------------------------------------------------------

      const allowedTransitions = {
        REQUESTED: [
          'CANCELLED',
        ],

        QUOTED: [
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

        DELIVERED: [],

        CANCELLED: [],
      };

      if (
        !allowedTransitions[job.status] ||
        !allowedTransitions[job.status].includes(
          status
        )
      ) {
        return res.status(400).json({
          error:
            `Cannot change transport status from ${job.status} to ${status}`,
        });
      }

      // ----------------------------------------------------------------------
      // WHO MAY MAKE THIS PARTICULAR TRANSITION
      // ----------------------------------------------------------------------
      //
      // PICKUP / IN_TRANSIT / DELIVERED are physical-custody events — only
      // the truck owner actually doing the hauling can truthfully attest to
      // them (for OWN_TRUCK jobs the arranging buyer/seller IS the truck
      // owner, so this still covers that case). CANCELLED may be raised by
      // any of the three participants.
      if (
        ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(status) &&
        !isTruckOwner
      ) {
        return res.status(403).json({
          error:
            `Only the truck owner can mark a transport job as ${status}`,
        });
      }

      /*
       * Prevent arbitrary users from marking a delivery complete.
       *
       * DELIVERED should normally be confirmed by:
       * - assigned truck owner
       * - buyer
       * - seller
       *
       * because they are the participants in the transport job.
       */

      const updated =
        await prisma.$transaction(
          async (tx) => {
            const data = {
              status,
            };

            const notes =
              normalizeString(
                incidentNotes
              );

            if (notes) {
              data.incidentNotes =
                notes;
            }

            if (status === 'PICKUP') {
              data.pickupConfirmedAt =
                new Date();
            }

            if (status === 'DELIVERED') {
              data.deliveredConfirmedAt =
                new Date();
            }

            const updatedJob =
              await tx.transportJob.update({
                where: {
                  id: job.id,
                },

                data,
              });

            // ----------------------------------------------------------------
            // ORDER STATUS
            // ----------------------------------------------------------------

            if (
              status === 'IN_TRANSIT'
            ) {
              await tx.order.update({
                where: {
                  id: job.orderId,
                },

                data: {
                  status:
                    'IN_TRANSIT',
                },
              });
            }

            if (
              status === 'DELIVERED'
            ) {
              await tx.order.update({
                where: {
                  id: job.orderId,
                },

                data: {
                  status:
                    'DELIVERED',
                },
              });
            }

            /*
             * If transport is cancelled before delivery,
             * the order goes back to CONFIRMED.
             */
            if (
              status === 'CANCELLED'
            ) {
              await tx.order.update({
                where: {
                  id: job.orderId,
                },

                data: {
                  status:
                    'CONFIRMED',
                },
              });
            }

            // ----------------------------------------------------------------
            // RELEASE TRUCK
            // ----------------------------------------------------------------

            if (
              job.truckId &&
              [
                'DELIVERED',
                'CANCELLED',
              ].includes(status)
            ) {
              await tx.truck.update({
                where: {
                  id: job.truckId,
                },

                data: {
                  availability:
                    'AVAILABLE',
                },
              });
            }

            return updatedJob;
          }
        );

      return res.json({
        message:
          'Transport status updated successfully',

        transportJob:
          updated,
      });
    } catch (error) {
      console.error(
        'TRANSPORT STATUS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not update transport status',

        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================================
// REGISTER TRUCK
// ============================================================================
//
// POST /api/transport/trucks
//
// Required:
//   registration
//   truckType
//   capacity
//
// Optional:
//   operatingArea
//
// Newly registered trucks automatically become AVAILABLE.
//
// ============================================================================

router.post(
  '/trucks',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    body('registration')
      .trim()
      .notEmpty()
      .withMessage(
        'Registration is required'
      ),

    body('truckType')
      .trim()
      .notEmpty()
      .withMessage(
        'Truck type is required'
      ),

    body('capacity')
      .isFloat({ gt: 0 })
      .withMessage(
        'Capacity must be greater than zero'
      ),

    body('operatingArea')
      .optional({ values: 'falsy' })
      .trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: errors.array(),
        });
      }

      const registration =
        normalizeRegistration(
          req.body.registration
        );

      const truckType =
        normalizeString(
          req.body.truckType
        );

      const operatingArea =
        normalizeString(
          req.body.operatingArea
        );

      const capacity =
        Number(req.body.capacity);

      if (
        !Number.isFinite(capacity) ||
        capacity <= 0
      ) {
        return res.status(400).json({
          error:
            'Capacity must be greater than zero',
        });
      }

      // ----------------------------------------------------------------------
      // DUPLICATE REGISTRATION CHECK
      // ----------------------------------------------------------------------

      const existing =
        await prisma.truck.findFirst({
          where: {
            registration: {
              equals:
                registration,
              mode:
                'insensitive',
            },
          },
        });

      if (existing) {
        return res.status(409).json({
          error:
            'A truck with this registration is already registered',
        });
      }

      // ----------------------------------------------------------------------
      // CREATE TRUCK
      // ----------------------------------------------------------------------

      const truck =
        await prisma.truck.create({
          data: {
            ownerId:
              req.user.id,

            registration,

            truckType,

            capacity,

            operatingArea,

            availability:
              'AVAILABLE',
          },
        });

      // ----------------------------------------------------------------------
      // RETURN UPDATED STATISTICS
      // ----------------------------------------------------------------------

      const trucks =
        await prisma.truck.findMany({
          where: {
            ownerId:
              req.user.id,
          },
        });

      const stats = {
        total:
          trucks.length,

        available:
          trucks.filter(
            (t) =>
              t.availability ===
              'AVAILABLE'
          ).length,

        busy:
          trucks.filter(
            (t) =>
              t.availability ===
              'BUSY'
          ).length,

        offline:
          trucks.filter(
            (t) =>
              t.availability ===
              'OFFLINE'
          ).length,
      };

      return res.status(201).json({
        message:
          'Truck registered successfully',

        truck,

        count:
          trucks.length,

        stats,
      });
    } catch (error) {
      console.error(
        'REGISTER TRUCK ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not register truck',

        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================================
// UPDATE TRUCK AVAILABILITY
// ============================================================================

router.patch(
  '/trucks/:id/availability',
  authenticate,
  requireRole('TRUCK_OWNER'),
  [
    body('availability')
      .isIn([
        'AVAILABLE',
        'BUSY',
        'OFFLINE',
      ])
      .withMessage(
        'Invalid truck availability'
      ),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: errors.array(),
        });
      }

      const {
        availability,
      } = req.body;

      const truck =
        await prisma.truck.findUnique({
          where: {
            id: req.params.id,
          },
        });

      if (!truck) {
        return res.status(404).json({
          error:
            'Truck not found',
        });
      }

      if (
        truck.ownerId !==
        req.user.id
      ) {
        return res.status(403).json({
          error:
            'You do not own this truck',
        });
      }

      /*
       * Do not allow a truck owner to manually mark
       * a truck AVAILABLE while it is currently assigned
       * to an active transport job.
       */
      if (
        availability ===
        'AVAILABLE'
      ) {
        const activeJob =
          await prisma.transportJob.findFirst({
            where: {
              truckId:
                truck.id,

              status: {
                in: [
                  'REQUESTED',
                  'QUOTED',
                  'ACCEPTED',
                  'PICKUP',
                  'IN_TRANSIT',
                ],
              },
            },
          });

        if (activeJob) {
          return res.status(400).json({
            error:
              'This truck is assigned to an active transport job and cannot be marked AVAILABLE yet',
          });
        }
      }

      const updated =
        await prisma.truck.update({
          where: {
            id: truck.id,
          },

          data: {
            availability,
          },
        });

      // Updated statistics.
      const trucks =
        await prisma.truck.findMany({
          where: {
            ownerId:
              req.user.id,
          },
        });

      const stats = {
        total:
          trucks.length,

        available:
          trucks.filter(
            (t) =>
              t.availability ===
              'AVAILABLE'
          ).length,

        busy:
          trucks.filter(
            (t) =>
              t.availability ===
              'BUSY'
          ).length,

        offline:
          trucks.filter(
            (t) =>
              t.availability ===
              'OFFLINE'
          ).length,
      };

      return res.json({
        message:
          'Truck availability updated',

        truck:
          updated,

        stats,
      });
    } catch (error) {
      console.error(
        'TRUCK AVAILABILITY ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not update truck availability',
      });
    }
  }
);


// ============================================================================
// DELETE / DEACTIVATE TRUCK
// ============================================================================
//
// Instead of physically deleting a truck that may have historical transport
// records, mark it OFFLINE.
//
// ============================================================================

router.patch(
  '/trucks/:id/deactivate',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const truck =
        await prisma.truck.findUnique({
          where: {
            id: req.params.id,
          },
        });

      if (!truck) {
        return res.status(404).json({
          error:
            'Truck not found',
        });
      }

      if (
        truck.ownerId !==
        req.user.id
      ) {
        return res.status(403).json({
          error:
            'You do not own this truck',
        });
      }

      if (
        truck.availability ===
        'BUSY'
      ) {
        return res.status(400).json({
          error:
            'A busy truck cannot be deactivated until its active transport job is completed',
        });
      }

      const updated =
        await prisma.truck.update({
          where: {
            id: truck.id,
          },

          data: {
            availability:
              'OFFLINE',
          },
        });

      return res.json({
        message:
          'Truck deactivated',

        truck:
          updated,
      });
    } catch (error) {
      console.error(
        'DEACTIVATE TRUCK ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not deactivate truck',
      });
    }
  }
);


// ============================================================================
// TRUCK OWNER — SUMMARY / STATISTICS
// ============================================================================
//
// GET /api/transport/trucks/stats
//
// Separate endpoint for dashboards that only need statistics.
//
// ============================================================================

router.get(
  '/trucks/stats',
  authenticate,
  requireRole('TRUCK_OWNER'),
  async (req, res) => {
    try {
      const [
        total,
        available,
        busy,
        offline,
      ] = await Promise.all([
        prisma.truck.count({
          where: {
            ownerId:
              req.user.id,
          },
        }),

        prisma.truck.count({
          where: {
            ownerId:
              req.user.id,

            availability:
              'AVAILABLE',
          },
        }),

        prisma.truck.count({
          where: {
            ownerId:
              req.user.id,

            availability:
              'BUSY',
          },
        }),

        prisma.truck.count({
          where: {
            ownerId:
              req.user.id,

            availability:
              'OFFLINE',
          },
        }),
      ]);

      const activeJobs =
        await prisma.transportJob.count({
          where: {
            truckOwnerId:
              req.user.id,

            status: {
              in: [
                'REQUESTED',
                'QUOTED',
                'ACCEPTED',
                'PICKUP',
                'IN_TRANSIT',
              ],
            },
          },
        });

      const completedJobs =
        await prisma.transportJob.count({
          where: {
            truckOwnerId:
              req.user.id,

            status:
              'DELIVERED',
          },
        });

      return res.json({
        stats: {
          total,
          available,
          busy,
          offline,
          activeJobs,
          completedJobs,
        },
      });
    } catch (error) {
      console.error(
        'TRUCK STATS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load truck statistics',
      });
    }
  }
);


// ============================================================================
// EXPORT
// ============================================================================

module.exports = router;
