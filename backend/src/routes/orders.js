const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const userSelect = {
  id: true,
  name: true,
  phone: true,
  location: true,
  rating: true,
  verificationStatus: true,
};

const transportInclude = {
  truckOwner: {
    select: {
      id: true,
      name: true,
      phone: true,
      rating: true,
      verificationStatus: true,
    },
  },

  truck: {
    select: {
      id: true,
      registration: true,
      truckType: true,
      capacity: true,
      operatingArea: true,
      availability: true,
      verificationStatus: true,
      rating: true,
    },
  },

  quotes: {
    include: {
      truckOwner: {
        select: {
          id: true,
          name: true,
          phone: true,
          rating: true,
          verificationStatus: true,
        },
      },

      truck: {
        select: {
          id: true,
          registration: true,
          truckType: true,
          capacity: true,
          operatingArea: true,
          availability: true,
          verificationStatus: true,
          rating: true,
        },
      },
    },

    orderBy: {
      amount: 'asc',
    },
  },
};

const orderInclude = {
  listing: {
    include: {
      inspectionRequests: {
        include: {
          report: true,

          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              verificationStatus: true,
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      },
    },
  },

  buyer: {
    select: userSelect,
  },

  seller: {
    select: userSelect,
  },

  transportJob: {
    include: transportInclude,
  },

  payments: true,

  disputes: true,

  ratings: true,
};


// ============================================================
// MY ORDERS
// ============================================================

router.get(
  '/',
  authenticate,
  async (req, res) => {
    try {
      const isAdmin =
        req.user.roles?.includes(
          'ADMIN'
        );

      const orders =
        await prisma.order.findMany({
          where: isAdmin
            ? {}
            : {
                OR: [
                  {
                    buyerId:
                      req.user.id,
                  },
                  {
                    sellerId:
                      req.user.id,
                  },
                ],
              },

          include: orderInclude,

          orderBy: {
            createdAt: 'desc',
          },
        });

      res.json({
        orders,
        count: orders.length,
      });
    } catch (error) {
      console.error(
        'GET ORDERS ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Failed to load orders',
      });
    }
  }
);


// ============================================================
// ORDER DETAIL
// ============================================================

router.get(
  '/:id',
  authenticate,
  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id: req.params.id,
          },

          include: {
            ...orderInclude,

            messages: {
              orderBy: {
                createdAt: 'asc',
              },
            },
          },
        });

      if (!order) {
        return res.status(404).json({
          error: 'Order not found',
        });
      }

      const allowed =
        req.user.roles?.includes(
          'ADMIN'
        ) ||
        order.buyerId ===
          req.user.id ||
        order.sellerId ===
          req.user.id;

      if (!allowed) {
        return res.status(403).json({
          error:
            'Not authorized to view this order',
        });
      }

      res.json({
        order,
      });
    } catch (error) {
      console.error(
        'GET ORDER ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Failed to load order',
      });
    }
  }
);


// ============================================================
// CANCEL ORDER
//
// This is the release path for an accepted offer.
//
// Order cancelled:
// listing UNDER_NEGOTIATION -> ACTIVE
// ============================================================

router.patch(
  '/:id/cancel',
  authenticate,
  async (req, res) => {
    try {
      const isAdmin =
        req.user.roles?.includes(
          'ADMIN'
        );

      const result =
        await prisma.$transaction(
          async (tx) => {
            const order =
              await tx.order.findUnique({
                where: {
                  id: req.params.id,
                },

                include: {
                  transportJob: true,
                },
              });

            if (!order) {
              throw new Error(
                'ORDER_NOT_FOUND'
              );
            }

            if (
              !isAdmin &&
              order.buyerId !==
                req.user.id &&
              order.sellerId !==
                req.user.id
            ) {
              throw new Error(
                'NOT_AUTHORIZED'
              );
            }

            if (
              [
                'COMPLETED',
                'DELIVERED',
                'IN_TRANSIT',
              ].includes(order.status)
            ) {
              throw new Error(
                'ORDER_CANNOT_BE_CANCELLED'
              );
            }

            if (
              order.transportJob &&
              ![
                'REQUESTED',
                'QUOTED',
                'CANCELLED',
              ].includes(
                order.transportJob.status
              )
            ) {
              throw new Error(
                'TRANSPORT_ALREADY_STARTED'
              );
            }

            const cancelled =
              await tx.order.update({
                where: {
                  id: order.id,
                },

                data: {
                  status: 'CANCELLED',
                },
              });

            const remaining =
              await tx.order.findFirst({
                where: {
                  listingId:
                    order.listingId,

                  id: {
                    not: order.id,
                  },

                  status: {
                    notIn: [
                      'CANCELLED',
                      'COMPLETED',
                    ],
                  },
                },

                select: {
                  id: true,
                },
              });

            /*
             * Reopen only when this listing has no other
             * active order.
             */
            if (!remaining) {
              await tx.listing.updateMany({
                where: {
                  id: order.listingId,
                  status:
                    'UNDER_NEGOTIATION',
                },

                data: {
                  status: 'ACTIVE',
                },
              });
            }

            return cancelled;
          }
        );

      res.json({
        message:
          'Order cancelled and listing released back to buyers',

        order: result,
      });
    } catch (error) {
      console.error(
        'CANCEL ORDER ERROR:',
        error
      );

      const errors = {
        ORDER_NOT_FOUND: [
          404,
          'Order not found',
        ],

        NOT_AUTHORIZED: [
          403,
          'Not authorized to cancel this order',
        ],

        ORDER_CANNOT_BE_CANCELLED: [
          400,
          'This order can no longer be cancelled',
        ],

        TRANSPORT_ALREADY_STARTED: [
          400,
          'Transport has already started and this order cannot be cancelled here',
        ],
      };

      const mapped =
        errors[error.message];

      if (mapped) {
        return res
          .status(mapped[0])
          .json({
            error: mapped[1],
          });
      }

      res.status(500).json({
        error:
          'Failed to cancel order',
      });
    }
  }
);


// ============================================================
// BUYER CONFIRMS RECEIPT
// ============================================================

router.patch(
  '/:id/confirm-receipt',
  authenticate,
  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id: req.params.id,
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

      if (
        order.buyerId !==
        req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the buyer can confirm receipt',
        });
      }

      if (
        order.status ===
        'COMPLETED'
      ) {
        return res.status(400).json({
          error:
            'Order has already been completed',
        });
      }

      if (!order.transportJob) {
        return res.status(400).json({
          error:
            'No transport record exists for this order',
        });
      }

      if (
        order.transportJob.status !==
        'DELIVERED'
      ) {
        return res.status(400).json({
          error:
            `Receipt cannot be confirmed while transport status is ${order.transportJob.status}`,
        });
      }

      const updated =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.order.findUnique({
                where: {
                  id: order.id,
                },

                include: {
                  transportJob: true,
                },
              });

            if (
              !current ||
              current.buyerId !==
                req.user.id
            ) {
              throw new Error(
                'NOT_BUYER'
              );
            }

            if (
              current.status ===
              'COMPLETED'
            ) {
              throw new Error(
                'ALREADY_COMPLETED'
              );
            }

            if (
              !current.transportJob ||
              current.transportJob.status !==
                'DELIVERED'
            ) {
              throw new Error(
                'NOT_DELIVERED'
              );
            }

            const completed =
              await tx.order.update({
                where: {
                  id: current.id,
                },

                data: {
                  status:
                    'COMPLETED',
                },
              });

            /*
             * Once completed, the listing is permanently SOLD.
             */
            await tx.listing.updateMany({
              where: {
                id:
                  current.listingId,
              },

              data: {
                status: 'SOLD',
              },
            });

            return completed;
          }
        );

      res.json({
        message:
          'Receipt confirmed. Order completed.',

        order: updated,
      });
    } catch (error) {
      console.error(
        'CONFIRM RECEIPT ERROR:',
        error
      );

      if (
        error.message ===
        'NOT_BUYER'
      ) {
        return res.status(403).json({
          error:
            'Only the buyer can confirm receipt',
        });
      }

      if (
        error.message ===
        'ALREADY_COMPLETED'
      ) {
        return res.status(400).json({
          error:
            'Order has already been completed',
        });
      }

      if (
        error.message ===
        'NOT_DELIVERED'
      ) {
        return res.status(400).json({
          error:
            'Receipt can only be confirmed after transport is DELIVERED',
        });
      }

      res.status(500).json({
        error:
          'Failed to confirm receipt',
      });
    }
  }
);


module.exports = router;
