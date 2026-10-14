const { body, validationResult } = require('express-validator');
const prisma = require('../../config/db');
const { getMarketPriceReference, marketSnapshotData } = require('../../services/marketPriceService');
const { offerExpiry, validateNegotiationWindow } = require('../../services/offers/offerHelpers');
const { recordAuditEvent } = require('../../utils/audit');
const { AMOUNT_LIMITS, validAmount } = require('../../utils/contactGuard');

// POST /api/offers
const validators = [
  body('listingId')
    .notEmpty()
    .withMessage('listingId is required'),

  body('amount').custom(validAmount(AMOUNT_LIMITS.offer)),

  body('message').optional({ nullable: true }).custom((value) => value == null || value === '').withMessage('Free-text messages are not supported. Use the structured fields provided.'),
];

async function createOffer(req, res) {
  try {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: errors.array()[0]?.msg || 'Validation failed',
        errors: errors.array(),
      });
    }

    const listingId = req.body.listingId;
    const amount = Number(req.body.amount);
    const requestedQuantity = req.body.quantity === undefined || req.body.quantity === null || req.body.quantity === ''
      ? null
      : Number(req.body.quantity);
    const message = req.body.message || null;

    if (requestedQuantity !== null && (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0)) {
      return res.status(400).json({ error: 'quantity must be greater than zero' });
    }

    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
      },
    });

    if (!listing) {
      return res.status(404).json({
        error: 'Listing not found',
      });
    }

    if (!['AGRICULTURAL', 'PRODUCT'].includes(listing.category)) {
      return res.status(400).json({
        error:
          'Offers are available for Agricultural and Products Marketplace listings only',
      });
    }

    const availableQuantity = Number(listing.availableQuantity);
    const offerQuantity = requestedQuantity === null
      ? availableQuantity
      : requestedQuantity;

    if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
      return res.status(409).json({
        error: 'No listing quantity remains available for negotiation',
        availableQuantity,
      });
    }

    if (offerQuantity > availableQuantity + 1e-9) {
      return res.status(409).json({
        error: 'Requested quantity exceeds the currently available quantity',
        availableQuantity,
      });
    }

    if (
      !['ACTIVE', 'UNDER_NEGOTIATION'].includes(
        listing.status
      )
    ) {
      return res.status(400).json({
        error: 'Listing is not open for offers',
      });
    }

    if (listing.sellerId === req.user.id) {
      return res.status(403).json({
        error:
          'You cannot make an offer on your own listing',
      });
    }

    const negotiationWindowError = validateNegotiationWindow(listing);
    if (negotiationWindowError) {
      return res.status(409).json({ error: negotiationWindowError });
    }

    const negotiationExpiresAt = offerExpiry(listing);
    if (negotiationExpiresAt && negotiationExpiresAt.getTime() <= Date.now()) {
      return res.status(409).json({ error: 'The agricultural pickup window is too close or has expired.' });
    }

    // Market price is a reference snapshot for this negotiation only. It never
    // changes the buyer's submitted amount or the seller's asking price.
    const marketReference = await getMarketPriceReference(prisma, listing, { quantity: offerQuantity });
    const marketSnapshot = marketSnapshotData(marketReference, offerQuantity);

    const existingOffer =
      await prisma.offer.findFirst({
        where: {
          listingId,
          buyerId: req.user.id,
          status: {
            in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL', 'ACCEPTED'],
          },
          childOffers: { none: {} },
        },
      });

    if (existingOffer) {
      return res.status(409).json({
        error:
          'You already have an active negotiation on this listing',
        offer: existingOffer,
      });
    }

    const offer = await prisma.$transaction(
      async (tx) => {
        const createdOffer =
          await tx.offer.create({
            data: {
              listingId,
              buyerId: req.user.id,
              sellerId: listing.sellerId,
              amount,
              quantity: offerQuantity,
              expiresAt: negotiationExpiresAt,
              ...marketSnapshot,
              message,
              status: 'PENDING',
              counterAmount: null,
              counteredBy: null,
            },
          });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'OFFER_CREATED',
          resourceType: 'Offer',
          resourceId: createdOffer.id,
          metadata: {
            listingId,
            amount,
            status: createdOffer.status,
          },
        });

        return createdOffer;
      },
      { maxWait: 10000, timeout: 15000 }
    );

    return res.status(201).json({
      message: 'Offer submitted successfully',
      offer,
    });
  } catch (error) {
    req.log.error({ err: error }, 'CREATE OFFER ERROR:');

    if (error?.code === 'P2002') {
      req.log.error(
        {
          err: error,
          target: error.meta?.target,
        },
        'OFFER UNIQUE CONSTRAINT ERROR'
      );

      return res.status(409).json({
        error:
          'This negotiation could not be completed because the record was changed by another request. Please refresh and try again.',
        code: 'NEGOTIATION_CONFLICT',
      });
    }

    return res.status(500).json({
      error: 'Could not create offer',
      details:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
}

module.exports = { validators, createOffer };
