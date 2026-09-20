const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { signedMediaUrl } = require('../utils/objectStorage');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');
const { validateListingReferences } = require('../utils/evidenceValidator');
const { searchListings } = require('../services/searchService');
const { getRecommendations } = require('../services/recommendationService');
const { REGIONS, REGION_VALUES } = require('../utils/ethiopianRegions');
const { haversineSql } = require('../utils/geo');

const router = express.Router();

/**
 * Listing photos/videos are stored as private object-storage keys (see
 * POST /listings/media). Resolve each key to a short-lived signed URL right
 * before sending a response, rather than persisting a URL that would expire.
 *
 * Older listings created back when this form took raw https:// URLs are
 * still supported: a value that's already an http(s) URL is passed through
 * unchanged instead of being (incorrectly) treated as a storage key.
 */
async function resolveMediaUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  try {
    return await signedMediaUrl({ key: value, disposition: 'inline' });
  } catch (error) {
    req.log.error({ err: error }, 'LISTING MEDIA SIGN ERROR:');
    return null;
  }
}

async function attachMediaUrls(listing, { includePrivateKeys = false } = {}) {
  if (!listing) return listing;

  const photoKeys = listing.photos || [];
  const videoKeys = listing.videos || [];

  const [photos, videos] = await Promise.all([
    Promise.all(photoKeys.map(resolveMediaUrl)),
    Promise.all(videoKeys.map(resolveMediaUrl)),
  ]);

  return {
    ...listing,
    photos: photos.filter(Boolean),
    videos: videos.filter(Boolean),
    ...(includePrivateKeys ? { photoKeys, videoKeys } : {}),
  };
}

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
  availableQuantity: true,
  unit: true,
  askingPrice: true,
  location: true,
  region: true,
  zone: true,
  woreda: true,
  kebele: true,
  latitude: true,
  longitude: true,
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

  if (listing.sponsoredAdId !== undefined) {
    publicListing.sponsoredAdId = listing.sponsoredAdId;
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
// ============================================================================
// SEARCH — PostgreSQL full-text search with bounded pagination
// ============================================================================

router.get('/search', optionalAuthenticate, async (req, res) => {
  try {
    const result = await searchListings(req.query);
    result.listings = await Promise.all(result.listings.map((listing) => attachMediaUrls(toPublicListing(listing))));
    return res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'LISTING SEARCH ERROR:');
    return res.status(500).json({ error: 'Could not search listings' });
  }
});

router.get('/recommendations', authenticate, async (req, res) => {
  try {
    const result = await getRecommendations(req.user.id, { limit: req.query.limit });
    result.listings = await Promise.all(result.listings.map((listing) => attachMediaUrls(toPublicListing(listing))));
    return res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'LISTING RECOMMENDATIONS ERROR:');
    return res.status(500).json({ error: 'Could not load recommendations' });
  }
});


router.get('/', optionalAuthenticate, async (req, res) => {
  try {
    const {
      cropType,
      title,
      location,
      region,
      status,
      minQuantity,
      maxQuantity,
      category,
      sellerId,
      page = 1,
      limit = 20,
      minPrice,
      maxPrice,
      readyBy,
      readyAfter,
    } = req.query;

    const pageNumber = Math.max(Number(page) || 1, 1);
    const requestedLimit = Math.max(Number(limit) || 20, 1);
    const take = Math.min(requestedLimit, 50);
    const skip = (pageNumber - 1) * take;

    if (region && !REGION_VALUES.includes(region)) {
      return res.status(400).json({ error: `Invalid region. Must be one of: ${REGION_VALUES.join(', ')}` });
    }

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

      ...(region && { region }),

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

      ...((readyBy || readyAfter) && {
        readinessDate: {
          ...(readyAfter && { gte: new Date(readyAfter) }),
          ...(readyBy && { lte: new Date(readyBy) }),
        },
      }),

      status: status || 'ACTIVE',
    };

    const sellerSelect = {
      id: true,
      name: true,
      rating: true,
      location: true,
      region: true,
      verificationStatus: true,
    };

    const now = new Date();

    const activeAds =
      await prisma.advertisement.findMany({
        where: {
          status: { in: ['ACTIVE', 'PUBLISHED', 'SCHEDULED'] },
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
          id: true,
          listingId: true,
          type: true,
          startDate: true,
        },
      });

    // Deterministic paid-placement score. Advertising never bypasses the
    // normal listing eligibility filter above (ACTIVE listings only by
    // default), and sponsored search is only boosted in an actual search.
    const BOOST_SCORE = {
      FEATURED_LISTING: 500,
      TOP_OF_CATEGORY: 1000,
      SPONSORED_SEARCH: 300,
    };
    const hasSearch = Boolean(cropType || title || location || region || minPrice || maxPrice || minQuantity || maxQuantity || readyBy || readyAfter);
    const boostRank = new Map();
    const boostAdId = new Map();
    const boostPrimaryScore = new Map();

    for (const ad of activeAds) {
      if (ad.type === 'TOP_OF_CATEGORY' && !category) continue;
      if (ad.type === 'SPONSORED_SEARCH' && !hasSearch) continue;

      const score = BOOST_SCORE[ad.type];
      const current = boostRank.get(ad.listingId) || 0;
      boostRank.set(ad.listingId, current + score);
      if (!boostPrimaryScore.has(ad.listingId) || score > boostPrimaryScore.get(ad.listingId)) {
        boostPrimaryScore.set(ad.listingId, score);
        boostAdId.set(ad.listingId, ad.id);
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

            inspectionRequests: {
              select: {
                id: true,
                status: true,
                report: { select: { id: true } },
              },
            },
          },

          orderBy: {
            createdAt: 'desc',
          },

          take,
        });

      boostedListings.sort(
        (a, b) =>
          (boostRank.get(b.id) || 0) -
          (boostRank.get(a.id) || 0)
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

                inspectionRequests: {
                  select: {
                    id: true,
                    status: true,
                    report: { select: { id: true } },
                  },
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
            sponsoredAdId: boostAdId.get(listing.id) || null,
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

            inspectionRequests: {
              select: {
                id: true,
                status: true,
                report: { select: { id: true } },
              },
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

    listings = await Promise.all(
      listings.map((listing) =>
        attachMediaUrls(listing, {
          includePrivateKeys: Boolean(
            req.user && listing.sellerId === req.user.id
          ),
        })
      )
    );

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
    req.log.error({ err: error }, 'LIST LISTINGS ERROR:');

    return res.status(500).json({
      error: 'Could not load listings',
    });
  }
});

// ============================================================================
// STRUCTURED ETHIOPIAN GEOGRAPHY
// ============================================================================

// Region dropdown data for the frontend. Public and static — same list as
// constants/ethiopianRegions.js and the Region enum in schema.prisma.
router.get('/meta/regions', (req, res) => {
  res.json({ regions: REGIONS });
});

// ============================================================================
// MARKET PRICE TRENDS
// ============================================================================
//
// Aggregates recent completed-sale prices by crop type (and optionally
// region), so a seller weighing an offer — or setting an asking price in
// the first place — can see what similar produce has actually sold for
// recently instead of guessing. Computed on the fly from Order+Listing;
// no new tables. Deliberately keeps the raw sample size small enough to
// fetch and reduce in JS rather than adding a groupBy-on-Decimal query,
// which is fine at MarketBridge's current order volume but is the first
// thing to revisit (e.g. a materialized nightly rollup) if this endpoint
// ever shows up in a slow-query report.
router.get('/market-trends', optionalAuthenticate, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { cropType, region } = req.query;

    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['DELIVERED', 'COMPLETED'] },
        createdAt: { gte: since },
        listing: {
          category: 'AGRICULTURAL',
          ...(cropType ? { cropType: { equals: String(cropType), mode: 'insensitive' } } : {}),
          ...(region ? { region: String(region) } : {}),
        },
      },
      select: {
        finalPrice: true,
        quantity: true,
        createdAt: true,
        listing: { select: { cropType: true, region: true, unit: true } },
      },
      take: 5000,
    });

    const groups = new Map();
    for (const order of orders) {
      const crop = (order.listing.cropType || 'UNSPECIFIED').trim();
      const key = `${crop.toLowerCase()}|${order.listing.region || 'ANY'}|${order.listing.unit || ''}`;
      const pricePerUnit = order.quantity > 0 ? Number(order.finalPrice) / Number(order.quantity) : null;
      if (pricePerUnit == null || !Number.isFinite(pricePerUnit)) continue;

      if (!groups.has(key)) {
        groups.set(key, { cropType: crop, region: order.listing.region || null, unit: order.listing.unit, prices: [], latestSaleAt: order.createdAt });
      }
      const group = groups.get(key);
      group.prices.push(pricePerUnit);
      if (order.createdAt > group.latestSaleAt) group.latestSaleAt = order.createdAt;
    }

    const trends = Array.from(groups.values())
      .map((g) => {
        const sorted = [...g.prices].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        return {
          cropType: g.cropType,
          region: g.region,
          unit: g.unit,
          sampleSize: sorted.length,
          averagePricePerUnit: Math.round((sum / sorted.length) * 100) / 100,
          medianPricePerUnit: sorted[Math.floor(sorted.length / 2)],
          minPricePerUnit: sorted[0],
          maxPricePerUnit: sorted[sorted.length - 1],
          latestSaleAt: g.latestSaleAt,
        };
      })
      .sort((a, b) => b.sampleSize - a.sampleSize);

    return res.json({ windowDays: days, trends });
  } catch (error) {
    req.log.error({ err: error }, 'MARKET TRENDS ERROR:');
    return res.status(500).json({ error: 'Could not load market price trends' });
  }
});

// "Nearby produce discovery": listings within radiusKm of (lat, lng),
// sorted nearest-first. Kept as its own endpoint rather than folded into
// the main search above so it doesn't have to interact with that route's
// sponsored/boosted-ad ranking — distance ordering and paid placement are
// two different sort orders, and mixing them would need real product
// decisions about precedence that are out of scope here.
router.get('/nearby', optionalAuthenticate, async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Number(req.query.radiusKm) || 50;
    const { category, cropType, status } = req.query;

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Valid lat and lng query parameters are required' });
    }

    const take = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const distanceExpr = haversineSql('Listing', 1, 2);

    const rows = await prisma.$queryRawUnsafe(
      `
      SELECT "id", ${distanceExpr} AS "distanceKm"
      FROM "Listing"
      WHERE "latitude" IS NOT NULL
        AND "longitude" IS NOT NULL
        AND "status" = $3
        AND ($4::"ListingCategory" IS NULL OR "category" = $4::"ListingCategory")
        AND ($5::text IS NULL OR "cropType" ILIKE '%' || $5::text || '%')
        AND ${distanceExpr} <= $6
      ORDER BY "distanceKm" ASC
      LIMIT $7
      `,
      lat,
      lng,
      status || 'ACTIVE',
      category || null,
      cropType || null,
      radiusKm,
      take
    );

    const distanceById = new Map(rows.map((r) => [r.id, Number(r.distanceKm)]));
    const ids = rows.map((r) => r.id);

    const listings = ids.length
      ? await prisma.listing.findMany({ where: { id: { in: ids } }, select: PUBLIC_LISTING_FIELDS })
      : [];

    const withDistance = await Promise.all(
      listings
        .sort((a, b) => distanceById.get(a.id) - distanceById.get(b.id))
        .map(async (listing) => ({
          ...(await attachMediaUrls(listing)),
          distanceKm: Math.round(distanceById.get(listing.id) * 10) / 10,
        }))
    );

    return res.json({ listings: withDistance, center: { lat, lng }, radiusKm });
  } catch (error) {
    req.log.error({ err: error }, 'LISTINGS NEARBY ERROR:');
    return res.status(500).json({ error: 'Could not load nearby listings' });
  }
});

// ============================================================================
// GET SINGLE PUBLIC LISTING
// ============================================================================

router.get('/:id', optionalAuthenticate, async (req, res) => {
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id },
      select: {
        ...PUBLIC_LISTING_FIELDS,
        seller: {
          select: {
            id: true,
            name: true,
            rating: true,
            location: true,
            region: true,
            verificationStatus: true,
          },
        },
      },
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const publicListing = toPublicListing(listing);

    // Negotiations, orders, and inspection details are private operational
    // data. They are attached only when the authenticated user is actually
    // entitled to see them. This keeps the public listing contract safe
    // without breaking the authenticated ListingDetail experience.
    if (req.user) {
      const isAdmin = Array.isArray(req.user.roles) && req.user.roles.includes('ADMIN');
      const isSeller = listing.sellerId === req.user.id;

      const [offers, orders, inspectionRequests] = await Promise.all([
        prisma.offer.findMany({
          where: isAdmin || isSeller
            ? { listingId: listing.id }
            : { listingId: listing.id, buyerId: req.user.id },
          include: isAdmin || isSeller
            ? {
                buyer: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    rating: true,
                    verificationStatus: true,
                  },
                },
              }
            : undefined,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.order.findMany({
          where: isAdmin || isSeller
            ? { listingId: listing.id, status: { not: 'CANCELLED' } }
            : { listingId: listing.id, buyerId: req.user.id, status: { not: 'CANCELLED' } },
          select: {
            id: true,
            buyerId: true,
            sellerId: true,
            status: true,
            createdAt: true,
          },
        }),
        prisma.inspectionRequest.findMany({
          where: isAdmin || isSeller
            ? { listingId: listing.id }
            : {
                listingId: listing.id,
                OR: [
                  { requestedById: req.user.id },
                  { inspectorId: req.user.id },
                ],
              },
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
              select: { id: true, status: true },
            },
            order: {
              select: { id: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      publicListing.offers = offers;
      publicListing.orders = orders;
      publicListing.inspectionRequests = inspectionRequests;
    }

    return res.json({
      listing: await attachMediaUrls(publicListing),
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET LISTING ERROR:');
    return res.status(500).json({ error: 'Could not load listing' });
  }
});

// ============================================================================
// UPLOAD LISTING MEDIA
// ============================================================================

/**
 * Upload photos/short videos for a listing before it exists.
 *
 * Mirrors the transport/inspection evidence upload pattern: files go to
 * private object storage first, the caller gets back opaque keys, and those
 * keys are then submitted as `photos`/`videos` on POST /listings. Signed,
 * viewable URLs are generated on read (see attachMediaUrls above) rather
 * than stored, since a stored signed URL would eventually expire.
 */
router.post(
  '/media',
  authenticate,
  evidenceUpload.array('files', 5),
  async (req, res) => {
    try {
      if (!req.files || !req.files.length) {
        return res.status(400).json({
          error: 'At least one photo or video file is required',
        });
      }

      const { photoKeys, videoKeys } = await uploadEvidenceFiles(
        'listing',
        req.user.id,
        req.files
      );

      return res.status(201).json({ photoKeys, videoKeys });
    } catch (error) {
      req.log.error({ err: error }, 'LISTING MEDIA UPLOAD ERROR:');

      return res.status(500).json({
        error: 'Could not upload media',
      });
    }
  }
);

// ============================================================================
// CREATE LISTING
// ============================================================================

router.post(
  '/',
  authenticate,
  [
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

    body('region')
      .optional({ nullable: true })
      .isIn(REGION_VALUES),

    body('zone')
      .optional({ nullable: true })
      .isString()
      .trim(),

    body('woreda')
      .optional({ nullable: true })
      .isString()
      .trim(),

    body('kebele')
      .optional({ nullable: true })
      .isString()
      .trim(),

    body('latitude')
      .optional({ nullable: true })
      .isFloat({ min: -90, max: 90 }),

    body('longitude')
      .optional({ nullable: true })
      .isFloat({ min: -180, max: 180 }),

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
          error: errors.array()[0]?.msg || 'Validation failed',
          errors: errors.array(),
        });
      }

      const {
        sellerId: requestedSellerId,
        category = 'AGRICULTURAL',
        title,
        cropType,
        quantity,
        unit,
        askingPrice,
        minAcceptablePrice,
        location,
        region,
        zone,
        woreda,
        kebele,
        latitude,
        longitude,
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

      // Product/Digital marketplace architecture: every authenticated user
      // may sell. For generic PRODUCT listings the seller is ALWAYS the
      // authenticated user; never trust a client-supplied sellerId.
      //
      // Agricultural listings keep the specialized seller/inspector flow.
      const sellerId =
        category === 'PRODUCT'
          ? req.user.id
          : requestedSellerId;

      if (category === 'AGRICULTURAL') {
        if (!sellerId) {
          return res.status(400).json({
            error: 'sellerId is required for agricultural listings',
          });
        }

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
              'You can only create agricultural listings under your own account',
          });
        }
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

      // Generic PRODUCT sellers do not need the legacy SELLER role.
      // Agricultural listings retain the specialized SELLER requirement,
      // except when an INSPECTOR creates the listing for a farmer.
      if (
        category === 'AGRICULTURAL' &&
        !seller.roles.includes('SELLER') &&
        !(req.user.roles.includes('INSPECTOR') && sellerId !== req.user.id)
      ) {
        return res.status(400).json({
          error:
            'The agricultural seller account is not enabled for selling',
        });
      }

      const safePhotos = Array.isArray(photos) ? validateListingReferences(photos, req.user.id, 'photos') : [];
      const safeVideos = Array.isArray(videos) ? validateListingReferences(videos, req.user.id, 'videos') : [];

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
            availableQuantity: Number(quantity),

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

            region: region || null,
            zone: zone || null,
            woreda: woreda || null,
            kebele: kebele || null,
            latitude: latitude === undefined || latitude === null || latitude === '' ? null : Number(latitude),
            longitude: longitude === undefined || longitude === null || longitude === '' ? null : Number(longitude),

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

            photos: safePhotos,

            videos: safeVideos,

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
      req.log.error({ err: error }, 'CREATE LISTING ERROR:');

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
        photos,
        videos,
        region,
        zone,
        woreda,
        kebele,
        latitude,
        longitude,
      } = req.body;

      // ----------------------------------------------------------------------
      // Validate update values before touching the database
      // ----------------------------------------------------------------------

      if (region !== undefined && region !== null && !REGION_VALUES.includes(region)) {
        return res.status(400).json({ error: `Invalid region. Must be one of: ${REGION_VALUES.join(', ')}` });
      }

      if (latitude !== undefined && latitude !== null && latitude !== '' && (!Number.isFinite(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) {
        return res.status(400).json({ error: 'latitude must be between -90 and 90' });
      }

      if (longitude !== undefined && longitude !== null && longitude !== '' && (!Number.isFinite(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) {
        return res.status(400).json({ error: 'longitude must be between -180 and 180' });
      }

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

      const currentAvailableQuantity = Number(listing.availableQuantity);
      const allocatedQuantity = Math.max(
        Number(listing.quantity) - (Number.isFinite(currentAvailableQuantity) ? currentAvailableQuantity : Number(listing.quantity)),
        0
      );

      let nextAvailableQuantity;
      if (quantity !== undefined) {
        const requestedQuantity = Number(quantity);
        if (requestedQuantity + 1e-9 < allocatedQuantity) {
          return res.status(409).json({ error: `quantity cannot be lower than already allocated quantity (${allocatedQuantity})` });
        }
        if (listing.status === 'SOLD' && listing.category === 'AGRICULTURAL' && requestedQuantity > Number(listing.quantity)) {
          return res.status(400).json({ error: 'A sold agricultural listing cannot be increased in place; create a new listing for additional produce' });
        }
        nextAvailableQuantity = requestedQuantity - allocatedQuantity;
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
      // Validate photos/videos
      //
      // The client sends the *full* desired array each time (the keys it
      // wants to keep, plus any newly-uploaded keys from POST
      // /listings/media) — this endpoint replaces, it doesn't merge, since
      // it has no way to tell "leave existing alone" apart from "clear
      // them" otherwise. Capped at 10 each as a sanity limit.
      // ----------------------------------------------------------------------

      if (
        photos !== undefined &&
        !Array.isArray(photos)
      ) {
        return res.status(400).json({
          error: 'photos must be an array',
        });
      }

      if (
        videos !== undefined &&
        !Array.isArray(videos)
      ) {
        return res.status(400).json({
          error: 'videos must be an array',
        });
      }

      const sanitizedPhotos =
        photos !== undefined
          ? photos
              .filter(
                (p) =>
                  typeof p === 'string' &&
                  p.trim()
              )
              .slice(0, 10)
          : undefined;

      const sanitizedVideos =
        videos !== undefined
          ? videos
              .filter(
                (v) =>
                  typeof v === 'string' &&
                  v.trim()
              )
              .slice(0, 10)
          : undefined;

      // ----------------------------------------------------------------------
      // Update listing
      // ----------------------------------------------------------------------

      const updated =
        await prisma.listing.update({
          where: {
            id: req.params.id,
          },

          data: {
            ...(region !== undefined && {
              region: region || null,
            }),

            ...(zone !== undefined && {
              zone: zone || null,
            }),

            ...(woreda !== undefined && {
              woreda: woreda || null,
            }),

            ...(kebele !== undefined && {
              kebele: kebele || null,
            }),

            ...(latitude !== undefined && {
              latitude: latitude === null || latitude === '' ? null : Number(latitude),
            }),

            ...(longitude !== undefined && {
              longitude: longitude === null || longitude === '' ? null : Number(longitude),
            }),

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
              availableQuantity:
                nextAvailableQuantity,
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

            ...(sanitizedPhotos !==
              undefined && {
              photos: sanitizedPhotos,
            }),

            ...(sanitizedVideos !==
              undefined && {
              videos: sanitizedVideos,
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
        listing: await attachMediaUrls(updated),
      });
    } catch (error) {
      req.log.error({ err: error }, 'UPDATE LISTING ERROR:');

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
            Number(offer.amount || 0) >
            Number(max?.amount || 0)
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
      req.log.error({ err: error }, 'PRICE INSIGHTS ERROR:');

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
