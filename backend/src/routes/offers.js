const express = require('express');
const { body, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();


// ============================================================
// BUYER MAKES AN OFFER
// POST /api/offers
// ============================================================

router.post(
  '/',
  authenticate,
  requireRole('BUYER'),
  [
    body('listingId')
      .notEmpty()
      .withMessage('listingId is required'),

    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('amount must be greater than zero'),

    body('message')
      .optional()
      .isString()
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

      const listingId = req.body.listingId;
      const amount = Number(req.body.amount);
      const message = req.body.message || null;

      const listing = await prisma.listing.findUnique({
        where: {
          id: listingId,
        },
      });

      if (!listing) {
        return res.status(404).json({
          error: 'Listing not found',
        });
      }

      if (listing.category !== 'AGRICULTURAL') {
        return res.status(400).json({
          error: 'Offers are currently available for agricultural listings only',
        });
      }

      if (!['ACTIVE', 'UNDER_NEGOTIATION'].includes(listing.status)) {
        return res.status(400).json({
          error: 'Listing is not open for offers',
        });
      }

      if (listing.sellerId === req.user.id) {
        return res.status(403).json({
          error: 'You cannot make an offer on your own listing',
        });
      }

      // Prevent another offer if this buyer already has
      // an active offer on this listing.
      const existingOffer = await prisma.offer.findFirst({
        where: {
          listingId,
          buyerId: req.user.id,
          status: {
            in: ['PENDING', 'COUNTERED'],
          },
        },
      });

      if (existingOffer) {
        return res.status(409).json({
          error: 'You already have an active offer on this listing',
          offer: existingOffer,
        });
      }

      const offer = await prisma.$transaction(async (tx) => {
        const createdOffer = await tx.offer.create({
          data: {
            listingId,
            buyerId: req.user.id,
            amount,
            message,
            status: 'PENDING',
          },
        });

        await tx.listing.update({
          where: {
            id: listingId,
          },
          data: {
            status: 'UNDER_NEGOTIATION',
          },
        });

        return createdOffer;
      });

      return res.status(201).json({
        message: 'Offer submitted successfully',
        offer,
      });

    } catch (error) {
      console.error('CREATE OFFER ERROR:', error);

      return res.status(500).json({
        error: 'Could not create offer',
        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================
// BUYER — MY OFFERS
// GET /api/offers/mine
// ============================================================

router.get(
  '/mine',
  authenticate,
  async (req, res) => {
    try {
      const offers = await prisma.offer.findMany({
        where: {
          buyerId: req.user.id,
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
      console.error('MY OFFERS ERROR:', error);

      return res.status(500).json({
        error: 'Could not load your offers',
      });
    }
  }
);


// ============================================================
// GET OFFERS FOR A LISTING
//
// IMPORTANT:
// This route MUST appear before /:id.
//
// Seller:
//   sees all offers on own listing.
//
// Buyer:
//   sees only their own offer on the listing.
//
// Admin:
//   sees all offers.
//
// GET /api/offers/listing/:listingId
// ============================================================

router.get(
  '/listing/:listingId',
  authenticate,
  async (req, res) => {
    try {
      const listing = await prisma.listing.findUnique({
        where: {
          id: req.params.listingId,
        },
      });

      if (!listing) {
        return res.status(404).json({
          error: 'Listing not found',
        });
      }

      const isSeller =
        listing.sellerId === req.user.id;

      const isAdmin =
        Array.isArray(req.user.roles) &&
        req.user.roles.includes('ADMIN');

      if (isAdmin || isSeller) {
        const offers = await prisma.offer.findMany({
          where: {
            listingId: req.params.listingId,
          },

          include: {
            buyer: {
              select: {
                id: true,
                name: true,
                phone: true,
                rating: true,
                verificationStatus: true,
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

      // Buyer can only see their own offer.
      const offers = await prisma.offer.findMany({
        where: {
          listingId: req.params.listingId,
          buyerId: req.user.id,
        },

        include: {
          buyer: {
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
        error: 'Could not load listing offers',
      });
    }
  }
);


// ============================================================
// SELLER — RESPOND TO OFFER
//
// PATCH /api/offers/:id
//
// Actions:
//
// ACCEPT
// REJECT
// COUNTER
//
// Seller is the price authority.
// ============================================================

router.patch(
  '/:id',
  authenticate,
  requireRole('SELLER'),
  async (req, res) => {
    try {
      const {
        action,
        counterAmount,
      } = req.body;

      if (
        !['ACCEPT', 'REJECT', 'COUNTER'].includes(action)
      ) {
        return res.status(400).json({
          error:
            'Invalid action. Use ACCEPT, REJECT, or COUNTER.',
        });
      }

      const offer = await prisma.offer.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          listing: true,
        },
      });

      if (!offer) {
        return res.status(404).json({
          error: 'Offer not found',
        });
      }

      // --------------------------------------------------------
      // Verify seller owns listing
      // --------------------------------------------------------

      if (
        offer.listing.sellerId !== req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the farmer who owns this listing can respond to offers',
        });
      }


      // ========================================================
      // ACCEPT OFFER
      // ========================================================

      if (action === 'ACCEPT') {

        if (
          !['PENDING', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be accepted because it is ${offer.status}`,
          });
        }

        // If seller countered, the counter price is final.
        const finalPrice =
          offer.status === 'COUNTERED' &&
          offer.counterAmount !== null &&
          offer.counterAmount !== undefined
            ? Number(offer.counterAmount)
            : Number(offer.amount);

        const result = await prisma.$transaction(
          async (tx) => {

            // --------------------------------------------------
            // Make sure no order already exists for listing.
            // --------------------------------------------------

            const existingOrder =
              await tx.order.findFirst({
                where: {
                  listingId: offer.listingId,
                },
              });

            if (existingOrder) {
              throw new Error(
                'An order already exists for this listing'
              );
            }

            // --------------------------------------------------
            // Accept selected offer
            // --------------------------------------------------

            const updatedOffer =
              await tx.offer.update({
                where: {
                  id: offer.id,
                },

                data: {
                  status: 'ACCEPTED',
                },
              });

            // --------------------------------------------------
            // Reject all competing offers
            // --------------------------------------------------

            await tx.offer.updateMany({
              where: {
                listingId: offer.listingId,

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
                status: 'REJECTED',
              },
            });

            // --------------------------------------------------
            // Listing is now sold/reserved.
            // --------------------------------------------------

            await tx.listing.update({
              where: {
                id: offer.listingId,
              },

              data: {
                status: 'SOLD',
              },
            });

            // --------------------------------------------------
            // Create order.
            //
            // Payment remains pending.
            // Transport is NOT automatically assigned.
            // --------------------------------------------------

            const order =
              await tx.order.create({
                data: {
                  listingId: offer.listingId,
                  buyerId: offer.buyerId,
                  sellerId: req.user.id,
                  finalPrice,
                  status: 'PENDING_PAYMENT',
                },
              });

            return {
              offer: updatedOffer,
              order,
            };
          }
        );

        return res.json({
          message:
            'Offer accepted and order created successfully',

          offer: result.offer,

          order: result.order,

          transportAutomaticallyAssigned: false,
        });
      }


      // ========================================================
      // REJECT OFFER
      // ========================================================

      if (action === 'REJECT') {

        if (
          !['PENDING', 'COUNTERED'].includes(
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

              const updatedOffer =
                await tx.offer.update({
                  where: {
                    id: offer.id,
                  },

                  data: {
                    status: 'REJECTED',
                  },
                });

              // Check whether another active offer exists.
              const remainingOffers =
                await tx.offer.count({
                  where: {
                    listingId: offer.listingId,

                    status: {
                      in: [
                        'PENDING',
                        'COUNTERED',
                      ],
                    },
                  },
                });

              // If nobody is negotiating anymore,
              // reopen the listing.
              if (remainingOffers === 0) {
                await tx.listing.update({
                  where: {
                    id: offer.listingId,
                  },

                  data: {
                    status: 'ACTIVE',
                  },
                });
              }

              return updatedOffer;
            }
          );

        return res.json({
          message: 'Offer rejected',
          offer: result,
        });
      }


      // ========================================================
      // COUNTER OFFER
      // ========================================================

      if (action === 'COUNTER') {

        const numericCounter =
          Number(counterAmount);

        if (
          counterAmount === undefined ||
          counterAmount === null ||
          !Number.isFinite(numericCounter) ||
          numericCounter <= 0
        ) {
          return res.status(400).json({
            error:
              'counterAmount must be greater than zero',
          });
        }

        if (
          !['PENDING', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be countered because it is ${offer.status}`,
          });
        }

        const updated =
          await prisma.offer.update({
            where: {
              id: offer.id,
            },

            data: {
              status: 'COUNTERED',

              counterAmount:
                numericCounter,
            },
          });

        return res.json({
          message: 'Counter-offer submitted',
          offer: updated,
        });
      }

    } catch (error) {
      console.error(
        'RESPOND TO OFFER ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not respond to offer',

        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);


// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;
