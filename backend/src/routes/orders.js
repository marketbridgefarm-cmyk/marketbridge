const express = require('express');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();


// ============================================================================
// SELECTS / INCLUDES
// ============================================================================

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
      verificationStatus:
        true,
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
      verificationStatus:
        true,
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
          verificationStatus:
            true,
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
          verificationStatus:
            true,
          rating: true,
        },
      },
    },

    orderBy: {
      amount:
        'asc',
    },
  },
};


const orderInclude = {
  listing:
    true,

  buyer: {
    select:
      userSelect,
  },

  seller: {
    select:
      userSelect,
  },

  transportJob: {
    include:
      transportInclude,
  },

  payments:
    true,

  disputes:
    true,

  ratings:
    true,
};


// ============================================================================
// MONEY HELPER
// ============================================================================

function moneyEqual(a, b) {
  return (
    Math.abs(
      Number(a) -
        Number(b)
    ) < 0.01
  );
}


// ============================================================================
// GET ORDERS
// ============================================================================

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

          include:
            orderInclude,

          orderBy: {
            createdAt:
              'desc',
          },
        });


      return res.json({
        orders,

        count:
          orders.length,
      });

    } catch (error) {
      console.error(
        'GET ORDERS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Failed to load orders',
      });
    }
  }
);


// ============================================================================
// GET SINGLE ORDER
// ============================================================================

router.get(
  '/:id',
  authenticate,

  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            ...orderInclude,

            messages: {
              orderBy: {
                createdAt:
                  'asc',
              },
            },
          },
        });


      if (!order) {
        return res.status(404).json({
          error:
            'Order not found',
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


      return res.json({
        order,
      });

    } catch (error) {
      console.error(
        'GET ORDER ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Failed to load order',
      });
    }
  }
);


// ============================================================================
// CONFIRM RECEIPT
// ============================================================================
//
// Required:
//
// MARKETPLACE payment = PAID
//
// AND, if HIRE_TRANSPORTER:
//
// TRANSPORT payment = PAID
//
// AND transport payment must match agreedAmount.
//
// Only after these checks can:
//
// DELIVERED
//     ↓
// COMPLETED
//
// ============================================================================

router.patch(
  '/:id/confirm-receipt',
  authenticate,

  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            transportJob:
              true,

            payments:
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


      // ======================================================================
      // MARKETPLACE PAYMENT
      // ======================================================================

      const marketplacePaid =
        order.payments.find(
          (payment) =>
            payment.type ===
              'MARKETPLACE' &&
            payment.status ===
              'PAID'
        );


      if (!marketplacePaid) {
        return res.status(402).json({
          error:
            'Marketplace payment must be PAID before receipt can be confirmed',
        });
      }


      // ======================================================================
      // TRANSPORT PAYMENT
      // ======================================================================

      if (
        order.transportJob.method ===
        'HIRE_TRANSPORTER'
      ) {
        if (
          !order.transportJob
            .truckOwnerId ||
          !order.transportJob
            .truckId ||
          order.transportJob
            .agreedAmount ==
            null
        ) {
          return res.status(400).json({
            error:
              'Accepted transport quote information is incomplete',
          });
        }


        const transportPaid =
          order.payments.find(
            (payment) =>
              payment.type ===
                'TRANSPORT' &&
              payment.status ===
                'PAID'
          );


        if (!transportPaid) {
          return res.status(402).json({
            error:
              'Transport payment must be PAID before receipt can be confirmed',
          });
        }


        if (
          !moneyEqual(
            transportPaid.amount,
            order.transportJob
              .agreedAmount
          )
        ) {
          return res.status(409).json({
            error:
              'Transport payment amount does not match the accepted transport fee',
          });
        }
      }


      // ======================================================================
      // TRANSACTION
      // ======================================================================

      const updated =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.order.findUnique({
                where: {
                  id:
                    order.id,
                },

                include: {
                  transportJob:
                    true,
                },
              });


            if (!current) {
              throw Object.assign(
                new Error(
                  'Order not found'
                ),
                {
                  status:
                    404,
                }
              );
            }


            if (
              current.buyerId !==
              req.user.id
            ) {
              throw Object.assign(
                new Error(
                  'Only the buyer can confirm receipt'
                ),
                {
                  status:
                    403,
                }
              );
            }


            if (
              current.status ===
              'COMPLETED'
            ) {
              throw Object.assign(
                new Error(
                  'Order has already been completed'
                ),
                {
                  status:
                    400,
                }
              );
            }


            if (
              !current.transportJob ||
              current.transportJob
                .status !==
                'DELIVERED'
            ) {
              throw Object.assign(
                new Error(
                  `Receipt cannot be confirmed while transport status is ${current.transportJob?.status || 'UNKNOWN'}`
                ),
                {
                  status:
                    400,
                }
              );
            }


            // ================================================================
            // RECHECK MARKETPLACE PAYMENT
            // ================================================================

            const marketplacePaidTx =
              await tx.payment.findFirst({
                where: {
                  orderId:
                    current.id,

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


            if (!marketplacePaidTx) {
              throw Object.assign(
                new Error(
                  'Marketplace payment must be PAID before receipt can be confirmed'
                ),
                {
                  status:
                    402,
                }
              );
            }


            // ================================================================
            // RECHECK TRANSPORT PAYMENT
            // ================================================================

            if (
              current.transportJob
                .method ===
              'HIRE_TRANSPORTER'
            ) {
              if (
                !current.transportJob
                  .truckOwnerId ||
                !current.transportJob
                  .truckId ||
                current.transportJob
                  .agreedAmount ==
                  null
              ) {
                throw Object.assign(
                  new Error(
                    'Accepted transport quote information is incomplete'
                  ),
                  {
                    status:
                      400,
                  }
                );
              }


              const transportPaidTx =
                await tx.payment.findFirst({
                  where: {
                    orderId:
                      current.id,

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


              if (!transportPaidTx) {
                throw Object.assign(
                  new Error(
                    'Transport payment must be PAID before receipt can be confirmed'
                  ),
                  {
                    status:
                      402,
                  }
                );
              }


              if (
                !moneyEqual(
                  transportPaidTx.amount,
                  current
                    .transportJob
                    .agreedAmount
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


            // ================================================================
            // COMPLETE ORDER
            // ================================================================

            return tx.order.update({
              where: {
                id:
                  current.id,
              },

              data: {
                status:
                  'COMPLETED',
              },

              include:
                orderInclude,
            });
          }
        );


      return res.json({
        message:
          'Receipt confirmed. Order completed.',

        order:
          updated,
      });

    } catch (error) {
      console.error(
        'CONFIRM RECEIPT ERROR:',
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.status
            ? error.message
            : 'Failed to confirm receipt',
      });
    }
  }
);


module.exports = router;
