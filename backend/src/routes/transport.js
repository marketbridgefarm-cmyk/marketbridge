const express = require('express');
const {
  body,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();


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
  return (
    Array.isArray(user.roles) &&
    user.roles.includes(role)
  );
}


function normalizeRegistration(value) {
  return String(
    value || ''
  )
    .trim()
    .toUpperCase();
}


function normalizeString(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  return String(value).trim();
}


function positiveNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number) &&
    number > 0
    ? number
    : null;
}


function moneyEqual(a, b) {
  return (
    Math.abs(
      Number(a) -
        Number(b)
    ) < 0.01
  );
}


// ============================================================================
// PAYMENT HELPERS
// ============================================================================

async function getPaidMarketplacePayment(
  orderId,
  client = prisma
) {
  return client.payment.findFirst({
    where: {
      orderId,

      type:
        'MARKETPLACE',

      status:
        'PAID',
    },

    orderBy: {
      updatedAt:
        'desc',
    },
  });
}


async function getPaidTransportPayment(
  orderId,
  client = prisma
) {
  return client.payment.findFirst({
    where: {
      orderId,

      type:
        'TRANSPORT',

      status:
        'PAID',
    },

    orderBy: {
      updatedAt:
        'desc',
    },
  });
}


// ============================================================================
// CREATE TRANSPORT JOB
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole(
    'SELLER',
    'BUYER'
  ),

  [
    body('orderId')
      .trim()
      .notEmpty()
      .withMessage(
        'Order ID is required'
      ),

    body('arrangingParty')
      .isIn([
        'SELLER',
        'BUYER',
        'JOINT',
      ])
      .withMessage(
        'Invalid arranging party'
      ),

    body('method')
      .isIn([
        'OWN_TRUCK',
        'HIRE_TRANSPORTER',
      ])
      .withMessage(
        'Invalid transport method'
      ),

    body('pickupLocation')
      .trim()
      .notEmpty()
      .withMessage(
        'Pickup location is required'
      ),

    body('destination')
      .trim()
      .notEmpty()
      .withMessage(
        'Destination is required'
      ),

    body('load')
      .trim()
      .notEmpty()
      .withMessage(
        'Load is required'
      ),

    body('requiredCapacity')
      .optional({
        values: 'falsy',
      })
      .isFloat({
        gt: 0,
      })
      .withMessage(
        'Required capacity must be greater than zero'
      ),
  ],

  async (req, res) => {
    try {
      const errors =
        validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error:
            'Validation failed',

          errors:
            errors.array(),
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


      const order =
        await prisma.order.findUnique({
          where: {
            id:
              orderId,
          },

          include: {
            transportJob:
              true,
          },
        });


      if (!order) {
        return res.status(404).json({
          error:
            'Order not found',
        });
      }


      if (
        !isBuyer(
          order,
          req.user.id
        ) &&
        !isSeller(
          order,
          req.user.id
        )
      ) {
        return res.status(403).json({
          error:
            'Only the buyer or seller on this order may arrange transport',
        });
      }


      if (order.transportJob) {
        return res.status(409).json({
          error:
            'Transport has already been arranged for this order',

          transportJob:
            order.transportJob,
        });
      }


      // ======================================================================
      // PAYMENT GATE
      // ======================================================================
      //
      // Transport cannot even be arranged until the marketplace transaction
      // has actually been confirmed PAID.
      //
      // This prevents:
      //
      // PENDING_PAYMENT
      //      ↓
      // TRANSPORT
      //
      // ======================================================================

      if (
        order.status !==
        'CONFIRMED'
      ) {
        return res.status(400).json({
          error:
            'Marketplace payment must be confirmed before transport can be arranged',
        });
      }


      const marketplacePaid =
        await getPaidMarketplacePayment(
          order.id
        );


      if (!marketplacePaid) {
        return res.status(402).json({
          error:
            'Marketplace payment must be PAID before transport can be arranged',
        });
      }


      // ======================================================================
      // ARRANGING PARTY
      // ======================================================================

      if (
        arrangingParty ===
          'BUYER' &&
        !isBuyer(
          order,
          req.user.id
        )
      ) {
        return res.status(403).json({
          error:
            'Only the buyer can arrange transport as BUYER',
        });
      }


      if (
        arrangingParty ===
          'SELLER' &&
        !isSeller(
          order,
          req.user.id
        )
      ) {
        return res.status(403).json({
          error:
            'Only the seller can arrange transport as SELLER',
        });
      }


      if (
        arrangingParty ===
        'JOINT'
      ) {
        if (
          !isBuyer(
            order,
            req.user.id
          ) &&
          !isSeller(
            order,
            req.user.id
          )
        ) {
          return res.status(403).json({
            error:
              'Only the buyer or seller may create a joint transport arrangement',
          });
        }
      }


      // ======================================================================
      // OWN TRUCK
      // ======================================================================

      if (
        method ===
        'OWN_TRUCK'
      ) {
        if (!truckId) {
          return res.status(400).json({
            error:
              'truckId is required when using your own truck',
          });
        }


        const truck =
          await prisma.truck.findUnique({
            where: {
              id:
                truckId,
            },
          });


        if (!truck) {
          return res.status(404).json({
            error:
              'Selected truck was not found',
          });
        }


        if (
          truck.ownerId !==
          req.user.id
        ) {
          return res.status(403).json({
            error:
              'You can only use a truck registered under your own account',
          });
        }


        if (
          truck.availability !==
          'AVAILABLE'
        ) {
          return res.status(400).json({
            error:
              `Selected truck is currently ${truck.availability}`,
          });
        }
      }


      // ======================================================================
      // HIRE TRANSPORTER
      // ======================================================================

      if (
        method ===
          'HIRE_TRANSPORTER' &&
        (truckOwnerId ||
          truckId)
      ) {
        return res.status(400).json({
          error:
            'HIRE_TRANSPORTER uses the TransportQuote workflow; do not select a transporter or truck when creating the request',
        });
      }


      const capacity =
        positiveNumber(
          requiredCapacity
        );


      const job =
        await prisma.$transaction(
          async (tx) => {
            // Recheck payment inside transaction.
            const paid =
              await getPaidMarketplacePayment(
                order.id,
                tx
              );


            if (!paid) {
              throw Object.assign(
                new Error(
                  'Marketplace payment must be PAID before transport can be arranged'
                ),
                {
                  status: 402,
                }
              );
            }


            const createdJob =
              await tx.transportJob.create({
                data: {
                  orderId:
                    order.id,

                  arrangingParty,

                  method,

                  truckOwnerId:
                    method ===
                    'OWN_TRUCK'
                      ? req.user.id
                      : null,

                  truckId:
                    method ===
                    'OWN_TRUCK'
                      ? truckId
                      : null,

                  pickupLocation:
                    normalizeString(
                      pickupLocation
                    ),

                  destination:
                    normalizeString(
                      destination
                    ),

                  load:
                    normalizeString(
                      load
                    ),

                  requiredCapacity:
                    capacity,

                  specialRequirements:
                    normalizeString(
                      specialRequirements
                    ) || null,

                  status:
                    method ===
                    'OWN_TRUCK'
                      ? 'PICKUP'
                      : 'REQUESTED',
                },
              });


            await tx.order.update({
              where: {
                id:
                  order.id,
              },

              data: {
                arrangingParty,

                status:
                  'TRANSPORT_ARRANGED',
              },
            });


            if (
              method ===
                'OWN_TRUCK' &&
              truckId
            ) {
              await tx.truck.update({
                where: {
                  id:
                    truckId,
                },

                data: {
                  availability:
                    'BUSY',
                },
              });
            }


            return createdJob;
          }
        );


      return res.status(201).json({
        message:
          method ===
          'OWN_TRUCK'
            ? 'Own-truck transport arrangement created successfully'
            : 'Transport request created successfully',

        transportJob:
          job,

        commissionGenerated:
          false,
      });

    } catch (error) {
      console.error(
        'CREATE TRANSPORT JOB ERROR:',
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.status
            ? error.message
            : 'Could not create transport job',

        details:
          process.env.NODE_ENV ===
          'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================================
// FIND AVAILABLE TRUCKS
// ============================================================================

router.get(
  '/match',
  authenticate,
  async (req, res) => {
    try {
      const area =
        normalizeString(
          req.query.area
        );

      const truckType =
        normalizeString(
          req.query.truckType
        );


      let capacity;


      if (
        req.query.minCapacity !==
          undefined &&
        req.query.minCapacity !==
          ''
      ) {
        capacity =
          positiveNumber(
            req.query.minCapacity
          );

        if (!capacity) {
          return res.status(400).json({
            error:
              'minCapacity must be a positive number',
          });
        }
      }


      const trucks =
        await prisma.truck.findMany({
          where: {
            availability:
              'AVAILABLE',

            ...(area
              ? {
                  operatingArea: {
                    contains:
                      area,

                    mode:
                      'insensitive',
                  },
                }
              : {}),

            ...(truckType
              ? {
                  truckType: {
                    contains:
                      truckType,

                    mode:
                      'insensitive',
                  },
                }
              : {}),

            ...(capacity
              ? {
                  capacity: {
                    gte:
                      capacity,
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
                verificationStatus:
                  true,
              },
            },
          },

          orderBy: [
            {
              rating:
                'desc',
            },

            {
              createdAt:
                'desc',
            },
          ],
        });


      return res.json({
        trucks,

        count:
          trucks.length,
      });

    } catch (error) {
      console.error(
        'TRUCK MATCH ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not find available trucks',
      });
    }
  }
);


// ============================================================================
// MY TRUCKS
// ============================================================================

router.get(
  '/trucks/mine',
  authenticate,
  requireRole('TRUCK_OWNER'),

  async (req, res) => {
    try {
      const trucks =
        await prisma.truck.findMany({
          where: {
            ownerId:
              req.user.id,
          },

          orderBy: {
            createdAt:
              'desc',
          },
        });


      const stats = {
        total:
          trucks.length,

        available:
          trucks.filter(
            (truck) =>
              truck.availability ===
              'AVAILABLE'
          ).length,

        busy:
          trucks.filter(
            (truck) =>
              truck.availability ===
              'BUSY'
          ).length,

        offline:
          trucks.filter(
            (truck) =>
              truck.availability ===
              'OFFLINE'
          ).length,
      };


      return res.json({
        trucks,

        count:
          trucks.length,

        stats,
      });

    } catch (error) {
      console.error(
        'MY TRUCKS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load your trucks',
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
            truckOwnerId:
              req.user.id,
          },

          include: {
            truck:
              true,

            order: {
              include: {
                listing:
                  true,

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
            createdAt:
              'desc',
          },
        });


      return res.json({
        jobs,

        count:
          jobs.length,
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
// OPEN TRANSPORT REQUESTS
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
            method:
              'HIRE_TRANSPORTER',

            truckOwnerId:
              null,

            status: {
              in: [
                'REQUESTED',
                'QUOTED',
              ],
            },
          },

          include: {
            order: {
              include: {
                listing:
                  true,

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
            createdAt:
              'desc',
          },
        });


      return res.json({
        jobs,

        count:
          jobs.length,
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
// CREATE TRANSPORT QUOTE
// ============================================================================

router.post(
  '/:id/quotes',
  authenticate,
  requireRole('TRUCK_OWNER'),

  [
    body('truckId')
      .trim()
      .notEmpty()
      .withMessage(
        'truckId is required'
      ),

    body('amount')
      .isFloat({
        gt: 0,
      })
      .withMessage(
        'amount must be greater than zero'
      ),

    body('message')
      .optional()
      .isString()
      .trim(),
  ],

  async (req, res) => {
    try {
      const errors =
        validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error:
            'Validation failed',

          errors:
            errors.array(),
        });
      }


      const job =
        await prisma.transportJob.findUnique({
          where: {
            id:
              req.params.id,
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
          'HIRE_TRANSPORTER' ||
        ![
          'REQUESTED',
          'QUOTED',
        ].includes(job.status) ||
        job.truckOwnerId
      ) {
        return res.status(400).json({
          error:
            'This transport job is not open for quotes',
        });
      }


      const truck =
        await prisma.truck.findUnique({
          where: {
            id:
              req.body.truckId,
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
            'You can only quote with your own truck',
        });
      }


      if (
        truck.availability !==
        'AVAILABLE'
      ) {
        return res.status(400).json({
          error:
            `Selected truck is currently ${truck.availability}`,
        });
      }


      if (
        job.requiredCapacity &&
        truck.capacity <
          job.requiredCapacity
      ) {
        return res.status(400).json({
          error:
            'Selected truck does not meet required capacity',
        });
      }


      const quote =
        await prisma.transportQuote.create({
          data: {
            transportJobId:
              job.id,

            truckOwnerId:
              req.user.id,

            truckId:
              truck.id,

            amount:
              Number(
                req.body.amount
              ),

            message:
              req.body.message
                ?.trim() ||
              null,
          },
        });


      await prisma.transportJob.update({
        where: {
          id:
            job.id,
        },

        data: {
          status:
            'QUOTED',
        },
      });


      return res.status(201).json({
        message:
          'Transport quote submitted',

        quote,
      });

    } catch (error) {
      console.error(
        'CREATE TRANSPORT QUOTE ERROR:',
        error
      );

      if (
        error.code ===
        'P2002'
      ) {
        return res.status(409).json({
          error:
            'You already submitted this truck quote for this request',
        });
      }

      return res.status(500).json({
        error:
          'Could not submit transport quote',
      });
    }
  }
);


// ============================================================================
// GET TRANSPORT QUOTES
// ============================================================================

router.get(
  '/:id/quotes',
  authenticate,

  async (req, res) => {
    try {
      const job =
        await prisma.transportJob.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            order:
              true,
          },
        });


      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }


      const allowed =
        req.user.roles?.includes(
          'ADMIN'
        ) ||
        job.order.buyerId ===
          req.user.id ||
        job.order.sellerId ===
          req.user.id ||
        job.truckOwnerId ===
          req.user.id;


      if (!allowed) {
        return res.status(403).json({
          error:
            'Not authorized to view transport quotes',
        });
      }


      const quotes =
        await prisma.transportQuote.findMany({
          where: {
            transportJobId:
              job.id,
          },

          include: {
            truckOwner: {
              select: {
                id: true,
                name: true,
                phone: true,
                rating: true,
                verificationStatus:
                  true,
              },
            },

            truck:
              true,
          },

          orderBy: {
            amount:
              'asc',
          },
        });


      return res.json({
        quotes,

        count:
          quotes.length,
      });

    } catch (error) {
      console.error(
        'GET TRANSPORT QUOTES ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load transport quotes',
      });
    }
  }
);


// ============================================================================
// ACCEPT TRANSPORT QUOTE
// ============================================================================

router.patch(
  '/quotes/:quoteId/accept',
  authenticate,

  async (req, res) => {
    try {
      const quote =
        await prisma.transportQuote.findUnique({
          where: {
            id:
              req.params.quoteId,
          },

          include: {
            transportJob: {
              include: {
                order:
                  true,
              },
            },
          },
        });


      if (!quote) {
        return res.status(404).json({
          error:
            'Transport quote not found',
        });
      }


      const job =
        quote.transportJob;

      const order =
        job.order;


      if (
        order.buyerId !==
          req.user.id &&
        order.sellerId !==
          req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the buyer or seller on the order can accept a transport quote',
        });
      }


      if (
        order.arrangingParty &&
        (
          (
            order.arrangingParty ===
              'BUYER' &&
            order.buyerId !==
              req.user.id
          ) ||
          (
            order.arrangingParty ===
              'SELLER' &&
            order.sellerId !==
              req.user.id
          )
        )
      ) {
        return res.status(403).json({
          error:
            'Only the party who arranged transport can accept the quote',
        });
      }


      if (
        quote.status !==
        'PENDING'
      ) {
        return res.status(400).json({
          error:
            `Quote is already ${quote.status}`,
        });
      }


      if (
        job.status !==
          'REQUESTED' &&
        job.status !==
          'QUOTED'
      ) {
        return res.status(400).json({
          error:
            `Transport job is ${job.status} and cannot accept quotes`,
        });
      }


      // ======================================================================
      // PAYMENT GATE
      // ======================================================================

      const marketplacePaid =
        await getPaidMarketplacePayment(
          order.id
        );


      if (!marketplacePaid) {
        return res.status(402).json({
          error:
            'Marketplace payment must be PAID before accepting a transport quote',
        });
      }


      const result =
        await prisma.$transaction(
          async (tx) => {
            // Recheck marketplace payment in transaction.
            const paid =
              await getPaidMarketplacePayment(
                order.id,
                tx
              );


            if (!paid) {
              throw Object.assign(
                new Error(
                  'Marketplace payment must be PAID before accepting a transport quote'
                ),
                {
                  status:
                    402,
                }
              );
            }


            const currentTruck =
              await tx.truck.findUnique({
                where: {
                  id:
                    quote.truckId,
                },
              });


            if (
              !currentTruck ||
              currentTruck.availability !==
                'AVAILABLE'
            ) {
              throw new Error(
                'Selected truck is no longer available'
              );
            }


            const accepted =
              await tx.transportQuote.update({
                where: {
                  id:
                    quote.id,
                },

                data: {
                  status:
                    'ACCEPTED',
                },
              });


            await tx.transportQuote.updateMany({
              where: {
                transportJobId:
                  quote.transportJobId,

                id: {
                  not:
                    quote.id,
                },

                status:
                  'PENDING',
              },

              data: {
                status:
                  'REJECTED',
              },
            });


            const updatedJob =
              await tx.transportJob.update({
                where: {
                  id:
                    quote.transportJobId,
                },

                data: {
                  truckOwnerId:
                    quote.truckOwnerId,

                  truckId:
                    quote.truckId,

                  status:
                    'ACCEPTED',

                  agreedAmount:
                    quote.amount,
                },
              });


            await tx.truck.update({
              where: {
                id:
                  quote.truckId,
              },

              data: {
                availability:
                  'BUSY',
              },
            });


            await tx.order.update({
              where: {
                id:
                  order.id,
              },

              data: {
                status:
                  'TRANSPORT_ARRANGED',
              },
            });


            return {
              accepted,

              job:
                updatedJob,
            };
          }
        );


      return res.json({
        message:
          'Transport quote accepted',

        quote:
          result.accepted,

        transportJob:
          result.job,

        commissionGenerated:
          true,
      });

    } catch (error) {
      console.error(
        'ACCEPT TRANSPORT QUOTE ERROR:',
        error
      );

      return res.status(
        error.status || 400
      ).json({
        error:
          error.status
            ? error.message
            : (
                error.message ===
                'Selected truck is no longer available'
                  ? error.message
                  : 'Could not accept transport quote'
              ),
      });
    }
  }
);


// ============================================================================
// UPDATE TRANSPORT STATUS
// ============================================================================
//
// REQUESTED
//    ↓
// ACCEPTED
//    ↓
// PICKUP
//    ↓
// IN_TRANSIT
//    ↓
// DELIVERED
//    ↓
// BUYER CONFIRMS RECEIPT
//    ↓
// COMPLETED
//
// PAYMENT REQUIREMENTS:
//
// MARKETPLACE:
//   Must be PAID before physical transport begins.
//
// HIRE_TRANSPORTER:
//   TRANSPORT payment must also be PAID and match agreedAmount.
//
// OWN_TRUCK:
//   No separate transport payment.
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
      const errors =
        validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error:
            'Validation failed',

          errors:
            errors.array(),
        });
      }


      const {
        status,
        incidentNotes,
      } = req.body;


      const job =
        await prisma.transportJob.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            order:
              true,

            truck:
              true,
          },
        });


      if (!job) {
        return res.status(404).json({
          error:
            'Transport job not found',
        });
      }


      const buyer =
        job.order.buyerId ===
        req.user.id;

      const seller =
        job.order.sellerId ===
        req.user.id;

      const truckOwner =
        job.truckOwnerId ===
        req.user.id;


      if (
        !buyer &&
        !seller &&
        !truckOwner
      ) {
        return res.status(403).json({
          error:
            'You are not authorized to update this transport job',
        });
      }


      // ======================================================================
      // STATUS TRANSITIONS
      // ======================================================================

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
        !allowedTransitions[
          job.status
        ] ||
        !allowedTransitions[
          job.status
        ].includes(status)
      ) {
        return res.status(400).json({
          error:
            `Cannot change transport status from ${job.status} to ${status}`,
        });
      }


      // ======================================================================
      // PHYSICAL STATUS AUTHORIZATION
      // ======================================================================

      if (
        [
          'PICKUP',
          'IN_TRANSIT',
          'DELIVERED',
        ].includes(status) &&
        !truckOwner
      ) {
        return res.status(403).json({
          error:
            `Only the truck owner can mark a transport job as ${status}`,
        });
      }


      // ======================================================================
      // PAYMENT GATES
      // ======================================================================
      //
      // CANCELLED does not require payment.
      //
      // PICKUP / IN_TRANSIT / DELIVERED do.
      //
      // ======================================================================

      if (
        [
          'PICKUP',
          'IN_TRANSIT',
          'DELIVERED',
        ].includes(status)
      ) {
        const marketplacePaid =
          await getPaidMarketplacePayment(
            job.orderId
          );


        if (!marketplacePaid) {
          return res.status(402).json({
            error:
              'Marketplace payment must be PAID before transport can proceed',
          });
        }


        if (
          job.method ===
          'HIRE_TRANSPORTER'
        ) {
          if (
            !job.truckOwnerId ||
            !job.truckId ||
            job.agreedAmount ==
              null
          ) {
            return res.status(400).json({
              error:
                'Transport quote must be accepted before transport can proceed',
            });
          }


          const transportPayment =
            await getPaidTransportPayment(
              job.orderId
            );


          if (!transportPayment) {
            return res.status(402).json({
              error:
                'Transport payment must be PAID before the transporter can proceed',
            });
          }


          if (
            !moneyEqual(
              transportPayment.amount,
              job.agreedAmount
            )
          ) {
            return res.status(409).json({
              error:
                'Transport payment amount does not match the accepted transport fee',
            });
          }
        }
      }


      // ======================================================================
      // TRANSACTION
      // ======================================================================

      const updated =
        await prisma.$transaction(
          async (tx) => {
            // Recheck payment immediately before physical state transition.
            if (
              [
                'PICKUP',
                'IN_TRANSIT',
                'DELIVERED',
              ].includes(status)
            ) {
              const marketplacePaidTx =
                await getPaidMarketplacePayment(
                  job.orderId,
                  tx
                );


              if (!marketplacePaidTx) {
                throw Object.assign(
                  new Error(
                    'Marketplace payment must be PAID before transport can proceed'
                  ),
                  {
                    status:
                      402,
                  }
                );
              }


              if (
                job.method ===
                'HIRE_TRANSPORTER'
              ) {
                if (
                  !job.truckOwnerId ||
                  !job.truckId ||
                  job.agreedAmount ==
                    null
                ) {
                  throw Object.assign(
                    new Error(
                      'Transport quote must be accepted before transport can proceed'
                    ),
                    {
                      status:
                        400,
                    }
                  );
                }


                const transportPaymentTx =
                  await getPaidTransportPayment(
                    job.orderId,
                    tx
                  );


                if (
                  !transportPaymentTx
                ) {
                  throw Object.assign(
                    new Error(
                      'Transport payment must be PAID before the transporter can proceed'
                    ),
                    {
                      status:
                        402,
                    }
                  );
                }


                if (
                  !moneyEqual(
                    transportPaymentTx.amount,
                    job.agreedAmount
                  )
                ) {
                  throw Object.assign(
                    new Error(
                      'Transport payment amount does not match the accepted transport fee'
                    ),
                    {
                      status:
                        409,
                    }
                  );
                }
              }
            }


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


            if (
              status ===
              'PICKUP'
            ) {
              data.pickupConfirmedAt =
                new Date();
            }


            if (
              status ===
              'DELIVERED'
            ) {
              data.deliveredConfirmedAt =
                new Date();
            }


            const updatedJob =
              await tx.transportJob.update({
                where: {
                  id:
                    job.id,
                },

                data,
              });


            // ================================================================
            // ORDER STATUS
            // ================================================================

            if (
              status ===
              'IN_TRANSIT'
            ) {
              await tx.order.update({
                where: {
                  id:
                    job.orderId,
                },

                data: {
                  status:
                    'IN_TRANSIT',
                },
              });
            }


            if (
              status ===
              'DELIVERED'
            ) {
              await tx.order.update({
                where: {
                  id:
                    job.orderId,
                },

                data: {
                  status:
                    'DELIVERED',
                },
              });
            }


            if (
              status ===
              'CANCELLED'
            ) {
              await tx.order.update({
                where: {
                  id:
                    job.orderId,
                },

                data: {
                  status:
                    'CONFIRMED',
                },
              });
            }


            // ================================================================
            // RELEASE TRUCK
            // ================================================================

            if (
              job.truckId &&
              [
                'DELIVERED',
                'CANCELLED',
              ].includes(status)
            ) {
              await tx.truck.update({
                where: {
                  id:
                    job.truckId,
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

      return res.status(
        error.status || 500
      ).json({
        error:
          error.status
            ? error.message
            : 'Could not update transport status',

        details:
          process.env.NODE_ENV ===
          'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================================
// REGISTER TRUCK
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
      .isFloat({
        gt: 0,
      })
      .withMessage(
        'Capacity must be greater than zero'
      ),

    body('operatingArea')
      .optional({
        values: 'falsy',
      })
      .trim(),
  ],

  async (req, res) => {
    try {
      const errors =
        validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error:
            'Validation failed',

          errors:
            errors.array(),
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
        Number(
          req.body.capacity
        );


      if (
        !Number.isFinite(
          capacity
        ) ||
        capacity <= 0
      ) {
        return res.status(400).json({
          error:
            'Capacity must be greater than zero',
        });
      }


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
          process.env.NODE_ENV ===
          'development'
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
      const errors =
        validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error:
            'Validation failed',

          errors:
            errors.array(),
        });
      }


      const {
        availability,
      } = req.body;


      const truck =
        await prisma.truck.findUnique({
          where: {
            id:
              req.params.id,
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
            id:
              truck.id,
          },

          data: {
            availability,
          },
        });


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
// DEACTIVATE TRUCK
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
            id:
              req.params.id,
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
            id:
              truck.id,
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
// TRUCK STATISTICS
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
      ] =
        await Promise.all([
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


module.exports = router;
