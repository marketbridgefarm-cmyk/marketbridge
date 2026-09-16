'use strict';

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../utils/authorization');
const { recordAuditEvent } = require('../utils/audit');
const { signedMediaUrl, uploadPrivateObject } = require('../utils/objectStorage');
const { AD_TYPES, dailyRatesEtb, campaignDays, quotePrice } = require('../utils/adPricing');
const { optimizeUpload } = require('../utils/imageProcessor');

const BANNER_TEMPLATES = ['CLASSIC', 'BOLD', 'MINIMAL', 'CARD', 'SPLIT', 'EDITORIAL', 'FRESH', 'DARK_LUXE', 'MARKET', 'GRADIENT'];
const MAX_CREATIVE_BYTES = Number(process.env.AD_BANNER_MAX_FILE_BYTES || 5 * 1024 * 1024);
const MAX_HEADLINE = 140;
const MAX_URL = 2000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const router = express.Router();

const adEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const creativeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CREATIVE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error('Banner image must be JPEG, PNG, or WebP'));
    }
    cb(null, true);
  },
});

function hasValidImageSignature(buffer, mime) {
  if (!buffer || !Buffer.isBuffer(buffer)) return false;
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  next();
}

function safeText(value, max = MAX_HEADLINE) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : null;
}

function safeDestinationUrl(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw.slice(0, MAX_URL);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.toString().slice(0, MAX_URL);
  } catch {
    return null;
  }
}

function withComputedStatus(ad) {
  const now = new Date();
  if (['ACTIVE', 'PUBLISHED', 'SCHEDULED', 'APPROVED'].includes(ad.status) && new Date(ad.endDate) < now) {
    return { ...ad, status: 'EXPIRED' };
  }
  if (ad.status === 'SCHEDULED' && new Date(ad.startDate) <= now) {
    return { ...ad, status: 'PUBLISHED' };
  }
  return ad;
}

async function attachCreativeUrl(ad) {
  if (!ad) return ad;
  const result = { ...ad };
  if (ad.creativeImageKey) {
    try {
      result.creativeImageUrl = await signedMediaUrl({ key: ad.creativeImageKey, disposition: 'inline' });
    } catch {
      result.creativeImageUrl = null;
    }
  } else {
    result.creativeImageUrl = null;
  }
  return result;
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

router.get('/pricing', authenticate, (req, res) => {
  return res.json({
    currency: 'ETB',
    dailyRatesEtb: dailyRatesEtb(),
    maxCampaignDays: Number(process.env.AD_MAX_CAMPAIGN_DAYS || 90),
    bannerTemplates: BANNER_TEMPLATES,
  });
});

router.post('/creative', authenticate, creativeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Banner image file is required' });
    if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: 'File magic bytes do not match declared image type' });
    }

    const optimized = await optimizeUpload({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      maxWidth: Number(process.env.AD_IMAGE_MAX_WIDTH || 1600),
      maxHeight: Number(process.env.AD_IMAGE_MAX_HEIGHT || 900),
      quality: Number(process.env.AD_IMAGE_QUALITY || 84),
    });

    const key = `advertisements/banner/${req.user.id}/${crypto.randomUUID()}.webp`;
    await uploadPrivateObject({ key, buffer: optimized.buffer, contentType: optimized.contentType });

    await recordAuditEvent(prisma, {
      actorId: req.user.id,
      action: 'AD_CREATIVE_UPLOADED',
      resourceType: 'AdvertisementCreative',
      resourceId: key,
      metadata: { width: optimized.width, height: optimized.height, bytes: optimized.optimizedBytes },
    });

    const previewUrl = await signedMediaUrl({ key, disposition: 'inline' });
    return res.status(201).json({ key, previewUrl, width: optimized.width, height: optimized.height });
  } catch (error) {
    req.log?.error({ err: error }, 'AD CREATIVE UPLOAD ERROR');
    return res.status(400).json({ error: error.message || 'Could not upload banner image' });
  }
});

router.post(
  '/',
  authenticate,
  [
    body('type').isIn(AD_TYPES),
    body('listingId').optional({ values: 'falsy' }).isUUID(),
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('headline').optional({ values: 'falsy' }).isString().trim().isLength({ max: MAX_HEADLINE }),
    body('linkUrl').optional({ values: 'falsy' }).isString().trim().isLength({ max: MAX_URL }),
    body('creativeImageKey').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }),
    body('bannerTemplate').optional({ values: 'falsy' }).isIn(BANNER_TEMPLATES),
  ],
  validate,
  async (req, res) => {
    try {
      const { type, listingId } = req.body;
      const startDate = new Date(req.body.startDate);
      const endDate = new Date(req.body.endDate);
      const now = new Date();
      const maxDays = Number(process.env.AD_MAX_CAMPAIGN_DAYS || 90);

      if (endDate <= startDate) return res.status(400).json({ error: 'endDate must be after startDate' });
      if (startDate < new Date(now.getTime() - 60000)) return res.status(400).json({ error: 'Start date cannot be in the past' });

      const days = campaignDays(startDate, endDate);
      if (days > maxDays) return res.status(400).json({ error: `Campaign duration exceeds maximum limit of ${maxDays} days` });

      const needsListing = ['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH'].includes(type);
      if (needsListing && !listingId) return res.status(400).json({ error: `${type} requires a valid listingId` });
      if (!needsListing && listingId) return res.status(400).json({ error: `${type} does not accept a listingId` });

      if (listingId) {
        const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, status: true } });
        if (!listing) return res.status(404).json({ error: 'Target listing not found' });
        if (listing.sellerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden: You do not own this listing' });
        if (listing.status !== 'ACTIVE') return res.status(400).json({ error: 'Only active listings can be promoted' });
      }

      const headline = safeText(req.body.headline);
      const linkUrl = safeDestinationUrl(req.body.linkUrl);
      if (req.body.linkUrl && !linkUrl) return res.status(400).json({ error: 'Destination URL must be HTTPS or a valid relative route' });

      if ((type === 'BANNER' || type === 'TELEGRAM_PROMOTION') && !headline) {
        return res.status(400).json({ error: 'Headline is required for banner and social campaigns' });
      }
      if (type === 'BANNER' && !req.body.creativeImageKey) {
        return res.status(400).json({ error: 'Banner campaigns require a uploaded creativeImageKey' });
      }

      const priceQuoted = quotePrice(type, startDate, endDate);
      const campaignReference = `MB-AD-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

      const ad = await prisma.$transaction(async (tx) => {
        const created = await tx.advertisement.create({
          data: {
            advertiserId: req.user.id,
            type,
            listingId: listingId || null,
            startDate,
            endDate,
            status: 'PENDING_PAYMENT',
            priceQuoted,
            currency: 'ETB',
            campaignReference,
            headline,
            destinationUrl: linkUrl,
            creativeImageKey: type === 'BANNER' ? req.body.creativeImageKey : null,
            bannerTemplate: type === 'BANNER' ? (req.body.bannerTemplate || 'CLASSIC') : 'CLASSIC',
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'AD_CAMPAIGN_CREATED',
          resourceType: 'Advertisement',
          resourceId: created.id,
          metadata: { priceQuoted, campaignReference },
        });

        return created;
      });

      return res.status(201).json({ ad: { ...ad, amountDue: priceQuoted, days } });
    } catch (error) {
      req.log?.error({ err: error }, 'CREATE AD ERROR');
      return res.status(500).json({ error: 'Failed to create campaign' });
    }
  }
);

router.get('/active', async (req, res) => {
  try {
    const now = new Date();
    const ads = await prisma.advertisement.findMany({
      where: {
        status: { in: ['ACTIVE', 'PUBLISHED', 'SCHEDULED'] },
        startDate: { lte: now },
        endDate: { gte: now },
      },
      include: {
        listing: {
          select: { id: true, title: true, cropType: true, askingPrice: true, photos: true, status: true },
        },
      },
      orderBy: { startDate: 'asc' },
    });

    const enriched = await Promise.all(
      ads.map(async (ad) => attachCreativeUrl(withComputedStatus(ad)))
    );

    return res.json({ ads: enriched });
  } catch (error) {
    req.log?.error({ err: error }, 'ACTIVE ADS FETCH ERROR');
    return res.status(500).json({ error: 'Could not fetch active campaigns' });
  }
});

router.get('/mine', authenticate, async (req, res) => {
  try {
    const ads = await prisma.advertisement.findMany({
      where: { advertiserId: req.user.id },
      include: {
        listing: { select: { id: true, title: true, cropType: true, status: true } },
        payments: { select: { id: true, status: true, amount: true, method: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const enriched = await Promise.all(
      ads.map(async (ad) => {
        const withStatus = withComputedStatus(ad);
        const withMedia = await attachCreativeUrl(withStatus);
        const isPaid = ad.payments.some((p) => p.status === 'PAID');
        return {
          ...withMedia,
          paymentStatus: isPaid ? 'PAID' : ad.payments.length > 0 ? 'PENDING' : 'UNPAID',
        };
      })
    );

    return res.json({ ads: enriched });
  } catch (error) {
    req.log?.error({ err: error }, 'MY ADS FETCH ERROR');
    return res.status(500).json({ error: 'Could not fetch user campaigns' });
  }
});

router.post(
  '/:id/events',
  adEventLimiter,
  // Only IMPRESSION and CLICK exist on the AdvertisementEventType enum in
  // prisma/schema.prisma — CONVERSION is derived downstream from actual
  // orders (see GET /:id/analytics), not recorded as its own event.
  [param('id').isUUID(), body('eventType').isIn(['IMPRESSION', 'CLICK'])],
  validate,
  async (req, res) => {
    try {
      const now = new Date();
      const ad = await prisma.advertisement.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, startDate: true, endDate: true },
      });

      if (!ad || !['ACTIVE', 'PUBLISHED'].includes(ad.status) || ad.startDate > now || ad.endDate < now) {
        return res.status(404).json({ error: 'Active advertisement campaign not found' });
      }

      await prisma.advertisementEvent.create({
        data: {
          advertisementId: ad.id,
          eventType: req.body.eventType,
        },
      });

      return res.status(204).end();
    } catch (error) {
      req.log?.error({ err: error }, 'AD EVENT RECORDING ERROR');
      return res.status(500).json({ error: 'Failed to record ad event' });
    }
  }
);

router.get('/:id/analytics', authenticate, [param('id').isUUID()], validate, async (req, res) => {
  try {
    const ad = await prisma.advertisement.findUnique({
      where: { id: req.params.id },
      include: {
        events: { select: { eventType: true } },
        payments: { where: { status: 'PAID' }, select: { amount: true } },
        listing: {
          select: {
            orders: {
              where: { status: { in: ['PAID', 'DELIVERED', 'COMPLETED'] } },
              select: { totalPrice: true },
            },
          },
        },
      },
    });

    if (!ad) return res.status(404).json({ error: 'Advertisement campaign not found' });
    if (ad.advertiserId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });

    const impressions = ad.events.filter((e) => e.eventType === 'IMPRESSION').length;
    const clicks = ad.events.filter((e) => e.eventType === 'CLICK').length;
    const explicitConversions = ad.events.filter((e) => e.eventType === 'CONVERSION').length;

    const listingOrders = ad.listing?.orders || [];
    const conversions = explicitConversions || listingOrders.length;

    const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
    const cvr = clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0;

    const spend = Number(ad.priceQuoted || ad.payments.reduce((acc, p) => acc + Number(p.amount || 0), 0));
    const revenueGenerated = listingOrders.reduce((acc, order) => acc + Number(order.totalPrice || 0), 0);
    const roas = spend > 0 ? Number((revenueGenerated / spend).toFixed(2)) : 0;

    return res.json({
      campaignReference: ad.campaignReference,
      status: withComputedStatus(ad).status,
      impressions,
      clicks,
      conversions,
      ctr,
      cvr,
      roas,
      spend,
      revenueGenerated,
      publishedAt: ad.publishedAt,
      telegramPostReference: ad.telegramPostReference,
    });
  } catch (error) {
    req.log?.error({ err: error }, 'ANALYTICS ERROR');
    return res.status(500).json({ error: 'Could not fetch analytics' });
  }
});

module.exports = router;
