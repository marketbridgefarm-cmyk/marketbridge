const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isAdmin } = require('../utils/authorization');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  next();
};

/**
 * Nothing ever flips an ad's DB status to EXPIRED once its endDate passes
 * (there's no cron for it), so without this an ad would show as "Active"
 * forever in both dashboards even though the search-boost query already
 * excludes it once its endDate is past. Compute the display status instead
 * of trusting the stored one, rather than requiring a scheduled job just to
 * keep a label accurate.
 */
function withComputedStatus(ad) {
  if (ad.status === 'ACTIVE' && new Date(ad.endDate) < new Date()) {
    return { ...ad, status: 'EXPIRED' };
  }
  return ad;
}

router.post(
  '/',
  authenticate,
  requireRole('ADVERTISER'),
  [
    body('type').isIn(['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH', 'BANNER', 'TELEGRAM_PROMOTION']),
    body('listingId').optional({ values: 'falsy' }).isUUID(),
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('amountPaid').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const startDate = new Date(req.body.startDate);
      const endDate = new Date(req.body.endDate);

      if (endDate <= startDate) return res.status(400).json({ error: 'endDate must be after startDate' });

      if (req.body.listingId) {
        const listing = await prisma.listing.findUnique({
          where: { id: req.body.listingId },
          select: { sellerId: true },
        });

        if (!listing) return res.status(404).json({ error: 'Listing not found' });

        if (listing.sellerId !== req.user.id && !isAdmin(req.user)) {
          return res.status(403).json({ error: 'You may only advertise your own listing' });
        }
      }

      const ad = await prisma.advertisement.create({
        data: {
          advertiserId: req.user.id,
          type: req.body.type,
          listingId: req.body.listingId || null,
          startDate,
          endDate,
          amountPaid: req.body.amountPaid == null ? null : Number(req.body.amountPaid),
          status: 'PENDING',
        },
      });

      return res.status(201).json({ ad });
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
      where: {
        status: 'ACTIVE',
        startDate: { lte: now },
        endDate: { gte: now },
      },
      include: { listing: true },
      orderBy: { startDate: 'asc' },
    });

    return res.json({ ads });
  } catch (error) {
    console.error('ACTIVE ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load active advertisements' });
  }
});

router.get('/mine', authenticate, requireRole('ADVERTISER'), async (req, res) => {
  try {
    const ads = await prisma.advertisement.findMany({
      where: { advertiserId: req.user.id },
      include: {
        listing: { select: { id: true, title: true, cropType: true } },
        payments: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ ads: ads.map(withComputedStatus) });
  } catch (error) {
    console.error('MY ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load your advertisements' });
  }
});

router.get('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const ads = await prisma.advertisement.findMany({
      include: {
        listing: { select: { id: true, title: true, cropType: true } },
        advertiser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ ads: ads.map(withComputedStatus) });
  } catch (error) {
    console.error('LIST ADS ERROR:', error);
    return res.status(500).json({ error: 'Could not load advertisements' });
  }
});

router.patch(
  '/:id/status',
  authenticate,
  requireRole('ADMIN'),
  [param('id').isUUID(), body('status').isIn(['ACTIVE', 'REJECTED', 'EXPIRED'])],
  validate,
  async (req, res) => {
    try {
      const ad = await prisma.advertisement.findUnique({ where: { id: req.params.id } });
      if (!ad) return res.status(404).json({ error: 'Advertisement not found' });

      if (req.body.status === 'ACTIVE' && ad.endDate <= new Date()) {
        return res.status(400).json({ error: 'Cannot activate an expired advertisement' });
      }

      const updated = await prisma.advertisement.update({
        where: { id: ad.id },
        data: { status: req.body.status },
      });

      return res.json({ ad: updated });
    } catch (error) {
      console.error('UPDATE AD STATUS ERROR:', error);
      return res.status(500).json({ error: 'Could not update advertisement status' });
    }
  }
);

module.exports = router;
