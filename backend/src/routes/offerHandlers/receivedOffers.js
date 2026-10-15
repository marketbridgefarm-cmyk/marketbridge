const prisma = require('../../config/db');

// GET /api/offers/received
// Offers made on the caller's own listings (the seller-side counterpart of
// GET /api/offers/mine). Used by the seller dashboard. Buyer contact details
// (phone) are deliberately not included here.
async function receivedOffers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const where = { sellerId: req.user.id };

    const [offers, total] = await Promise.all([
      prisma.offer.findMany({
        where,
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
          parentOfferId: true,
          createdAt: true,
          updatedAt: true,
          agreedOrder: { select: { id: true, status: true } },
          buyer: {
            select: { id: true, name: true, rating: true, verificationStatus: true },
          },
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
      prisma.offer.count({ where }),
    ]);

    return res.json({ offers, count: offers.length, total, page, limit });
  } catch (error) {
    req.log.error({ err: error }, 'RECEIVED OFFERS ERROR:');

    return res.status(500).json({
      error: 'Could not load received offers',
    });
  }
}

module.exports = { receivedOffers };
