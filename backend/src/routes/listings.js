const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

// Public browse/search
router.get('/', async (req, res) => {
  const { cropType, title, location, status, minQuantity, category } = req.query;
  const listings = await prisma.listing.findMany({
    where: {
      ...(cropType && { cropType: { contains: cropType, mode: 'insensitive' } }),
      ...(title && { title: { contains: title, mode: 'insensitive' } }),
      ...(location && { location: { contains: location, mode: 'insensitive' } }),
      ...(category && { category }),
      status: status || 'ACTIVE',
      ...(minQuantity && { quantity: { gte: Number(minQuantity) } }),
    },
    include: { seller: { select: { id: true, name: true, rating: true, location: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ listings });
});

router.get('/:id', async (req, res) => {
  const listing = await prisma.listing.findUnique({
    where: { id: req.params.id },
    include: {
      seller: { select: { id: true, name: true, rating: true, location: true } },
      offers: true,
      inspectionRequests: { include: { report: true, inspector: { select: { id: true, name: true, rating: true } } } },
    },
  });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  res.json({ listing });
});

// Seller (or an inspector helping a farmer) creates a listing.
// Farmer price authority: even if an inspector creates the listing on the
// farmer's behalf, sellerId is always the farmer, never the inspector.
router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'INSPECTOR'),
  [
    body('sellerId').notEmpty(),
    body('category').optional().isIn(['AGRICULTURAL','PRODUCT']),
    body('title').optional().isString().trim(),
    body('cropType').optional().isString().trim(),
    body('quantity').isFloat({ gt: 0 }),
    body('unit').notEmpty(),
    body('askingPrice').isFloat({ gt: 0 }),
    body('location').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      sellerId, category = 'AGRICULTURAL', title, cropType, quantity, unit, askingPrice, minAcceptablePrice,
      location, harvestedDate, readinessDate, photos, videos,
    } = req.body;

    // If an inspector is creating this, sellerId must be a real farmer and
    // must NOT be the inspector's own id — preserves farmer price authority.
    if (req.user.roles.includes('INSPECTOR') && !req.user.roles.includes('SELLER')) {
      if (sellerId === req.user.id) {
        return res.status(403).json({ error: 'Inspectors cannot list produce as themselves; sellerId must be the farmer.' });
      }
    }

    // A caller who is NOT acting as an inspector (i.e. has no INSPECTOR role)
    // may only create a listing under their own account — otherwise any
    // seller could impersonate another farmer by passing their user id.
    if (!req.user.roles.includes('INSPECTOR') && sellerId !== req.user.id) {
      return res.status(403).json({ error: 'You can only create listings under your own account' });
    }

    if (category === 'AGRICULTURAL' && !cropType) return res.status(400).json({ error: 'cropType is required for agricultural listings' });
    if (category === 'PRODUCT' && !title && !cropType) return res.status(400).json({ error: 'title is required for product listings' });
    const seller = await prisma.user.findUnique({ where: { id: sellerId } });
    if (!seller) return res.status(404).json({ error: 'Seller account not found' });
    if (!seller.roles.includes('SELLER')) return res.status(400).json({ error: 'The selected account is not enabled for selling' });

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        category,
        title: title || cropType,
        cropType: cropType || title,
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

    res.status(201).json({ listing });
  }
);

// Only the farmer/seller who owns the listing may change price or status —
// never the inspector, even if the inspector originally created it.
router.patch('/:id', authenticate, async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  if (listing.sellerId !== req.user.id && !req.user.roles.includes('ADMIN')) {
    return res.status(403).json({ error: 'Only the farmer/seller retains price and listing authority' });
  }

  const { askingPrice, minAcceptablePrice, quantity, status, readinessDate } = req.body;
  const updated = await prisma.listing.update({
    where: { id: req.params.id },
    data: {
      ...(askingPrice !== undefined && { askingPrice }),
      ...(minAcceptablePrice !== undefined && { minAcceptablePrice }),
      ...(quantity !== undefined && { quantity }),
      ...(status !== undefined && { status }),
      ...(readinessDate !== undefined && { readinessDate: new Date(readinessDate) }),
    },
  });
  res.json({ listing: updated });
});

// Price empowerment: recent prices, offers, estimated net revenue
router.get('/:id/price-insights', authenticate, async (req, res) => {
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

  // Estimated net = Buyer offer − Transport cost − Inspection cost − Platform fees
  // Transport/inspection costs are estimates the client should refine with real quotes.
  const estimatedTransportCost = req.query.estTransportCost ? Number(req.query.estTransportCost) : 0;
  const estimatedInspectionCost = req.query.estInspectionCost ? Number(req.query.estInspectionCost) : 0;
  const platformFeeRate = 0.03; // 3% example platform commission
  const grossOffer = bestOffer?.amount || listing.askingPrice;
  const platformFee = grossOffer * platformFeeRate;
  const estimatedNetRevenue = grossOffer - estimatedTransportCost - estimatedInspectionCost - platformFee;

  res.json({
    recentMarketPrices: recentSimilar,
    demand: { competingOffers: listing.offers.length },
    bestOffer,
    estimatedNetRevenue,
    breakdown: { grossOffer, estimatedTransportCost, estimatedInspectionCost, platformFee },
  });
});

module.exports = router;
