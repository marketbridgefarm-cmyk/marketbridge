const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

// Buyer makes an offer.
//
// IMPORTANT BUSINESS RULE:
// PENDING / COUNTERED offers DO NOT remove a listing from marketplace
// availability. Only an ACCEPTED offer temporarily reserves it.
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
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: errors.array(),
      });
    }

    try {
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

      if (!['AGRICULTURAL', 'PRODUCT'].includes(listing.category)) {
        return res.status(400).json({
          error:
            'Offers are currently available for agricultural and physical product listings',
        });
      }

      /*
       * ONLY ACTIVE listings are available to buyers.
       *
       * UNDER_NEGOTIATION is used AFTER a seller accepts an offer
       * and an order is created.
       */
      if (listing.status !== 'ACTIVE') {
        return res.status(409).json({
          error:
            'This listing is no longer available for new offers',
        });
      }

      if (listing.sellerId === req.user.id) {
        return res.status(403).json({
          error: 'You cannot make an offer on your own listing',
        });
      }

      /*
       * Prevent the same buyer from creating multiple simultaneous
       * offers on the same listing.
       */
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

      const offer = await prisma.offer.create({
        data: {
          listingId,
          buyerId: req.user.id,
          amount,
          message,
          status: 'PENDING',
        },
      });

      /*
       * CRITICAL:
       *
       * Do NOT change listing.status here.
       *
       * Other buyers must still see this listing and may submit
       * their own offers.
       */
      return res.status(201).json({
        message: 'Offer submitted successfully',
        offer,
      });
    } catch (error) {
      console.error('CREATE OFFER ERROR:', error);

      return res.status(500).json({
        error: 'Could not create offer',
      });
    }
  }
);


// Buyer — my offers
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


// Get offers for a listing
//
// Seller/admin: all offers
// Buyer: only their own offer
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

      const where =
        isSeller || isAdmin
          ? {
              listingId: listing.id,
            }
          : {
              listingId: listing.id,
              buyerId: req.user.id,
            };

      const offers = await prisma.offer.findMany({
        where,

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


// Seller responds to offer.
//
// ACCEPT
// REJECT
// COUNTER
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

      if (
        offer.listing.sellerId !== req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the farmer who owns this listing can respond to offers',
        });
      }


      // ==========================================================
      // ACCEPT
      // ==========================================================

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

        const finalPrice =
          offer.status === 'COUNTERED' &&
          offer.counterAmount !== null &&
          offer.counterAmount !== undefined
            ? Number(offer.counterAmount)
            : Number(offer.amount);

        const result =
          await prisma.$transaction(async (tx) => {

            /*
             * ATOMIC RESERVATION
             *
             * Only ACTIVE can become UNDER_NEGOTIATION.
             *
             * This prevents two simultaneous accept operations
             * from reserving the same listing.
             */
            const reserved =
              await tx.listing.updateMany({
                where: {
                  id: offer.listingId,
                  status: 'ACTIVE',
                },

                data: {
                  status: 'UNDER_NEGOTIATION',
                },
              });

            if (reserved.count !== 1) {
              throw new Error(
                'LISTING_NOT_AVAILABLE'
              );
            }

            /*
             * Defensive order check.
             */
            const existingOrder =
              await tx.order.findFirst({
                where: {
                  listingId: offer.listingId,
                },
              });

            if (existingOrder) {
              throw new Error(
                'ORDER_ALREADY_EXISTS'
              );
            }

            /*
             * Accept selected offer.
             */
            const updatedOffer =
              await tx.offer.update({
                where: {
                  id: offer.id,
                },

                data: {
                  status: 'ACCEPTED',
                },
              });

            /*
             * Competing active offers lose.
             */
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

            /*
             * Create the order.
             *
             * Payment remains PENDING_PAYMENT.
             * Transport is NOT automatically assigned.
             */
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
          });

        return res.json({
          message:
            'Offer accepted and order created successfully',

          offer: result.offer,

          order: result.order,

          transportAutomaticallyAssigned:
            false,
        });
      }


      // ==========================================================
      // REJECT
      // ==========================================================

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

        const updatedOffer =
          await prisma.offer.update({
            where: {
              id: offer.id,
            },

            data: {
              status: 'REJECTED',
            },
          });

        /*
         * IMPORTANT:
         *
         * Rejecting an offer does NOT change listing availability.
         *
         * The listing was never removed because of the offer.
         */
        return res.json({
          message: 'Offer rejected',
          offer: updatedOffer,
        });
      }


      // ==========================================================
      // COUNTER
      // ==========================================================

      const numericCounter =
        Number(counterAmount);

      if (
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
            counterAmount: numericCounter,
          },
        });

      /*
       * IMPORTANT:
       *
       * Countering an offer does NOT remove the listing.
       */
      return res.json({
        message: 'Counter-offer submitted',
        offer: updated,
      });

    } catch (error) {
      console.error(
        'RESPOND TO OFFER ERROR:',
        error
      );

      if (
        error.message ===
        'LISTING_NOT_AVAILABLE'
      ) {
        return res.status(409).json({
          error:
            'This listing has already been reserved by an accepted offer',
        });
      }

      if (
        error.message ===
        'ORDER_ALREADY_EXISTS'
      ) {
        return res.status(409).json({
          error:
            'An order already exists for this listing',
        });
      }

      return res.status(500).json({
        error: 'Could not respond to offer',
      });
    }
  }
);


module.exports = router;
