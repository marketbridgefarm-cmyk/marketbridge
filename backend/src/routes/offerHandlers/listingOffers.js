const prisma = require('../../config/db');
const { isAdmin, releaseAvailableAt, provisionalReleaseAvailableAt } = require('../../services/offers/offerHelpers');

// GET /api/offers/listing/:listingId
async function listingOffers(req, res) {
  try {
    const listing =
      await prisma.listing.findUnique({
        where: {
          id: req.params.listingId,
        },
      });

    if (!listing) {
      return res.status(404).json({
        error: 'Listing not found',
      });
    }

    const isSeller =
      listing.sellerId === req.user.id;

    const admin = isAdmin(req);

    const annotate = (o, supersededIds) => ({
      ...o,
      releaseAvailableAt: supersededIds.has(o.id) ? null : releaseAvailableAt(o),
      provisionalReleaseAvailableAt: o.status === 'PROVISIONAL' ? provisionalReleaseAvailableAt(o) : null,
    });

    if (admin || isSeller) {
      const offers =
        await prisma.offer.findMany({
          where: {
            listingId:
              req.params.listingId,
          },

          include: {
            buyer: {
              select: {
                id: true,
                name: true,
                phone: true,
                rating: true,
                verificationStatus: true,
              },
            },
          },

          orderBy: {
            createdAt: 'desc',
          },
        });

      const supersededIds = new Set(offers.map((o) => o.parentOfferId).filter(Boolean));
      return res.json({
        offers: offers.map((o) => annotate(o, supersededIds)),
        count: offers.length,
      });
    }

    const offers =
      await prisma.offer.findMany({
        where: {
          listingId:
            req.params.listingId,

          buyerId:
            req.user.id,
        },

        include: {
          buyer: {
            select: {
              id: true,
              name: true,
              rating: true,
              verificationStatus: true,
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    const supersededIds = new Set(offers.map((o) => o.parentOfferId).filter(Boolean));
    return res.json({
      offers: offers.map((o) => annotate(o, supersededIds)),
      count: offers.length,
    });
  } catch (error) {
    req.log.error({ err: error }, 'GET LISTING OFFERS ERROR:');

    return res.status(500).json({
      error:
        'Could not load listing offers',
    });
  }
}

module.exports = { listingOffers };
