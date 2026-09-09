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
// BUYER MAKES AN OFFER
// POST /api/offers
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('BUYER'),
  [
    body('listingId')
      .notEmpty()
      .withMessage(
        'listingId is required'
      ),

    body('amount')
      .isFloat({ gt: 0 })
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
          errors: errors.array(),
        });
      }

      const listingId =
        req.body.listingId;

      const amount =
        Number(req.body.amount);

      const message =
        req.body.message ||
        null;

      const listing =
        await prisma.listing.findUnique({
          where: {
            id: listingId,
          },
        });

      if (!listing) {
        return res.status(404).json({
          error:
            'Listing not found',
        });
      }

      if (
        listing.category !==
        'AGRICULTURAL'
      ) {
        return res.status(400).json({
          error:
            'Offers are currently available for agricultural listings only',
        });
      }

      if (
        ![
          'ACTIVE',
          'UNDER_NEGOTIATION',
        ].includes(listing.status)
      ) {
        return res.status(400).json({
          error:
            'Listing is not open for offers',
        });
      }

      if (
        listing.sellerId ===
        req.user.id
      ) {
        return res.status(403).json({
          error:
            'You cannot make an offer on your own listing',
        });
      }

      const existingOffer =
        await prisma.offer.findFirst({
          where: {
            listingId,
            buyerId:
              req.user.id,

            status: {
              in: [
                'PENDING',
                'COUNTERED',
              ],
            },
          },
        });

      if (existingOffer) {
        return res.status(409).json({
          error:
            'You already have an active offer on this listing',
          offer: existingOffer,
        });
      }

      const offer =
        await prisma.$transaction(
          async (tx) => {
            const createdOffer =
              await tx.offer.create({
                data: {
                  listingId,
                  buyerId:
                    req.user.id,

                  amount,
                  message,

                  status:
                    'PENDING',
                },
              });

            await tx.listing.update({
              where: {
                id: listingId,
              },

              data: {
                status:
                  'UNDER_NEGOTIATION',
              },
            });

            return createdOffer;
          }
        );

      return res.status(201).json({
        message:
          'Offer submitted successfully',
        offer,
      });
    } catch (error) {
      console.error(
        'CREATE OFFER ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not create offer',

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
// BUYER — MY OFFERS
// GET /api/offers/mine
// ============================================================================

router.get(
  '/mine',
  authenticate,
  async (req, res) => {
    try {
      const offers =
        await prisma.offer.findMany({
          where: {
            buyerId:
              req.user.id,
          },

          include: {
            listing: true,
          },

          orderBy: {
            createdAt: 'desc',
          },
        });

      return res.json({
        offers,
        count: offers.length,
      });
    } catch (error) {
      console.error(
        'MY OFFERS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load your offers',
      });
    }
  }
);

// ============================================================================
// GET OFFERS FOR A LISTING
// ============================================================================

router.get(
  '/listing/:listingId',
  authenticate,
  async (req, res) => {
    try {
      const listing =
        await prisma.listing.findUnique({
          where: {
            id: req.params.listingId,
          },
        });

      if (!listing) {
        return res.status(404).json({
          error:
            'Listing not found',
        });
      }

      const isSeller =
        listing.sellerId ===
        req.user.id;

      const isAdmin =
        Array.isArray(
          req.user.roles
        ) &&
        req.user.roles.includes(
          'ADMIN'
        );

      if (isAdmin || isSeller) {
        const offers =
          await prisma.offer.findMany({
            where: {
              listingId:
                req.params.listingId,
            },

            include: {
              buyer: {
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

            orderBy: {
              createdAt: 'desc',
            },
          });

        return res.json({
          offers,
          count: offers.length,
        });
      }

      const offers =
        await prisma.offer.findMany({
          where: {
            listingId:
              req.params.listingId,

            buyerId:
              req.user.id,
          },

          include: {
            buyer: {
              select: {
                id: true,
                name: true,
                rating: true,
                verificationStatus:
                  true,
              },
            },
          },

          orderBy: {
            createdAt: 'desc',
          },
        });

      return res.json({
        offers,
        count: offers.length,
      });
    } catch (error) {
      console.error(
        'GET LISTING OFFERS ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Could not load listing offers',
      });
    }
  }
);

// ============================================================================
// OFFER ORDER CREATION
// ============================================================================

async function acceptOfferAndCreateOrder(
  tx,
  offer,
  finalPrice,
  sellerId
) {
  const existingOrder =
    await tx.order.findFirst({
      where: {
        listingId:
          offer.listingId,
      },
    });

  if (existingOrder) {
    const error = new Error(
      'An order already exists for this listing'
    );

    error.code =
      'ORDER_ALREADY_EXISTS';

    error.statusCode = 409;

    throw error;
  }

  const updatedOffer =
    await tx.offer.update({
      where: {
        id: offer.id,
      },

      data: {
        status:
          'ACCEPTED',
      },
    });

  await tx.offer.updateMany({
    where: {
      listingId:
        offer.listingId,

      id: {
        not: offer.id,
      },

      status: {
        in: [
          'PENDING',
          'COUNTERED',
        ],
      },
    },

    data: {
      status:
        'REJECTED',
    },
  });

  await tx.listing.update({
    where: {
      id: offer.listingId,
    },

    data: {
      status:
        'SOLD',
    },
  });

  const order =
    await tx.order.create({
      data: {
        listingId:
          offer.listingId,

        buyerId:
          offer.buyerId,

        sellerId,

        finalPrice,

        status:
          'PENDING_PAYMENT',
      },
    });

  return {
    offer: updatedOffer,
    order,
  };
}

// ============================================================================
// OFFER RESPONSE
// PATCH /api/offers/:id
//
// SELLER actions:
//   ACCEPT
//   REJECT
//   COUNTER
//
// BUYER actions:
//   ACCEPT_COUNTER
//   RE_COUNTER
//
// BUYER can only act on COUNTERED offers.
// ============================================================================

router.patch(
  '/:id',
  authenticate,
  async (req, res) => {
    try {
      const {
        action,
        counterAmount,
      } = req.body;

      const allowedActions = [
        'ACCEPT',
        'REJECT',
        'COUNTER',
        'ACCEPT_COUNTER',
        'RE_COUNTER',
      ];

      if (
        !allowedActions.includes(
          action
        )
      ) {
        return res.status(400).json({
          error:
            `Invalid action. Use ${allowedActions.join(', ')}.`,
        });
      }

      const offer =
        await prisma.offer.findUnique({
          where: {
            id: req.params.id,
          },

          include: {
            listing: true,
          },
        });

      if (!offer) {
        return res.status(404).json({
          error:
            'Offer not found',
        });
      }

      const isSeller =
        offer.listing.sellerId ===
        req.user.id;

      const isBuyer =
        offer.buyerId ===
        req.user.id;

      const isAdmin =
        Array.isArray(
          req.user.roles
        ) &&
        req.user.roles.includes(
          'ADMIN'
        );

      if (
        !isSeller &&
        !isBuyer &&
        !isAdmin
      ) {
        return res.status(403).json({
          error:
            'You are not a participant in this offer',
        });
      }

      // ======================================================================
      // SELLER ACTIONS
      // ======================================================================

      if (
        action === 'ACCEPT' ||
        action === 'REJECT' ||
        action === 'COUNTER'
      ) {
        if (
          !isSeller &&
          !isAdmin
        ) {
          return res.status(403).json({
            error:
              'Only the seller can perform this action',
          });
        }
      }

      // ======================================================================
      // BUYER ACCEPTS SELLER COUNTER
      // ======================================================================

      if (
        action ===
        'ACCEPT_COUNTER'
      ) {
        if (
          !isBuyer &&
          !isAdmin
        ) {
          return res.status(403).json({
            error:
              'Only the buyer can accept a counter-offer',
          });
        }

        if (
          offer.status !==
          'COUNTERED'
        ) {
          return res.status(400).json({
            error:
              `A counter-offer can only be accepted while the offer is COUNTERED (current: ${offer.status})`,
          });
        }

        if (
          offer.counterAmount ===
            null ||
          offer.counterAmount ===
            undefined
        ) {
          return res.status(400).json({
            error:
              'Counter-offer has no counter amount',
          });
        }

        const finalPrice =
          Number(
            offer.counterAmount
          );

        const result =
          await prisma.$transaction(
            async (tx) => {
              // Re-read inside the transaction to avoid accepting a stale
              // counter after another participant has already acted.
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },

                  include: {
                    listing: true,
                  },
                });

              if (!freshOffer) {
                const error = new Error(
                  'Offer not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                freshOffer.status !==
                'COUNTERED'
              ) {
                const error = new Error(
                  `Offer cannot be accepted because it is ${freshOffer.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              return acceptOfferAndCreateOrder(
                tx,
                freshOffer,
                Number(
                  freshOffer.counterAmount
                ),
                freshOffer.listing
                  .sellerId
              );
            }
          );

        return res.json({
          message:
            'Counter-offer accepted and order created successfully',

          offer:
            result.offer,

          order:
            result.order,

          transportAutomaticallyAssigned:
            false,
        });
      }

      // ======================================================================
      // BUYER RE-COUNTERS
      // ======================================================================

      if (
        action ===
        'RE_COUNTER'
      ) {
        if (
          !isBuyer &&
          !isAdmin
        ) {
          return res.status(403).json({
            error:
              'Only the buyer can respond with another counter-offer',
          });
        }

        if (
          offer.status !==
          'COUNTERED'
        ) {
          return res.status(400).json({
            error:
              `You can only re-counter a COUNTERED offer (current: ${offer.status})`,
          });
        }

        const numericCounter =
          Number(counterAmount);

        if (
          counterAmount ===
            undefined ||
          counterAmount ===
            null ||
          !Number.isFinite(
            numericCounter
          ) ||
          numericCounter <= 0
        ) {
          return res.status(400).json({
            error:
              'counterAmount must be greater than zero',
          });
        }

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                });

              if (!freshOffer) {
                const error = new Error(
                  'Offer not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                freshOffer.status !==
                'COUNTERED'
              ) {
                const error = new Error(
                  `Offer cannot be re-countered because it is ${freshOffer.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              return tx.offer.update({
                where: {
                  id: freshOffer.id,
                },

                data: {
                  status:
                    'COUNTERED',

                  counterAmount:
                    numericCounter,
                },
              });
            }
          );

        return res.json({
          message:
            'Buyer counter-offer submitted',
          offer: updated,
        });
      }

      // ======================================================================
      // SELLER ACCEPTS
      // ======================================================================

      if (
        action === 'ACCEPT'
      ) {
        if (
          ![
            'PENDING',
            'COUNTERED',
          ].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be accepted because it is ${offer.status}`,
          });
        }

        const finalPrice =
          offer.status ===
            'COUNTERED' &&
          offer.counterAmount !==
            null &&
          offer.counterAmount !==
            undefined
            ? Number(
                offer.counterAmount
              )
            : Number(
                offer.amount
              );

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },

                  include: {
                    listing: true,
                  },
                });

              if (!freshOffer) {
                const error = new Error(
                  'Offer not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                ![
                  'PENDING',
                  'COUNTERED',
                ].includes(
                  freshOffer.status
                )
              ) {
                const error = new Error(
                  `Offer cannot be accepted because it is ${freshOffer.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              const freshFinalPrice =
                freshOffer.status ===
                  'COUNTERED' &&
                freshOffer.counterAmount !==
                  null &&
                freshOffer.counterAmount !==
                  undefined
                  ? Number(
                      freshOffer.counterAmount
                    )
                  : Number(
                      freshOffer.amount
                    );

              return acceptOfferAndCreateOrder(
                tx,
                freshOffer,
                freshFinalPrice,
                freshOffer
                  .listing
                  .sellerId
              );
            }
          );

        return res.json({
          message:
            'Offer accepted and order created successfully',

          offer:
            result.offer,

          order:
            result.order,

          transportAutomaticallyAssigned:
            false,
        });
      }

      // ======================================================================
      // SELLER REJECTS
      // ======================================================================

      if (
        action === 'REJECT'
      ) {
        if (
          ![
            'PENDING',
            'COUNTERED',
          ].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be rejected because it is ${offer.status}`,
          });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                });

              if (!freshOffer) {
                const error = new Error(
                  'Offer not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                ![
                  'PENDING',
                  'COUNTERED',
                ].includes(
                  freshOffer.status
                )
              ) {
                const error = new Error(
                  `Offer cannot be rejected because it is ${freshOffer.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              const updatedOffer =
                await tx.offer.update({
                  where: {
                    id: freshOffer.id,
                  },

                  data: {
                    status:
                      'REJECTED',
                  },
                });

              const remainingOffers =
                await tx.offer.count({
                  where: {
                    listingId:
                      freshOffer.listingId,

                    status: {
                      in: [
                        'PENDING',
                        'COUNTERED',
                      ],
                    },
                  },
                });

              if (
                remainingOffers ===
                0
              ) {
                await tx.listing.update({
                  where: {
                    id:
                      freshOffer.listingId,
                  },

                  data: {
                    status:
                      'ACTIVE',
                  },
                });
              }

              return updatedOffer;
            }
          );

        return res.json({
          message:
            'Offer rejected',
          offer: result,
        });
      }

      // ======================================================================
      // SELLER COUNTERS
      // ======================================================================

      if (
        action === 'COUNTER'
      ) {
        const numericCounter =
          Number(counterAmount);

        if (
          counterAmount ===
            undefined ||
          counterAmount ===
            null ||
          !Number.isFinite(
            numericCounter
          ) ||
          numericCounter <= 0
        ) {
          return res.status(400).json({
            error:
              'counterAmount must be greater than zero',
          });
        }

        if (
          ![
            'PENDING',
            'COUNTERED',
          ].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be countered because it is ${offer.status}`,
          });
        }

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                });

              if (!freshOffer) {
                const error = new Error(
                  'Offer not found'
                );
                error.statusCode = 404;
                throw error;
              }

              if (
                ![
                  'PENDING',
                  'COUNTERED',
                ].includes(
                  freshOffer.status
                )
              ) {
                const error = new Error(
                  `Offer cannot be countered because it is ${freshOffer.status}`
                );
                error.statusCode = 409;
                throw error;
              }

              return tx.offer.update({
                where: {
                  id: freshOffer.id,
                },

                data: {
                  status:
                    'COUNTERED',

                  counterAmount:
                    numericCounter,
                },
              });
            }
          );

        return res.json({
          message:
            'Counter-offer submitted',
          offer: updated,
        });
      }

      return res.status(400).json({
        error:
          'Unsupported offer action',
      });
    } catch (error) {
      console.error(
        'RESPOND TO OFFER ERROR:',
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
        'ORDER_ALREADY_EXISTS'
      ) {
        return res.status(409).json({
          error:
            error.message,
        });
      }

      if (
        error.code ===
        'P2002'
      ) {
        return res.status(409).json({
          error:
            'An order already exists for this listing',
        });
      }

      return res.status(500).json({
        error:
          'Could not respond to offer',

        details:
          process.env.NODE_ENV ===
          'development'
            ? error.message
            : undefined,
      });
    }
  }
);

module.exports = router;
