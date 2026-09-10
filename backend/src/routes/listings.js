const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');

const router = express.Router();

/**
 * Fields that are safe to expose on public listing endpoints.
 *
 * IMPORTANT:
 * minAcceptablePrice is intentionally absent.
 *
 * Never return a raw Prisma Listing from a public endpoint because the
 * database model contains seller-private fields.
 */
const PUBLIC_LISTING_FIELDS = {
  id: true,
  sellerId: true,
  category: true,
  title: true,
  cropType: true,
  quantity: true,
  unit: true,
  askingPrice: true,
  location: true,
  harvestedDate: true,
  readinessDate: true,
  pickupWindowStart: true,
  pickupWindowEnd: true,
  photos: true,
  videos: true,
  description: true,
  status: true,
  createdByInspectorId: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Explicitly serialize a listing for public API responses.
 */
function toPublicListing(listing) {
  if (!listing) return listing;

  const publicListing = {};

  for (const field of Object.keys(PUBLIC_LISTING_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(listing, field)) {
      publicListing[field] = listing[field];
    }
  }

  if (listing.seller) {
    publicListing.seller = listing.seller;
  }

  if (listing.sponsored !== undefined) {
    publicListing.sponsored = listing.sponsored;
  }

  if (listing.offers !== undefined) {
    publicListing.offers = listing.offers;
  }

  if (listing.orders !== undefined) {
    publicListing.orders = listing.orders;
  }

  if (listing.inspectionRequests !== undefined) {
    publicListing.inspectionRequests =
      listing.inspectionRequests;
  }

  return publicListing;
}

/**
 * Convert an incoming date into a valid Date.
 *
 * Returns null for empty values.
 * Returns null for invalid dates.
 */
function parseDate(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/**
 * Validate price relationships.
 *
 * The seller's private minimum acceptable price must never be negative,
 * zero, or greater than the public asking price.
 */
function validatePrices(askingPrice, minAcceptablePrice) {
  if (
    askingPrice !== undefined &&
    askingPrice !== null &&
    (!Number.isFinite(Number(askingPrice)) ||
      Number(askingPrice) <= 0)
  ) {
    return 'askingPrice must be greater than 0';
  }

  if (
    minAcceptablePrice !== undefined &&
    minAcceptablePrice !== null &&
    minAcceptablePrice !== ''
  ) {
    const minimum = Number(minAcceptablePrice);

    if (!Number.isFinite(minimum) || minimum <= 0) {
      return 'minAcceptablePrice must be greater than 0';
    }

    if (
      askingPrice !== undefined &&
      askingPrice !== null &&
      minimum > Number(askingPrice)
    ) {
      return 'minAcceptablePrice cannot be greater than askingPrice';
    }
  }

  return null;
}

/**
 * Validate agricultural dates.
 */
function validateAgriculturalDates(
  category,
  harvestedDate,
  readinessDate
) {
  if (category !== 'AGRICULTURAL') {
    return null;
  }

  const harvested =
    harvestedDate === undefined ||
    harvestedDate === null ||
    harvestedDate === ''
      ? null
      : parseDate(harvestedDate);

  const readiness =
    readinessDate === undefined ||
    readinessDate === null ||
    readinessDate === ''
      ? null
      : parseDate(readinessDate);

  if (
    harvestedDate !== undefined &&
    harvestedDate !== null &&
    harvestedDate !== '' &&
    !harvested
  ) {
    return 'harvestedDate must be a valid date';
  }

  if (
    readinessDate !== undefined &&
    readinessDate !== null &&
    readinessDate !== '' &&
    !readiness
  ) {
    return 'readinessDate must be a valid date';
  }

  if (
    harvested &&
    readiness &&
    harvested > readiness
  ) {
    return 'harvestedDate cannot be later than readinessDate';
  }

  return null;
}

/**
 * Validate an agricultural pickup window. Both boundaries are optional, but
 * if either is supplied the complete window must be supplied and end must be
 * later than start. Active listings cannot advertise a window that has
 * already completely expired.
 */
function validatePickupWindow(
  category,
  pickupWindowStart,
  pickupWindowEnd,
  existingStart = null,
  existingEnd = null
) {
  if (category !== 'AGRICULTURAL') {
    if (pickupWindowStart || pickupWindowEnd) {
      return 'pickupWindowStart and pickupWindowEnd are only allowed for agricultural listings';
    }
    return null;
  }

  const startProvided = pickupWindowStart !== undefined;
  const endProvided = pickupWindowEnd !== undefined;

  const startValue = startProvided ? pickupWindowStart : existingStart;
  const endValue = endProvided ? pickupWindowEnd : existingEnd;

  const hasStart = startValue !== undefined && startValue !== null && startValue !== '';
  const hasEnd = endValue !== undefined && endValue !== null && endValue !== '';

  if (hasStart !== hasEnd) {
    return 'pickupWindowStart and pickupWindowEnd must be provided together';
  }

  if (!hasStart && !hasEnd) return null;

  const start = parseDate(startValue);
  const end = parseDate(endValue);

  if (!start || !end) {
    return 'pickupWindowStart and pickupWindowEnd must be valid dates';
  }

  if (end <= start) {
    return 'pickupWindowEnd must be later than pickupWindowStart';
  }

  if (end <= new Date()) {
    return 'pickupWindowEnd must be in the future';
  }

  return null;
}

// ============================================================================
// PUBLIC LISTINGS — browse/search
// ============================================================================

router.get('/', async (req, res) => {
  try {
    const {
      cropType,
      title,
      location,
      status,
      minQuantity,
      maxQuantity,
      category,
      sellerId,
      page = 1,
      limit = 20,
      minPrice,
      maxPrice,
    } = req.query;

    const pageNumber = Math.max(Number(page) || 1, 1);
    const requestedLimit = Math.max(Number(limit) || 20, 1);
    const take = Math.min(requestedLimit, 50);
    const skip = (pageNumber - 1) * take;

    const where = {
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

      ...(category && { category }),

      ...(sellerId && { sellerId }),

      ...(minQuantity && {
        quantity: {
          gte: Number(minQuantity),
        },
      }),

      ...(maxQuantity && {
        quantity: {
          lte: Number(maxQuantity),
        },
      }),

      ...(minPrice && {
        askingPrice: {
          gte: Number(minPrice),
        },
      }),

      ...(maxPrice && {
        askingPrice: {
          lte: Number(maxPrice),
        },
      }),

      status: status || 'ACTIVE',
    };

    const sellerSelect = {
      id: true,
      name: true,
      rating: true,
      location: true,
      verificationStatus: true,
    };

    const now = new Date();

    const activeAds =
      await prisma.advertisement.findMany({
        where: {
          status: 'ACTIVE',
          startDate: { lte: now },
          endDate: { gte: now },
          type: {
            in: [
              'FEATURED_LISTING',
              'SPONSORED_SEARCH',
              'TOP_OF_CATEGORY',
            ],
          },
          listingId: { not: null },
          listing: where,
        },

        select: {
          listingId: true,
          type: true,
        },
      });

    const BOOST_RANK = {
      FEATURED_LISTING: 0,
      SPONSORED_SEARCH: 0,
      TOP_OF_CATEGORY: 1,
    };

    const boostRank = new Map();

    for (const ad of activeAds) {
      if (
        ad.type === 'TOP_OF_CATEGORY' &&
        !category
      ) {
        continue;
      }

      const rank = BOOST_RANK[ad.type];
      const existing = boostRank.get(ad.listingId);

      if (
        existing === undefined ||
        rank < existing
      ) {
        boostRank.set(ad.listingId, rank);
      }
    }

    const boostedIds = [...boostRank.keys()];

    const normalWhere = boostedIds.length
      ? {
          ...where,
          id: {
            notIn: boostedIds,
          },
        }
      : where;

    let listings;

    if (
      pageNumber === 1 &&
      boostedIds.length
    ) {
      const boostedListings =
        await prisma.listing.findMany({
          where: {
            ...where,
            id: {
              in: boostedIds,
            },
          },

          select: {
            ...PUBLIC_LISTING_FIELDS,

            seller: {
              select: sellerSelect,
            },
          },

          orderBy: {
            createdAt: 'desc',
          },

          take,
        });

      boostedListings.sort(
        (a, b) =>
          boostRank.get(a.id) -
          boostRank.get(b.id)
      );

      const remainingSlots = Math.max(
        take - boostedListings.length,
        0
      );

      const normalListings =
        remainingSlots
          ? await prisma.listing.findMany({
              where: normalWhere,

              select: {
                ...PUBLIC_LISTING_FIELDS,

                seller: {
                  select: sellerSelect,
                },
              },

              orderBy: {
                createdAt: 'desc',
              },

              take: remainingSlots,
            })
          : [];

      listings = [
        ...boostedListings.map((listing) =>
          toPublicListing({
            ...listing,
            sponsored: true,
          })
        ),

        ...normalListings.map((listing) =>
          toPublicListing({
            ...listing,
            sponsored: false,
          })
        ),
      ];
    } else {
      const pageSkip = boostedIds.length
        ? Math.max(
            skip - boostedIds.length,
            0
          )
        : skip;

      const normalListings =
        await prisma.listing.findMany({
          where: normalWhere,

          select: {
            ...PUBLIC_LISTING_FIELDS,

            seller: {
              select: sellerSelect,
            },
          },

          orderBy: {
            createdAt: 'desc',
          },

          skip: pageSkip,
          take,
        });

      listings = normalListings.map(
        (listing) =>
          toPublicListing({
            ...listing,
            sponsored: false,
          })
      );
    }

    const total =
      await prisma.listing.count({
        where,
      });

    return res.json({
      listings,
      total,
      page: pageNumber,
      limit: take,
      totalPages: Math.ceil(
        total / take
      ),
    });
  } catch (error) {
    console.error(
      'LIST LISTINGS ERROR:',
      error
    );

    return res.status(500).json({
      error: 'Could not load listings',
    });
  }
});

// ============================================================================
// GET SINGLE PUBLIC LISTING
// ============================================================================

router.get('/:id', async (req, res) => {
  try {
    const listing =
      await prisma.listing.findUnique({
        where: {
          id: req.params.id,
        },

        select: {
          ...PUBLIC_LISTING_FIELDS,

          seller: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
              verificationStatus: true,
            },
          },

          offers: true,

          orders: {
            where: {
              status: {
                not: 'CANCELLED',
              },
            },

            select: {
              id: true,
              buyerId: true,
              sellerId: true,
              status: true,
            },
          },

          inspectionRequests: {
            include: {
              report: true,

              inspector: {
                select: {
                  id: true,
                  name: true,
                  rating: true,
                  location: true,
                  verificationStatus: true,
                },
              },

              payments: {
                select: {
                  id: true,
                  status: true,
                },
              },

              quotes: {
                where: {
                  status: {
                    in: [
                      'PENDING',
                      'ACCEPTED',
                    ],
                  },
                },

                include: {
                  inspector: {
                    select: {
                      id: true,
                      name: true,
                      rating: true,
                      location: true,
                      verificationStatus: true,
                    },
                  },
                },

                orderBy: {
                  amount: 'asc',
                },
              },
            },

            orderBy: {
              createdAt: 'desc',
            },
          },
        },
      });

    if (!listing) {
      return res.status(404).json({
        error: 'Listing not found',
      });
    }

    return res.json({
      listing: toPublicListing(listing),
    });
  } catch (error) {
    console.error(
      'GET LISTING ERROR:',
      error
    );

    return res.status(500).json({
      error: 'Could not load listing',
    });
  }
});

// ============================================================================
// CREATE LISTING
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'INSPECTOR'),
  [
    body('sellerId')
      .notEmpty()
      .isString(),

    /**
     * DIGITAL intentionally remains excluded here.
     *
     * MarketBridge already has a separate DigitalProduct flow.
     */
    body('category')
      .optional()
      .isIn([
        'AGRICULTURAL',
        'PRODUCT',
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
      .notEmpty()
      .isString()
      .trim(),

    body('askingPrice')
      .isFloat({ gt: 0 }),

    body('location')
      .notEmpty()
      .isString()
      .trim(),

    body('minAcceptablePrice')
      .optional({
        nullable: true,
      })
      .isFloat({ gt: 0 }),

    body('harvestedDate')
      .optional({
        nullable: true,
      })
      .isISO8601(),

    body('readinessDate')
      .optional({
        nullable: true,
      })
      .isISO8601(),

    body('photos')
      .optional()
      .isArray(),

    body('videos')
      .optional()
      .isArray(),

    body('description')
      .optional()
      .isString(),
  ],

  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
        });
      }

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
        pickupWindowStart,
        pickupWindowEnd,
        photos,
        videos,
        description,
      } = req.body;

      // ----------------------------------------------------------------------
      // Permission checks
      // ----------------------------------------------------------------------

      if (
        req.user.roles.includes('INSPECTOR') &&
        !req.user.roles.includes('SELLER')
      ) {
        if (sellerId === req.user.id) {
          return res.status(403).json({
            error:
              'Inspectors cannot list produce as themselves; sellerId must be the farmer.',
          });
        }
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

      // ----------------------------------------------------------------------
      // Category-specific validation
      // ----------------------------------------------------------------------

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
        category === 'PRODUCT' &&
        !title
      ) {
        return res.status(400).json({
          error:
            'title is required for product listings',
        });
      }

      /**
       * A generic PRODUCT listing should not carry an agricultural cropType
       * merely because the title exists.
       */
      if (
        category === 'PRODUCT' &&
        cropType
      ) {
        return res.status(400).json({
          error:
            'cropType is only allowed for agricultural listings',
        });
      }

      // ----------------------------------------------------------------------
      // Price validation
      // ----------------------------------------------------------------------

      const priceError =
        validatePrices(
          Number(askingPrice),
          minAcceptablePrice
        );

      if (priceError) {
        return res.status(400).json({
          error: priceError,
        });
      }

      // ----------------------------------------------------------------------
      // Date validation
      // ----------------------------------------------------------------------

      const dateError =
        validateAgriculturalDates(
          category,
          harvestedDate,
          readinessDate
        );

      if (dateError) {
        return res.status(400).json({
          error: dateError,
        });
      }

      const pickupWindowError = validatePickupWindow(
        category,
        pickupWindowStart,
        pickupWindowEnd
      );

      if (pickupWindowError) {
        return res.status(400).json({ error: pickupWindowError });
      }

      /**
       * Agricultural dates do not make sense for a generic product.
       */
      if (
        category === 'PRODUCT' &&
        (harvestedDate ||
          readinessDate)
      ) {
        return res.status(400).json({
          error:
            'harvestedDate and readinessDate are only allowed for agricultural listings',
        });
      }

      // ----------------------------------------------------------------------
      // Seller validation
      // ----------------------------------------------------------------------

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

      if (!seller.roles.includes('SELLER')) {
        return res.status(400).json({
          error:
            'The selected account is not enabled for selling',
        });
      }

      // ----------------------------------------------------------------------
      // Create listing
      // ----------------------------------------------------------------------

      const listing =
        await prisma.listing.create({
          data: {
            sellerId,
            category,

            title:
              title || null,

            /**
             * IMPORTANT:
             * Do not copy a generic product title into cropType.
             */
            cropType:
              category === 'AGRICULTURAL'
                ? cropType
                : null,

            description,

            quantity: Number(quantity),

            unit,

            askingPrice:
              Number(askingPrice),

            minAcceptablePrice:
              minAcceptablePrice ===
              undefined ||
              minAcceptablePrice === null ||
              minAcceptablePrice === ''
                ? null
                : Number(
                    minAcceptablePrice
                  ),

            location,

            harvestedDate:
              category === 'AGRICULTURAL' &&
              harvestedDate
                ? parseDate(
                    harvestedDate
                  )
                : null,

            readinessDate:
              category === 'AGRICULTURAL' &&
              readinessDate
                ? parseDate(
                    readinessDate
                  )
                : null,

            pickupWindowStart:
              category === 'AGRICULTURAL' && pickupWindowStart
                ? parseDate(pickupWindowStart)
                : null,

            pickupWindowEnd:
              category === 'AGRICULTURAL' && pickupWindowEnd
                ? parseDate(pickupWindowEnd)
                : null,

            photos:
              Array.isArray(photos)
                ? photos
                : [],

            videos:
              Array.isArray(videos)
                ? videos
                : [],

            status: 'ACTIVE',

            createdByInspectorId:
              req.user.roles.includes(
                'INSPECTOR'
              )
                ? req.user.id
                : null,
          },
        });

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'LISTING_CREATED',
        resourceType: 'Listing',
        resourceId: listing.id,
        metadata: {
          category: listing.category,
          pickupWindowStart: listing.pickupWindowStart,
          pickupWindowEnd: listing.pickupWindowEnd,
        },
      });

      return res.status(201).json({
        listing,
      });
    } catch (error) {
      console.error(
        'CREATE LISTING ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not create listing',
      });
    }
  }
);

// ============================================================================
// UPDATE LISTING
// ============================================================================

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

      if (
        listing.sellerId !== req.user.id &&
        !req.user.roles.includes('ADMIN')
      ) {
        return res.status(403).json({
          error:
            'Only the farmer/seller retains price and listing authority',
        });
      }

      const {
        askingPrice,
        minAcceptablePrice,
        quantity,
        status,
        readinessDate,
        pickupWindowStart,
        pickupWindowEnd,
        description,
      } = req.body;

      // ----------------------------------------------------------------------
      // Validate update values before touching the database
      // ----------------------------------------------------------------------

      if (
        askingPrice !== undefined &&
        (!Number.isFinite(
          Number(askingPrice)
        ) ||
          Number(askingPrice) <= 0)
      ) {
        return res.status(400).json({
          error:
            'askingPrice must be greater than 0',
        });
      }

      if (
        quantity !== undefined &&
        (!Number.isFinite(
          Number(quantity)
        ) ||
          Number(quantity) <= 0)
      ) {
        return res.status(400).json({
          error:
            'quantity must be greater than 0',
        });
      }

      if (
        minAcceptablePrice !==
          undefined &&
        minAcceptablePrice !== null &&
        minAcceptablePrice !== ''
      ) {
        if (
          !Number.isFinite(
            Number(minAcceptablePrice)
          ) ||
          Number(minAcceptablePrice) <= 0
        ) {
          return res.status(400).json({
            error:
              'minAcceptablePrice must be greater than 0',
          });
        }
      }

      const effectiveAskingPrice =
        askingPrice !== undefined
          ? Number(askingPrice)
          : listing.askingPrice;

      const effectiveMinimum =
        minAcceptablePrice !==
          undefined
          ? minAcceptablePrice ===
              null ||
            minAcceptablePrice === ''
            ? null
            : Number(
                minAcceptablePrice
              )
          : listing.minAcceptablePrice;

      if (
        effectiveMinimum !== null &&
        effectiveMinimum !== undefined &&
        effectiveMinimum >
          effectiveAskingPrice
      ) {
        return res.status(400).json({
          error:
            'minAcceptablePrice cannot be greater than askingPrice',
        });
      }

      // ----------------------------------------------------------------------
      // Validate readinessDate
      // ----------------------------------------------------------------------

      let parsedReadinessDate;

      if (
        readinessDate !== undefined
      ) {
        if (
          readinessDate === null ||
          readinessDate === ''
        ) {
          parsedReadinessDate = null;
        } else {
          parsedReadinessDate =
            parseDate(
              readinessDate
            );

          if (!parsedReadinessDate) {
            return res.status(400).json({
              error:
                'readinessDate must be a valid date',
            });
          }
        }

        if (
          listing.harvestedDate &&
          parsedReadinessDate &&
          listing.harvestedDate >
            parsedReadinessDate
        ) {
          return res.status(400).json({
            error:
              'readinessDate cannot be earlier than harvestedDate',
          });
        }
      }

      // ----------------------------------------------------------------------
      // Validate pickup window
      // ----------------------------------------------------------------------

      const pickupWindowError = validatePickupWindow(
        listing.category,
        pickupWindowStart,
        pickupWindowEnd,
        listing.pickupWindowStart,
        listing.pickupWindowEnd
      );

      if (pickupWindowError) {
        return res.status(400).json({ error: pickupWindowError });
      }

      // ----------------------------------------------------------------------
      // Validate status
      // ----------------------------------------------------------------------

      const allowedStatuses = [
        'DRAFT',
        'ACTIVE',
        'UNDER_NEGOTIATION',
        'SOLD',
        'CANCELLED',
      ];

      if (
        status !== undefined &&
        !allowedStatuses.includes(
          status
        )
      ) {
        return res.status(400).json({
          error: 'Invalid listing status',
        });
      }

      // ----------------------------------------------------------------------
      // Update listing
      // ----------------------------------------------------------------------

      const updated =
        await prisma.listing.update({
          where: {
            id: req.params.id,
          },

          data: {
            ...(askingPrice !==
              undefined && {
              askingPrice:
                Number(askingPrice),
            }),

            ...(minAcceptablePrice !==
              undefined && {
              minAcceptablePrice:
                effectiveMinimum,
            }),

            ...(quantity !==
              undefined && {
              quantity:
                Number(quantity),
            }),

            ...(status !==
              undefined && {
              status,
            }),

            ...(readinessDate !==
              undefined && {
              readinessDate:
                parsedReadinessDate,
            }),

            ...(pickupWindowStart !== undefined && {
              pickupWindowStart: pickupWindowStart === null || pickupWindowStart === ''
                ? null
                : parseDate(pickupWindowStart),
            }),

            ...(pickupWindowEnd !== undefined && {
              pickupWindowEnd: pickupWindowEnd === null || pickupWindowEnd === ''
                ? null
                : parseDate(pickupWindowEnd),
            }),

            ...(description !==
              undefined && {
              description,
            }),
          },
        });

      const pickupWindowChanged =
        pickupWindowStart !== undefined ||
        pickupWindowEnd !== undefined;

      if (pickupWindowChanged) {
        await recordAuditEvent(prisma, {
          actorId: req.user.id,
          action: 'LISTING_PICKUP_WINDOW_CHANGED',
          resourceType: 'Listing',
          resourceId: updated.id,
          metadata: {
            previousPickupWindowStart: listing.pickupWindowStart,
            previousPickupWindowEnd: listing.pickupWindowEnd,
            pickupWindowStart: updated.pickupWindowStart,
            pickupWindowEnd: updated.pickupWindowEnd,
          },
        });
      }

      return res.json({
        listing: updated,
      });
    } catch (error) {
      console.error(
        'UPDATE LISTING ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not update listing',
      });
    }
  }
);

// ============================================================================
// PRICE INSIGHTS
// ============================================================================

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
              req.query
                .estTransportCost
            )
          : 0;

      const estimatedInspectionCost =
        req.query.estInspectionCost
          ? Number(
              req.query
                .estInspectionCost
            )
          : 0;

      const platformFeeRate = 0.03;

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

      return res.json({
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

      return res.status(500).json({
        error:
          'Could not load price insights',
      });
    }
  }
);

// Export the serializer for regression testing.
router.toPublicListing =
  toPublicListing;

module.exports = router;
