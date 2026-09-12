'use strict';

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isAdmin } = require('../utils/authorization');
const { recordAuditEvent } = require('../utils/audit');
const { uploadPrivateObject, signedMediaUrl, deletePrivateObject } = require('../utils/objectStorage');
const { AD_TYPES, dailyRatesEtb, campaignDays, quotePrice } = require('../utils/adPricing');

// Visual layout template applied when rendering a BANNER creative. Ignored
// entirely for every other campaign type.
const BANNER_TEMPLATES = ['CLASSIC', 'BOLD', 'MINIMAL', 'CARD'];

const router = express.Router();

const MAX_CREATIVE_BYTES = Number(process.env.AD_BANNER_MAX_FILE_BYTES || 5 * 1024 * 1024);
const MAX_HEADLINE = 140;
const MAX_URL = 2000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const adEventLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

const creativeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CREATIVE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error('Banner must be a JPEG, PNG, or WebP image'));
    }
    cb(null, true);
  },
});

function hasValidImageSignature(buffer, mime) {
  if (!buffer || !Buffer.isBuffer(buffer)) return false;
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
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
    if (url.protocol !== 'https:') throw new Error('Only HTTPS destination URLs are allowed');
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
    } catch (error) {
      console.error('AD CREATIVE SIGN ERROR:', error);
      result.creativeImageUrl = null;
    }
  } else {
    result.creativeImageUrl = null;
  }
  delete result.creativeImageKey;
  return result;
}

function activeStatusWhere(now) {
  return {
    status: { in: ['ACTIVE', 'PUBLISHED', 'SCHEDULED'] },
    startDate: { lte: now },
    endDate: { gte: now },
  };
}

function isReviewRequired(type) {
  return type === 'BANNER' || type === 'TELEGRAM_PROMOTION';
}

function statusAfterApproval(ad) {
  return new Date(ad.startDate) > new Date() ? 'SCHEDULED' : 'PUBLISHED';
}

function paymentStatus(ad) {
  const payments = ad.payments || [];
  return payments.some((p) => p.status === 'PAID') ? 'PAID' : payments.some((p) => p.status === 'PENDING') ? 'PENDING' : 'UNPAID';
}

// Pricing is deliberately server-owned. The frontend may display these values,
// but it can never choose the amount charged for a campaign.
router.get('/pricing', authenticate, (req, res) => {
  return res.json({ currency: 'ETB', dailyRatesEtb: dailyRatesEtb(), maxCampaignDays: Number(process.env.AD_MAX_CAMPAIGN_DAYS || 90), bannerTemplates: BANNER_TEMPLATES });
});

// Upload banner creative to private object storage. The database only stores
// the opaque key; public clients receive short-lived signed URLs.
function uploadCreative(req, res, next) {
  creativeUpload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message || 'Invalid banner image' });
    next();
  });
}

router.post('/creative', authenticate, requireRole('ADVERTISER', 'ADMIN'), uploadCreative, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Banner image file is required' });
    if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) return res.status(400).json({ error: 'Unsupported banner image type' });
    if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'Banner file contents do not match the declared image type' });

    const key = `advertisements/banner/${req.user.id}/${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
    await uploadPrivateObject({ key, buffer: req.file.buffer, contentType: req.file.mimetype });

    await recordAuditEvent(prisma, {
      actorId: req.user.id,
      action: 'AD_CREATIVE_UPLOADED',
      resourceType: 'AdvertisementCreative',
      resourceId: key,
      metadata: { contentType: req.file.mimetype, bytes: req.file.size },
    });

    const previewUrl = await signedMediaUrl({ key, disposition: 'inline' });
    return res.status(201).json({ key, previewUrl, contentType: req.file.mimetype, bytes: req.file.size });
  } catch (error) {
    console.error('AD CREATIVE UPLOAD ERROR:', error);
    return res.status(400).json({ error: error.message || 'Could not upload banner image' });
  }
});

router.post(
  '/',
  authenticate,
  requireRole('ADVERTISER', 'ADMIN'),
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
      if (startDate < new Date(now.getTime() - 60000)) return res.status(400).json({ error: 'Campaign start cannot be in the past' });
      const days = campaignDays(startDate, endDate);
      if (days > maxDays) return res.status(400).json({ error: `Campaign cannot exceed ${maxDays} days` });

      const needsListing = ['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH'].includes(type);
      if (needsListing && !listingId) return res.status(400).json({ error: `${type} requires listingId` });
      if (!needsListing && listingId) return res.status(400).json({ error: `${type} does not accept listingId` });

      let listing = null;
      if (listingId) {
        listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, status: true, category: true, title: true, cropType: true } });
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.sellerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'You may only advertise your own listing' });
        if (listing.status !== 'ACTIVE') return res.status(400).json({ error: 'Only an active listing can be promoted' });
      }

      const headline = safeText(req.body.headline);
      const linkUrl = safeDestinationUrl(req.body.linkUrl);
      if (req.body.linkUrl && !linkUrl) return res.status(400).json({ error: 'Destination link must be an HTTPS URL or a safe internal path' });

      if ((type === 'BANNER' || type === 'TELEGRAM_PROMOTION') && !headline) {
        return res.status(400).json({ error: `${type === 'BANNER' ? 'Banner' : 'Telegram promotion'} requires a headline/message` });
      }
      if (type === 'BANNER' && !req.body.creativeImageKey) return res.status(400).json({ error: 'Banner campaigns require an uploaded image' });

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
          metadata: { type, listingId: listingId || null, priceQuoted, currency: 'ETB', campaignReference },
        });
        return created;
      });

      return res.status(201).json({ ad: { ...ad, amountDue: priceQuoted, days, paymentStatus: 'UNPAID' } });
    } catch (error) {
      console.error('CREATE AD ERROR:', error);
      return res.status(500).json({ error: 'Could not create advertisement' });
    }
  }
);

router.get('/active', async (req, res) => {
  try {
    const now = new Date();
    const ads = await prisma.advertisement.findMany({
      where: { ...activeStatusWhere(now) },
      include: { listing: { select: { id: true, sellerId: true, category: true, title: true, cropType: true, quantity: true, unit: true, askingPrice: true, location: true, photos: true, videos: true, description: true, status: true } } },
      orderBy: { startDate: 'asc' },
    });
    const enriched = await Promise.all(ads.map(attachCreativeUrl));
    return res.json({ ads: enriched.map(withComputedStatus) });
  } catch (error) {
    console.error('ACTIVE ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load active advertisements' });
  }
});

router.get('/mine', authenticate, async (req, res) => {
  try {
    const ads = await prisma.advertisement.findMany({
      where: { advertiserId: req.user.id },
      include: {
        listing: { select: { id: true, title: true, cropType: true, category: true, status: true } },
        payments: { select: { id: true, status: true, amount: true, method: true, provider: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const enriched = await Promise.all(ads.map(attachCreativeUrl));
    return res.json({ ads: enriched.map((ad) => ({ ...withComputedStatus(ad), amountDue: Number(ad.priceQuoted || 0), paymentStatus: paymentStatus(ad) })) });
  } catch (error) {
    console.error('MY ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load your advertisements' });
  }
});

router.get('/', authenticate, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required' });
  try {
    const ads = await prisma.advertisement.findMany({
      include: {
        listing: { select: { id: true, title: true, cropType: true, category: true, status: true } },
        advertiser: { select: { id: true, name: true, email: true } },
        payments: { select: { id: true, status: true, amount: true, method: true, provider: true, createdAt: true } },
        events: { select: { eventType: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const enriched = await Promise.all(ads.map(attachCreativeUrl));
    return res.json({ ads: enriched.map((ad) => ({ ...withComputedStatus(ad), paymentStatus: paymentStatus(ad) })) });
  } catch (error) {
    console.error('LIST ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load advertisements' });
  }
});

router.post('/:id/events', adEventLimiter, [param('id').isUUID(), body('eventType').isIn(['IMPRESSION', 'CLICK'])], validate, async (req, res) => {
  try {
    const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, startDate: true, endDate: true } });
    const now = new Date();
    if (!ad || !['ACTIVE', 'PUBLISHED'].includes(ad.status) || ad.startDate > now || ad.endDate < now) return res.status(404).json({ error: 'Active campaign not found' });
    await prisma.advertisementEvent.create({ data: { advertisementId: ad.id, eventType: req.body.eventType } });
    return res.status(204).end();
  } catch (error) {
    console.error('AD EVENT ERROR:', error);
    return res.status(500).json({ error: 'Could not record campaign event' });
  }
});

router.get('/:id/analytics', authenticate, [param('id').isUUID()], validate, async (req, res) => {
  try {
    const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id }, include: { events: { select: { eventType: true } } } });
    if (!ad) return res.status(404).json({ error: 'Advertisement not found' });
    if (ad.advertiserId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
    const impressions = ad.events.filter((e) => e.eventType === 'IMPRESSION').length;
    const clicks = ad.events.filter((e) => e.eventType === 'CLICK').length;
    return res.json({ campaignReference: ad.campaignReference, impressions, clicks, ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0, publishedAt: ad.publishedAt, telegramPostReference: ad.telegramPostReference });
  } catch (error) {
    console.error('AD ANALYTICS ERROR:', error);
    return res.status(500).json({ error: 'Could not load campaign analytics' });
  }
});

router.patch(
  '/:id/status',
  authenticate,
  [param('id').isUUID(), body('status').isIn(['APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED', 'EXPIRED'])],
  validate,
  async (req, res) => {
    try {
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required' });
      const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id }, include: { payments: true } });
      if (!ad) return res.status(404).json({ error: 'Advertisement not found' });
      const paid = ad.payments.some((p) => p.status === 'PAID');
      if (['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(req.body.status) && !paid) return res.status(400).json({ error: 'Campaign must be paid before approval/publication' });
      if (req.body.status === 'PUBLISHED' && (ad.startDate > new Date() || ad.endDate < new Date())) return res.status(400).json({ error: 'Campaign dates do not allow publication' });
      if (req.body.status === 'APPROVED' && !isReviewRequired(ad.type)) return res.status(400).json({ error: 'This campaign type does not require manual approval' });

      const status = req.body.status === 'APPROVED' ? statusAfterApproval(ad) : req.body.status;
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.advertisement.update({ where: { id: ad.id }, data: { status, ...(status === 'PUBLISHED' ? { publishedAt: new Date() } : {}), ...(status === 'REJECTED' ? { rejectionReason: safeText(req.body.rejectionReason, 500) } : {}) } });
        await recordAuditEvent(tx, { actorId: req.user.id, action: `AD_STATUS_${status}`, resourceType: 'Advertisement', resourceId: ad.id, metadata: { from: ad.status, to: status, rejectionReason: result.rejectionReason || null } });
        return result;
      });
      return res.json({ ad: updated });
    } catch (error) {
      console.error('UPDATE AD STATUS ERROR:', error);
      return res.status(500).json({ error: 'Could not update advertisement status' });
    }
  }
);

// Cancel a campaign.
//   - Advertiser (owner): only while PENDING_PAYMENT — backing out before any
//     money has moved. Any lingering PENDING payment attempt is failed so it
//     can't be resumed against a cancelled campaign.
//   - Admin: any non-terminal status, including a paid-but-not-yet-live
//     campaign (PAID_PENDING_REVIEW/APPROVED/SCHEDULED) or a live one
//     (PUBLISHED/ACTIVE). Any PAID payment is flagged REFUNDED as a
//     bookkeeping record, same as order cancellation — there is no live
//     payment gateway refund call yet (see README).
router.patch('/:id/cancel', authenticate, [param('id').isUUID(), body('reason').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 })], validate, async (req, res) => {
  try {
    const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id }, include: { payments: true } });
    if (!ad) return res.status(404).json({ error: 'Advertisement not found' });

    const userIsAdmin = isAdmin(req.user);
    const isOwner = ad.advertiserId === req.user.id;
    if (!isOwner && !userIsAdmin) return res.status(403).json({ error: 'Not authorized to cancel this campaign' });

    const TERMINAL_STATUSES = ['REJECTED', 'EXPIRED', 'CANCELLED'];
    if (TERMINAL_STATUSES.includes(ad.status)) {
      return res.status(400).json({ error: `Campaign is already ${ad.status.toLowerCase()} and cannot be cancelled` });
    }
    if (!userIsAdmin && ad.status !== 'PENDING_PAYMENT') {
      return res.status(400).json({ error: 'You can only cancel a campaign before it has been paid for. Contact MarketBridge support about a paid campaign.' });
    }

    const reason = safeText(req.body.reason, 500);
    const fromStatus = ad.status;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.advertisement.update({
        where: { id: ad.id },
        data: { status: 'CANCELLED', rejectionReason: reason || ad.rejectionReason },
      });

      const pendingPayments = ad.payments.filter((p) => p.status === 'PENDING');
      const paidPayments = ad.payments.filter((p) => p.status === 'PAID');
      for (const payment of pendingPayments) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      }
      for (const payment of paidPayments) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'AD_CAMPAIGN_CANCELLED',
        resourceType: 'Advertisement',
        resourceId: ad.id,
        metadata: {
          fromStatus,
          reason,
          cancelledByRole: userIsAdmin && !isOwner ? 'ADMIN' : 'ADVERTISER',
          refundedPaymentIds: paidPayments.map((p) => p.id),
          failedPendingPaymentIds: pendingPayments.map((p) => p.id),
        },
      });

      return result;
    });

    return res.json({ ad: updated });
  } catch (error) {
    console.error('CANCEL AD ERROR:', error);
    return res.status(500).json({ error: 'Could not cancel advertisement' });
  }
});

router.patch('/:id/telegram-publication', authenticate, [param('id').isUUID(), body('postReference').optional().isString().trim().isLength({ max: 500 })], validate, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required' });
    const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id } });
    if (!ad) return res.status(404).json({ error: 'Advertisement not found' });
    if (ad.type !== 'TELEGRAM_PROMOTION') return res.status(400).json({ error: 'Only Telegram campaigns can be marked published here' });
    if (!['APPROVED', 'SCHEDULED'].includes(ad.status)) return res.status(400).json({ error: 'Telegram campaign must be approved before publication' });
    const paid = await prisma.payment.findFirst({ where: { advertisementId: ad.id, type: 'ADVERTISING', status: 'PAID' }, select: { id: true } });
    if (!paid) return res.status(400).json({ error: 'Telegram campaign must be paid before publication' });
    if (ad.startDate > new Date()) return res.status(400).json({ error: 'Campaign start date has not arrived' });
    if (ad.endDate < new Date()) return res.status(400).json({ error: 'Campaign has expired' });
    const updated = await prisma.advertisement.update({ where: { id: ad.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), telegramPostReference: safeText(req.body.postReference, 500) } });
    return res.json({ ad: updated });
  } catch (error) {
    console.error('TELEGRAM PUBLICATION ERROR:', error);
    return res.status(500).json({ error: 'Could not record Telegram publication' });
  }
});

module.exports = router;
