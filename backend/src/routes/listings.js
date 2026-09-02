const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();


// ============================================================
// PUBLIC MARKETPLACE
// ============================================================

router.get('/', async (req, res) => {
  try {
    const {
      cropType,
      title,
      location,
      status,
      minQuantity,
      category,
    } = req.query;

    /*
     * Marketplace defaults to ACTIVE.
     *
     * This is what makes temporarily reserved listings disappear
     * from normal buyer availability.
     */
    const requestedStatus =
      status || 'ACTIVE';

    const listings =
      await prisma.listing.findMany({
        where: {
          ...(cropType && {
            cropType: {
              contains: cropType,
              mode: 'insensitive',
            },
          }),

          ...(title && {
            title: {
              contains: title,
              mode: 'insensitive',
            },
          }),

          ...(location && {
            location: {
              contains: location,
              mode: 'insensitive',
            },
          }),

          ...(category && {
            category,
          }),

          status: requestedStatus,

          ...(minQuantity && {
            quantity: {
              gte: Number(minQuantity),
            },
          }),
        },

        include: {
          seller: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    res.json({
      listings,
    });
  } catch (error) {
    console.error(
      'GET LISTINGS ERROR:',
      error
    );

    res.status(500).json({
      error: 'Could not load listings',
    });
  }
});


// ============================================================
// LISTING DETAIL
// ============================================================

router.get('/:id', async (req, res) => {
  try {
    const listing =
      await prisma.listing.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          seller: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
            },
          },

          offers: true,

          inspectionRequests: {
            include: {
              report: true,

              inspector: {
                select: {
                  id: true,
                  name: true,
                  rating: true,
                },
              },
            },
          },
        },
      });

    if (!listing) {
      return res.status(404).json({
        error: 'Listing not found',
      });
    }

    res.json({
      listing,
    });
  } catch (error) {
    console.error(
      'GET LISTING ERROR:',
      error
    );

    res.status(500).json({
      error: 'Could not load listing',
    });
  }
});


// ============================================================
// CREATE LISTING
// ============================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'INSPECTOR'),

  [
    body('sellerId').notEmpty(),

    body('category')
      .optional()
      .isIn([
        'AGRICULTURAL',
        'PRODUCT',
        'DIGITAL',
      ]),

    body('title')
      .optional()
      .isString()
      .trim(),

    body('cropType')
      .optional()
      .isString()
      .trim(),

    body('quantity')
      .isFloat({ gt: 0 }),

    body('unit')
      .notEmpty(),

    body('askingPrice')
      .isFloat({ gt: 0 }),

    body('location')
      .notEmpty(),
  ],

  async (req, res) => {
    const errors =
      validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        errors: errors.array(),
      });
    }

    try {
      const {
        sellerId,
        category = 'AGRICULTURAL',
        title,
        cropType,
        quantity,
        unit,
        askingPrice,
        minAcceptablePrice,
        location,
        harvestedDate,
        readinessDate,
        photos,
        videos,
        description,
      } = req.body;

      if (
        req.user.roles.includes('INSPECTOR') &&
        !req.user.roles.includes('SELLER') &&
        sellerId === req.user.id
      ) {
        return res.status(403).json({
          error:
            'Inspectors cannot list produce as themselves; sellerId must be the farmer.',
        });
      }

      if (
        !req.user.roles.includes('INSPECTOR') &&
        sellerId !== req.user.id
      ) {
        return res.status(403).json({
          error:
            'You can only create listings under your own account',
        });
      }

      if (
        category === 'AGRICULTURAL' &&
        !cropType
      ) {
        return res.status(400).json({
          error:
            'cropType is required for agricultural listings',
        });
      }

      if (
        ['PRODUCT', 'DIGITAL'].includes(category) &&
        !title &&
        !cropType
      ) {
        return res.status(400).json({
          error:
            'title is required for this listing type',
        });
      }

      const seller =
        await prisma.user.findUnique({
          where: {
            id: sellerId,
          },
        });

      if (!seller) {
        return res.status(404).json({
          error: 'Seller account not found',
        });
      }

      if (
        !seller.roles.includes('SELLER')
      ) {
        return res.status(400).json({
          error:
            'The selected account is not enabled for selling',
        });
      }

      const listing =
        await prisma.listing.create({
          data: {
            sellerId,
            category,

            title:
              title || cropType,

            cropType:
              cropType || title,

            quantity:
              Number(quantity),

            unit,

            askingPrice:
              Number(askingPrice),

            minAcceptablePrice:
              minAcceptablePrice === undefined ||
              minAcceptablePrice === ''
                ? null
                : Number(minAcceptablePrice),

            location,

            harvestedDate:
              harvestedDate
                ? new Date(harvestedDate)
                : null,

            readinessDate:
              readinessDate
                ? new Date(readinessDate)
                : null,

            photos:
              Array.isArray(photos)
                ? photos
                : [],

            videos:
              Array.isArray(videos)
                ? videos
                : [],

            description:
              description || null,

            status: 'ACTIVE',

            createdByInspectorId:
              req.user.roles.includes(
                'INSPECTOR'
              )
                ? req.user.id
                : null,
          },
        });

      res.status(201).json({
        listing,
      });
    } catch (error) {
      console.error(
        'CREATE LISTING ERROR:',
        error
      );

      res.status(500).json({
        error: 'Could not create listing',
      });
    }
  }
);


// ============================================================
// SELLER UPDATE
// ============================================================

router.patch(
  '/:id',
  authenticate,
  async (req, res) => {
    try {
      const listing =
        await prisma.listing.findUnique({
          where: {
            id: req.params.id,
          },
        });

      if (!listing) {
        return res.status(404).json({
          error: 'Listing not found',
        });
      }

      const isAdmin =
        req.user.roles.includes('ADMIN');

      if (
        listing.sellerId !== req.user.id &&
        !isAdmin
      ) {
        return res.status(403).json({
          error:
            'Only the farmer/seller retains listing authority',
        });
      }

      const {
        askingPrice,
        minAcceptablePrice,
        quantity,
        status,
        readinessDate,
      } = req.body;

      /*
       * A seller cannot manually reopen a listing while
       * a non-cancelled/non-completed order exists.
       */
      if (status === 'ACTIVE') {
        const activeOrder =
          await prisma.order.findFirst({
            where: {
              listingId: listing.id,

              status: {
                notIn: [
                  'CANCELLED',
                  'COMPLETED',
                ],
              },
            },

            select: {
              id: true,
              status: true,
            },
          });

        if (activeOrder) {
          return res.status(409).json({
            error:
              `Listing cannot be made ACTIVE while order ${activeOrder.id.slice(0, 8)} is ${activeOrder.status}`,
          });
        }
      }

      const updated =
        await prisma.listing.update({
          where: {
            id: req.params.id,
          },

          data: {
            ...(askingPrice !== undefined && {
              askingPrice:
                Number(askingPrice),
            }),

            ...(minAcceptablePrice !== undefined && {
              minAcceptablePrice:
                minAcceptablePrice === ''
                  ? null
                  : Number(
                      minAcceptablePrice
                    ),
            }),

            ...(quantity !== undefined && {
              quantity:
                Number(quantity),
            }),

            ...(status !== undefined && {
              status,
            }),

            ...(readinessDate !== undefined && {
              readinessDate:
                readinessDate
                  ? new Date(readinessDate)
                  : null,
            }),
          },
        });

      res.json({
        listing: updated,
      });
    } catch (error) {
      console.error(
        'UPDATE LISTING ERROR:',
        error
      );

      res.status(500).json({
        error: 'Could not update listing',
      });
    }
  }
);


// ============================================================
// PRICE INSIGHTS
// ============================================================

router.get(
  '/:id/price-insights',
  authenticate,
  async (req, res) => {
    try {
      const listing =
        await prisma.listing.findUnique({
          where: {
            id: req.params.id,
          },

          include: {
            offers: {
              where: {
                status: {
                  in: [
                    'PENDING',
                    'COUNTERED',
                  ],
                },
              },
            },
          },
        });

      if (!listing) {
        return res.status(404).json({
          error: 'Listing not found',
        });
      }

      const recentSimilar =
        await prisma.listing.findMany({
          where: {
            cropType:
              listing.cropType,

            status: 'SOLD',
          },

          orderBy: {
            updatedAt: 'desc',
          },

          take: 10,

          select: {
            askingPrice: true,
            updatedAt: true,
          },
        });

      const bestOffer =
        listing.offers.reduce(
          (max, offer) =>
            offer.amount >
            (max?.amount || 0)
              ? offer
              : max,
          null
        );

      const estimatedTransportCost =
        req.query.estTransportCost
          ? Number(
              req.query.estTransportCost
            )
          : 0;

      const estimatedInspectionCost =
        req.query.estInspectionCost
          ? Number(
              req.query.estInspectionCost
            )
          : 0;

      const platformFeeRate =
        0.03;

      const grossOffer =
        bestOffer?.amount ||
        listing.askingPrice;

      const platformFee =
        grossOffer *
        platformFeeRate;

      const estimatedNetRevenue =
        grossOffer -
        estimatedTransportCost -
        estimatedInspectionCost -
        platformFee;

      res.json({
        recentMarketPrices:
          recentSimilar,

        demand: {
          competingOffers:
            listing.offers.length,
        },

        bestOffer,

        estimatedNetRevenue,

        breakdown: {
          grossOffer,
          estimatedTransportCost,
          estimatedInspectionCost,
          platformFee,
        },
      });
    } catch (error) {
      console.error(
        'PRICE INSIGHTS ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not load price insights',
      });
    }
  }
);


module.exports = router;
