const express = require('express');
const {
  body,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { idempotency } = require('../middleware/idempotency');
const { computePaymentDueAt } = require('../utils/orderTiming');
const {
  AMOUNT_LIMITS,
  amountProblem,
  validAmount,
  noContactInfo,
} = require('../utils/contactGuard');

const router = express.Router();

// ============================================================================
// HELPERS
// ============================================================================

function isAdmin(req) {
  return (
    Array.isArray(req.user.roles) &&
    req.user.roles.includes('ADMIN')
  );
}

function isPositiveNumber(value) {
  const number = Number(value);

  return (
    value !== undefined &&
    value !== null &&
    Number.isFinite(number) &&
    number > 0
  );
}

function offerError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function offerExpiry(hours = 24, listing = null) {
  const standardExpiry = Date.now() + hours * 60 * 60 * 1000;

  // Perishable agricultural listings should not keep a negotiation alive
  // beyond the advertised pickup window.
  if (listing?.category === 'AGRICULTURAL' && listing.pickupWindowEnd) {
    const pickupDeadline = new Date(listing.pickupWindowEnd).getTime();
    if (Number.isFinite(pickupDeadline)) {
      return new Date(Math.min(standardExpiry, pickupDeadline));
    }
  }

  return new Date(standardExpiry);
}

function validateNegotiationWindow(listing) {
  if (listing?.category !== 'AGRICULTURAL' || !listing.pickupWindowEnd) return null;

  const deadline = new Date(listing.pickupWindowEnd).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    return 'The agricultural pickup window has expired; negotiation cannot continue until the listing is updated.';
  }

  return null;
}

function isOfferExpired(offer) {
  return Boolean(
    offer.expiresAt &&
    new Date(offer.expiresAt).getTime() <= Date.now()
  );
}

async function expireOfferIfNeeded(tx, offer, actorId = null) {
  if (!offer || !isOfferExpired(offer)) return false;
  if (!['PENDING', 'COUNTERED'].includes(offer.status)) return false;

  const updated = await tx.offer.update({
    where: { id: offer.id },
    data: { status: 'EXPIRED' },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_EXPIRED',
    resourceType: 'Offer',
    resourceId: updated.id,
    metadata: {
      listingId: updated.listingId,
      previousStatus: offer.status,
      expiresAt: offer.expiresAt,
    },
  });

  return true;
}

// ============================================================================
// BUYER MAKES AN OFFER
// POST /api/offers
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('BUYER'),
  idempotency('offers.create'),
  [
    body('listingId')
      .notEmpty()
      .withMessage('listingId is required'),

    body('amount').custom(validAmount(AMOUNT_LIMITS.offer)),

    body('message')
      .optional()
      .isString()
      .trim()
      .custom(noContactInfo),
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

      const negotiationExpiresAt = offerExpiry(24, listing);
      if (negotiationExpiresAt.getTime() <= Date.now()) {
        return res.status(409).json({ error: 'The agricultural pickup window is too close or has expired.' });
      }

      const existingOffer =
        await prisma.offer.findFirst({
          where: {
            listingId,
            buyerId: req.user.id,
            status: {
              in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'],
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

      return res.status(500).json({
        error: 'Could not create offer',
        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      });
    }
  }
);

// ============================================================================
// BUYER — MY OFFERS
// GET /api/offers/mine
// ----------------------------------------------------------------------------
// Lightweight list for the Dashboard "My buying activity" panel. Only the
// fields a buyer needs to render an offer card are selected; the full
// listing graph (photos, videos, coordinates, etc.) is NOT fetched here.
// ============================================================================

router.get(
  '/mine',
  authenticate,
  async (req, res) => {
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
                photos: true, // String[] — cannot be paginated via take.
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
);

// ============================================================================
// GET OFFERS FOR A LISTING
// GET /api/offers/listing/:listingId
// ============================================================================

router.get(
  '/listing/:listingId',
  authenticate,
  async (req, res) => {
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

        return res.json({
          offers,
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

      return res.json({
        offers,
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
);

// ============================================================================
// ACCEPT OFFER AND CREATE ORDER
// ============================================================================

async function acceptOfferAndCreateOrder(
  tx,
  offer,
  finalPrice,
  sellerId,
  actorId = sellerId
) {
  if (!['AGRICULTURAL', 'PRODUCT'].includes(offer.listing.category)) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }

  // Re-check expiry at the mutation point. The request-level check can race
  // with the transaction: an offer may expire after the HTTP handler first
  // reads it but before the order is created.
  if (isOfferExpired(offer)) {
    throw offerError('Offer has expired and can no longer be accepted', 409);
  }

  const requestedQuantity = Number(offer.quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw offerError('Offer has no valid quantity', 400);
  }

  // Claim the offer itself before allocating inventory.
  const offerClaim = await tx.offer.updateMany({
    where: {
      id: offer.id,
      status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] },
    },
    data: { status: 'ACCEPTED' },
  });

  if (offerClaim.count !== 1) {
    throw offerError('This offer has already been acted on', 409);
  }

  const updatedOffer = await tx.offer.findUnique({
    where: { id: offer.id },
  });

  // There can be only one live provisional buyer/order for a listing at a
  // time.
  const existingProvisionalOrder = await tx.order.findFirst({
    where: {
      listingId: offer.listingId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    select: { id: true, buyerId: true, status: true },
  });

  if (existingProvisionalOrder) {
    throw offerError(
      'This listing already has a provisional buyer agreement. Cancel or release that order before accepting another buyer.',
      409
    );
  }

  const order =
    await tx.order.create({
      data: {
        listingId: offer.listingId,
        buyerId: offer.buyerId,
        sellerId,
        finalPrice,
        quantity: requestedQuantity,
        status: 'PENDING_PAYMENT',
        agreedOfferId: updatedOffer.id,
        agreedAt: new Date(),
        paymentDueAt: offer.listing.category === 'AGRICULTURAL' ? null : computePaymentDueAt(),
      },
    });

  await recordOrderEvent(tx, {
    orderId: order.id,
    actorId,
    type: 'ORDER_CREATED',
    toStatus: order.status,
    metadata: {
      listingId: offer.listingId,
      offerId: updatedOffer.id,
      via: 'offer-acceptance',
    },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_ACCEPTED',
    resourceType: 'Offer',
    resourceId: updatedOffer.id,
    metadata: {
      listingId: offer.listingId,
      buyerId: offer.buyerId,
      sellerId,
      finalPrice,
      orderId: order.id,
    },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'ORDER_CREATED_FROM_OFFER',
    resourceType: 'Order',
    resourceId: order.id,
    metadata: {
      listingId: offer.listingId,
      offerId: updatedOffer.id,
      buyerId: offer.buyerId,
      sellerId,
      finalPrice,
      status: order.status,
    },
  });

  return {
    offer: updatedOffer,
    order,
  };
}

// ============================================================================
// OFFER RESPONSE
// PATCH /api/offers/:id
// ============================================================================

router.patch(
  '/:id',
  authenticate,
  idempotency('offers.action'),
  async (req, res) => {
    try {
      const {
        action,
        counterAmount,
      } = req.body;

      const allowedActions = [
        'ACCEPT',
        'REJECT',
        'COUNTER',
        'ACCEPT_COUNTER',
        'ACCEPT_SELECTED',
        'RE_COUNTER',
        'SELECT',
      ];

      if (
        !allowedActions.includes(action)
      ) {
        return res.status(400).json({
          error:
            `Invalid action. Use ${allowedActions.join(', ')}.`,
        });
      }

      const offer =
        await prisma.offer.findUnique({
          where: {
            id: req.params.id,
          },

          include: {
            listing: true,
          },
        });

      if (!offer) {
        return res.status(404).json({
          error: 'Offer not found',
        });
      }

      const sellerId =
        offer.listing.sellerId;

      const isSeller =
        sellerId === req.user.id;

      const isBuyer =
        offer.buyerId === req.user.id;

      const admin = isAdmin(req);

      if (!isSeller && !isBuyer && !admin) {
        return res.status(403).json({
          error:
            'You are not a participant in this offer',
        });
      }

      if (isOfferExpired(offer)) {
        await prisma.$transaction(async (tx) => {
          await expireOfferIfNeeded(tx, offer, req.user.id);
        }, { maxWait: 10000, timeout: 15000 });
        return res.status(409).json({
          error: 'Offer has expired and can no longer be acted on',
        });
      }

      // ======================================================================
      // SELLER SELECTS A BUYER BID FOR DEAL NEGOTIATION
      // ======================================================================

      if (action === 'SELECT') {
        if (!isSeller && !admin) {
          return res.status(403).json({ error: 'Only the seller can select a buyer bid' });
        }
        if (offer.status !== 'PENDING') {
          return res.status(400).json({ error: `Only a pending bid can be selected (current: ${offer.status})` });
        }

        const selected = await prisma.$transaction(async (tx) => {
          const fresh = await tx.offer.findUnique({ where: { id: offer.id }, include: { listing: true } });
          if (!fresh) throw offerError('Offer not found', 404);
          if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
            throw offerError('Offer has expired and can no longer be selected', 409);
          }
          if (fresh.status !== 'PENDING') throw offerError(`Only a pending bid can be selected (current: ${fresh.status})`, 409);
          await tx.offer.updateMany({
            where: {
              listingId: fresh.listingId,
              id: { not: fresh.id },
              status: 'SELECTED',
            },
            data: { status: 'PENDING' },
          });
          await tx.offer.update({ where: { id: fresh.id }, data: { status: 'SELECTED' } });
          return tx.offer.findUnique({ where: { id: fresh.id } });
        }, { maxWait: 10000, timeout: 15000 });

        return res.json({ message: 'Buyer bid selected for price negotiation', offer: selected });
      }

      // ======================================================================
      // BUYER ACCEPTS SELLER COUNTER
      // ======================================================================

      if (action === 'ACCEPT_SELECTED') {
        if (!isBuyer && !admin) return res.status(403).json({ error: 'Only the buyer can accept a selected bid' });
        if (offer.status !== 'SELECTED') return res.status(400).json({ error: `Offer must be SELECTED before acceptance (current: ${offer.status})` });
        const result = await prisma.$transaction(async (tx) => {
          const fresh = await tx.offer.findUnique({ where: { id: offer.id }, include: { listing: true } });
          if (!fresh) throw offerError('This selected bid is no longer available', 409);
          if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
            throw offerError('This selected bid has expired and can no longer be accepted', 409);
          }
          if (fresh.status !== 'SELECTED') throw offerError('This selected bid is no longer available', 409);
          return acceptOfferAndCreateOrder(tx, fresh, Number(fresh.amount), fresh.listing.sellerId, req.user.id);
        }, { maxWait: 10000, timeout: 15000 });
        return res.json({ message: 'Selected buyer bid accepted and order created successfully', offer: result.offer, order: result.order, transportAutomaticallyAssigned: false });
      }

      if (action === 'ACCEPT_COUNTER') {
        if (!isBuyer && !admin) {
          return res.status(403).json({
            error:
              'Only the buyer can accept a seller counter-offer',
          });
        }

        if (offer.status !== 'COUNTERED') {
          return res.status(400).json({
            error:
              `Offer must be COUNTERED before acceptance (current: ${offer.status})`,
          });
        }

        if (
          offer.counteredBy !==
          'SELLER'
        ) {
          return res.status(409).json({
            error:
              'The buyer can only accept a counter-offer made by the seller',
          });
        }

        if (
          !isPositiveNumber(
            offer.counterAmount
          )
        ) {
          return res.status(400).json({
            error:
              'Counter-offer has no valid counter amount',
          });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },

                  include: {
                    listing: true,
                  },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (await expireOfferIfNeeded(tx, freshOffer, req.user.id)) {
                throw offerError('Offer has expired and can no longer be acted on', 409);
              }

              if (!['SELECTED', 'COUNTERED'].includes(freshOffer.status)) {
                throw offerError(
                  `Offer cannot be accepted because it is ${freshOffer.status}`,
                  409
                );
              }

              if (freshOffer.status === 'COUNTERED' && freshOffer.counteredBy !== 'SELLER') {
                throw offerError(
                  'The buyer can only accept a seller counter-offer',
                  409
                );
              }

              if (
                !isPositiveNumber(
                  freshOffer.counterAmount
                )
              ) {
                throw offerError(
                  'Counter-offer has no valid counter amount',
                  400
                );
              }

              return acceptOfferAndCreateOrder(
                tx,
                freshOffer,
                Number(
                  freshOffer.counterAmount
                ),
                freshOffer.listing.sellerId,
                req.user.id
              );
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message:
            'Seller counter-offer accepted and order created successfully',

          offer: result.offer,
          order: result.order,

          transportAutomaticallyAssigned:
            false,
        });
      }

      // ======================================================================
      // BUYER RE-COUNTERS
      // ======================================================================

      if (action === 'RE_COUNTER') {
        if (!isBuyer && !admin) {
          return res.status(403).json({
            error:
              'Only the buyer can respond with another counter-offer',
          });
        }

        if (!['SELECTED', 'COUNTERED'].includes(offer.status)) {
          return res.status(400).json({ error: `Offer must be SELECTED or COUNTERED before another counter-offer can be made (current: ${offer.status})` });
        }

        if (offer.status === 'COUNTERED' && offer.counteredBy !== 'SELLER') {
          return res.status(409).json({
            error:
              'The buyer cannot counter twice in a row. The seller must respond first.',
          });
        }

        const counterProblem = amountProblem(
          counterAmount,
          AMOUNT_LIMITS.offer
        );
        if (counterProblem) {
          return res.status(400).json({ error: counterProblem });
        }

        const numericCounter =
          Number(counterAmount);

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                  include: { listing: true },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (await expireOfferIfNeeded(tx, freshOffer, req.user.id)) {
                throw offerError('Offer has expired and can no longer be acted on', 409);
              }

              if (
                !['SELECTED', 'COUNTERED'].includes(
                  freshOffer.status
                )
              ) {
                throw offerError(
                  `Offer cannot be re-countered because it is ${freshOffer.status}`,
                  409
                );
              }

              if (
                freshOffer.status === 'COUNTERED' &&
                freshOffer.counteredBy !==
                'SELLER'
              ) {
                throw offerError(
                  'The buyer cannot counter twice in a row. The seller must respond first.',
                  409
                );
              }

              const negotiationWindowError = validateNegotiationWindow(freshOffer.listing);
              if (negotiationWindowError) {
                throw offerError(negotiationWindowError, 409);
              }

              const counterExpiresAt = offerExpiry(12, freshOffer.listing);
              if (counterExpiresAt.getTime() <= Date.now()) {
                throw offerError('The agricultural pickup window is too close or has expired.', 409);
              }

              await tx.offer.update({
                where: { id: freshOffer.id },
                data: { status: 'COUNTERED' },
              });

              const counterOffer = await tx.offer.create({
                data: {
                  listingId: freshOffer.listingId,
                  buyerId: freshOffer.buyerId,
                  sellerId: freshOffer.sellerId,
                  amount: numericCounter,
                  quantity: freshOffer.quantity,
                  status: 'COUNTERED',
                  counterAmount: numericCounter,
                  counteredBy: 'BUYER',
                  parentOfferId: freshOffer.id,
                  expiresAt: counterExpiresAt,
                  message: freshOffer.message,
                },
              });

              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: 'OFFER_COUNTERED',
                resourceType: 'Offer',
                resourceId: counterOffer.id,
                metadata: {
                  counteredBy: 'BUYER',
                  parentOfferId: freshOffer.id,
                  previousAmount: freshOffer.counterAmount ?? freshOffer.amount,
                  counterAmount: numericCounter,
                },
              });

              return counterOffer;
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message:
            'Buyer counter-offer submitted successfully. The seller must respond next.',

          offer: updated,
        });
      }

      // ======================================================================
      // SELLER ACCEPTS
      // ======================================================================

      if (action === 'ACCEPT') {
        if (!isSeller && !admin) {
          return res.status(403).json({
            error:
              'Only the seller can accept an offer',
          });
        }

        if (!['SELECTED', 'COUNTERED'].includes(offer.status)) {
          return res.status(400).json({ error: `Offer cannot be accepted because it is ${offer.status}` });
        }

        if (
          offer.status === 'COUNTERED' &&
          offer.counteredBy !== 'BUYER'
        ) {
          return res.status(409).json({
            error:
              'The seller cannot accept their own counter-offer. The buyer must respond first.',
          });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },

                  include: {
                    listing: true,
                  },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (await expireOfferIfNeeded(tx, freshOffer, req.user.id)) {
                throw offerError('Offer has expired and can no longer be accepted', 409);
              }

              if (!['SELECTED', 'COUNTERED'].includes(freshOffer.status)) {
                throw offerError(
                  `Offer cannot be accepted because it is ${freshOffer.status}`,
                  409
                );
              }

              if (
                freshOffer.status ===
                  'COUNTERED' &&
                freshOffer.counteredBy !==
                  'BUYER'
              ) {
                throw offerError(
                  'The seller cannot accept their own counter-offer. The buyer must respond first.',
                  409
                );
              }

              const finalPrice =
                freshOffer.status ===
                  'COUNTERED'
                  ? Number(
                      freshOffer.counterAmount
                    )
                  : Number(
                      freshOffer.amount
                    );

              if (
                !Number.isFinite(
                  finalPrice
                ) ||
                finalPrice <= 0
              ) {
                throw offerError(
                  'Offer does not have a valid final price',
                  400
                );
              }

              if (
                freshOffer.status === 'COUNTERED' &&
                freshOffer.counteredBy === 'BUYER' &&
                freshOffer.listing.minAcceptablePrice != null
              ) {
                const minimumPrice = Number(freshOffer.listing.minAcceptablePrice);
                if (
                  Number.isFinite(minimumPrice) &&
                  finalPrice < minimumPrice
                ) {
                  throw offerError(
                    `Buyer counter-offer is below the seller's minimum acceptable price of ${minimumPrice.toFixed(2)} ETB`,
                    409
                  );
                }
              }

              return acceptOfferAndCreateOrder(
                tx,
                freshOffer,
                finalPrice,
                freshOffer.listing.sellerId,
                req.user.id
              );
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message:
            'Offer accepted and order created successfully',

          offer: result.offer,
          order: result.order,

          transportAutomaticallyAssigned:
            false,
        });
      }

      // ======================================================================
      // SELLER REJECTS
      // ======================================================================

      if (action === 'REJECT') {
        if (!isSeller && !admin) {
          return res.status(403).json({
            error:
              'Only the seller can reject an offer',
          });
        }

        if (!['PENDING', 'SELECTED', 'COUNTERED'].includes(offer.status)) {
          return res.status(400).json({ error: `Offer cannot be rejected because it is ${offer.status}` });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                  include: { listing: true },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (!['PENDING', 'SELECTED', 'COUNTERED'].includes(freshOffer.status)) {
                throw offerError(`Offer cannot be rejected because it is ${freshOffer.status}`, 409);
              }

              const updatedOffer =
                await tx.offer.update({
                  where: {
                    id: freshOffer.id,
                  },

                  data: {
                    status: 'REJECTED',
                  },
                });

              const activeOffers = await tx.offer.findMany({
                where: {
                  listingId: freshOffer.listingId,
                  status: { in: ['PENDING', 'COUNTERED'] },
                },
                select: { id: true, parentOfferId: true },
              });
              const activeParentIds = new Set(
                activeOffers.map((item) => item.parentOfferId).filter(Boolean)
              );
              const remainingActiveLeafOffers = activeOffers.filter(
                (item) => !activeParentIds.has(item.id)
              ).length;

              if (remainingActiveLeafOffers === 0) {
                await tx.listing.update({
                  where: { id: freshOffer.listingId },
                  data: { status: 'ACTIVE' },
                });
              }

              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: 'OFFER_REJECTED',
                resourceType: 'Offer',
                resourceId: updatedOffer.id,
                metadata: {
                  listingId: freshOffer.listingId,
                  buyerId: freshOffer.buyerId,
                  remainingActiveLeafOffers,
                },
              });

              return updatedOffer;
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message: 'Offer rejected',
          offer: result,
        });
      }

      // ======================================================================
      // SELLER COUNTERS
      // ======================================================================

      if (action === 'COUNTER') {
        if (!isSeller && !admin) {
          return res.status(403).json({
            error:
              'Only the seller can make a counter-offer',
          });
        }

        const counterProblem = amountProblem(
          counterAmount,
          AMOUNT_LIMITS.offer
        );
        if (counterProblem) {
          return res.status(400).json({ error: counterProblem });
        }

        if (
          !['SELECTED', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be countered because it is ${offer.status}`,
          });
        }

        if (
          offer.status === 'COUNTERED' &&
          offer.counteredBy !== 'BUYER'
        ) {
          return res.status(409).json({
            error:
              'The seller cannot counter twice in a row. The buyer must respond first.',
          });
        }

        const numericCounter =
          Number(counterAmount);

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await tx.offer.findUnique({
                  where: {
                    id: offer.id,
                  },
                  include: { listing: true },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (await expireOfferIfNeeded(tx, freshOffer, req.user.id)) {
                throw offerError('Offer has expired and can no longer be countered', 409);
              }

              if (
                !['SELECTED', 'COUNTERED'].includes(
                  freshOffer.status
                )
              ) {
                throw offerError(
                  `Offer cannot be countered because it is ${freshOffer.status}`,
                  409
                );
              }

              if (
                freshOffer.status ===
                  'COUNTERED' &&
                freshOffer.counteredBy !==
                  'BUYER'
              ) {
                throw offerError(
                  'The seller cannot counter twice in a row. The buyer must respond first.',
                  409
                );
              }

              const negotiationWindowError = validateNegotiationWindow(freshOffer.listing);
              if (negotiationWindowError) {
                throw offerError(negotiationWindowError, 409);
              }

              const counterExpiresAt = offerExpiry(12, freshOffer.listing);
              if (counterExpiresAt.getTime() <= Date.now()) {
                throw offerError('The agricultural pickup window is too close or has expired.', 409);
              }

              await tx.offer.update({
                where: { id: freshOffer.id },
                data: { status: 'COUNTERED' },
              });

              const counterOffer = await tx.offer.create({
                data: {
                  listingId: freshOffer.listingId,
                  buyerId: freshOffer.buyerId,
                  sellerId: freshOffer.sellerId,
                  amount: numericCounter,
                  quantity: freshOffer.quantity,
                  status: 'COUNTERED',
                  counterAmount: numericCounter,
                  counteredBy: 'SELLER',
                  parentOfferId: freshOffer.id,
                  expiresAt: counterExpiresAt,
                  message: freshOffer.message,
                },
              });

              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: 'OFFER_COUNTERED',
                resourceType: 'Offer',
                resourceId: counterOffer.id,
                metadata: {
                  counteredBy: 'SELLER',
                  parentOfferId: freshOffer.id,
                  previousAmount: freshOffer.counterAmount ?? freshOffer.amount,
                  counterAmount: numericCounter,
                },
              });

              return counterOffer;
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message:
            'Seller counter-offer submitted successfully. The buyer must respond next.',

          offer: updated,
        });
      }

      return res.status(400).json({
        error:
          'Unsupported offer action',
      });
    } catch (error) {
      req.log.error({ err: error }, 'RESPOND TO OFFER ERROR:');

      if (error.statusCode) {
        return res
          .status(error.statusCode)
          .json({
            error: error.message,
          });
      }

      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'A conflicting offer or order already exists',
        });
      }

      return res.status(500).json({
        error:
          'Could not respond to offer',

        details:
          process.env.NODE_ENV ===
          'development'
            ? error.message
            : undefined,
      });
    }
  }
);

module.exports = router;
