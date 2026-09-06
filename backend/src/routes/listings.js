const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

// Public browse/search with filtering and pagination
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

    const skip = (Number(page) - 1) * Number(limit);
    const take = Math.min(Number(limit), 50);

    const where = {
      ...(cropType && { cropType: { contains: cropType, mode: 'insensitive' } }),
      ...(title && { title: { contains: title, mode: 'insensitive' } }),
      ...(location && { location: { contains: location, mode: 'insensitive' } }),
      ...(category && { category }),
      ...(sellerId && { sellerId }),
      ...(minQuantity && { quantity: { gte: Number(minQuantity) } }),
      ...(maxQuantity && { quantity: { lte: Number(maxQuantity) } }),
      ...(minPrice && { askingPrice: { gte: Number(minPrice) } }),
      ...(maxPrice && { askingPrice: { lte: Number(maxPrice) } }),
      status: status || 'ACTIVE',
    };

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: {
          seller: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.listing.count({ where }),
    ]);

    return res.json({
      listings,
      total,
      page: Number(page),
      limit: take,
      totalPages: Math.ceil(total / take),
    });
  } catch (error) {
    console.error('LIST LISTINGS ERROR:', error);
    return res.status(500).json({ error: 'Could not load listings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id },
      include: {
        seller: { select: { id: true, name: true, rating: true, location: true, verificationStatus: true } },
        offers: true,
        inspectionRequests: {
          include: {
            report: true,
            inspector: { select: { id: true, name: true, rating: true } },
            payments: { select: { id: true, status: true } },
          },
        },
      },
    });

    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    return res.json({ listing });
  } catch (error) {
    console.error('GET LISTING ERROR:', error);
    return res.status(500).json({ error: 'Could not load listing' });
  }
});

// Seller (or an inspector helping a farmer) creates a listing.
router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'INSPECTOR'),
  [
    body('sellerId').notEmpty(),
    body('category').optional().isIn(['AGRICULTURAL', 'PRODUCT']),
    body('title').optional().isString().trim(),
    body('cropType').optional().isString().trim(),
    body('quantity').isFloat({ gt: 0 }),
    body('unit').notEmpty(),
    body('askingPrice').isFloat({ gt: 0 }),
    body('location').notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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

      // Inspector cannot list as themselves
      if (req.user.roles.includes('INSPECTOR') && !req.user.roles.includes('SELLER')) {
        if (sellerId === req.user.id) {
          return res.status(403).json({ error: 'Inspectors cannot list produce as themselves; sellerId must be the farmer.' });
        }
      }

      // Non-inspectors can only list under their own account
      if (!req.user.roles.includes('INSPECTOR') && sellerId !== req.user.id) {
        return res.status(403).json({ error: 'You can only create listings under your own account' });
      }

      if (category === 'AGRICULTURAL' && !cropType) {
        return res.status(400).json({ error: 'cropType is required for agricultural listings' });
      }

      if (category === 'PRODUCT' && !title && !cropType) {
        return res.status(400).json({ error: 'title is required for product listings' });
      }

      const seller = await prisma.user.findUnique({ where: { id: sellerId } });
      if (!seller) return res.status(404).json({ error: 'Seller account not found' });
      if (!seller.roles.includes('SELLER')) return res.status(400).json({ error: 'The selected account is not enabled for selling' });

      const listing = await prisma.listing.create({
        data: {
          sellerId,
          category,
          title: title || cropType,
          cropType: cropType || title,
          description,
          quantity,
          unit,
          askingPrice,
          minAcceptablePrice,
          location,
          harvestedDate: harvestedDate ? new Date(harvestedDate) : null,
          readinessDate: readinessDate ? new Date(readinessDate) : null,
          photos: photos || [],
          videos: videos || [],
          status: 'ACTIVE',
          createdByInspectorId: req.user.roles.includes('INSPECTOR') ? req.user.id : null,
        },
      });

      return res.status(201).json({ listing });
    } catch (error) {
      console.error('CREATE LISTING ERROR:', error);
      return res.status(500).json({ error: 'Could not create listing' });
    }
  }
);

// Only the farmer/seller who owns the listing may change price or status
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    if (listing.sellerId !== req.user.id && !req.user.roles.includes('ADMIN')) {
      return res.status(403).json({ error: 'Only the farmer/seller retains price and listing authority' });
    }

    const { askingPrice, minAcceptablePrice, quantity, status, readinessDate, description } = req.body;

    const updated = await prisma.listing.update({
      where: { id: req.params.id },
      data: {
        ...(askingPrice !== undefined && { askingPrice }),
        ...(minAcceptablePrice !== undefined && { minAcceptablePrice }),
        ...(quantity !== undefined && { quantity }),
        ...(status !== undefined && { status }),
        ...(readinessDate !== undefined && { readinessDate: new Date(readinessDate) }),
        ...(description !== undefined && { description }),
      },
    });

    return res.json({ listing: updated });
  } catch (error) {
    console.error('UPDATE LISTING ERROR:', error);
    return res.status(500).json({ error: 'Could not update listing' });
  }
});

// Price empowerment insights
router.get('/:id/price-insights', authenticate, async (req, res) => {
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id },
      include: { offers: { where: { status: { in: ['PENDING', 'COUNTERED'] } } } },
    });

    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const recentSimilar = await prisma.listing.findMany({
      where: { cropType: listing.cropType, status: 'SOLD' },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { askingPrice: true, updatedAt: true },
    });

    const bestOffer = listing.offers.reduce((max, o) => (o.amount > (max?.amount || 0) ? o : max), null);

    const estimatedTransportCost = req.query.estTransportCost ? Number(req.query.estTransportCost) : 0;
    const estimatedInspectionCost = req.query.estInspectionCost ? Number(req.query.estInspectionCost) : 0;
    const platformFeeRate = 0.03;
    const grossOffer = bestOffer?.amount || listing.askingPrice;
    const platformFee = grossOffer * platformFeeRate;
    const estimatedNetRevenue = grossOffer - estimatedTransportCost - estimatedInspectionCost - platformFee;

    return res.json({
      recentMarketPrices: recentSimilar,
      demand: { competingOffers: listing.offers.length },
      bestOffer,
      estimatedNetRevenue,
      breakdown: { grossOffer, estimatedTransportCost, estimatedInspectionCost, platformFee },
    });
  } catch (error) {
    console.error('PRICE INSIGHTS ERROR:', error);
    return res.status(500).json({ error: 'Could not load price insights' });
  }
});

module.exports = router;
