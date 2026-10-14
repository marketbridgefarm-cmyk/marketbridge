const prisma = require('../../config/db');

// GET /api/offers/mine
async function myOffers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [offers, total] = await Promise.all([
      prisma.offer.findMany({
        where: { buyerId: req.user.id },
        select: {
          id: true,
          listingId: true,
          buyerId: true,
          sellerId: true,
          amount: true,
          quantity: true,
          status: true,
          counterAmount: true,
          counteredBy: true,
          message: true,
          expiresAt: true,
          marketReferenceUnitPrice: true,
          marketReferenceTotalPrice: true,
          marketReferenceSource: true,
          marketReferenceDate: true,
          marketReferenceLocation: true,
          marketReferenceUnit: true,
          marketSampleSize: true,
          marketMinUnitPrice: true,
          marketMaxUnitPrice: true,
          parentOfferId: true,
          createdAt: true,
          updatedAt: true,
          agreedOrder: { select: { id: true, status: true } },
          listing: {
            select: {
              id: true,
              title: true,
              cropType: true,
              category: true,
              photos: true,
              askingPrice: true,
              location: true,
              status: true,
            },
          },
          _count: { select: { childOffers: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.offer.count({ where: { buyerId: req.user.id } }),
    ]);

    return res.json({
      offers,
      count: offers.length,
      total,
      page,
      limit,
    });
  } catch (error) {
    req.log.error({ err: error }, 'MY OFFERS ERROR:');

    return res.status(500).json({
      error: 'Could not load your offers',
    });
  }
}

module.exports = { myOffers };
