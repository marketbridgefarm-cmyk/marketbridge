const express = require('express');
const {
  body,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');

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
  [
    body('listingId')
      .notEmpty()
      .withMessage('listingId is required'),

    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('amount must be greater than zero'),

    body('message')
      .optional()
      .isString()
      .trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: errors.array(),
        });
      }

      const listingId = req.body.listingId;
      const amount = Number(req.body.amount);
      const quantity = req.body.quantity === undefined ? null : Number(req.body.quantity);
      const message = req.body.message || null;

      if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
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

      if (listing.category !== 'AGRICULTURAL') {
        return res.status(400).json({
          error:
            'Offers are currently available for agricultural listings only',
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
              in: ['PENDING', 'COUNTERED'],
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
                quantity,
                expiresAt: negotiationExpiresAt,
                message,
                status: 'PENDING',
                counterAmount: null,
                counteredBy: null,
              },
            });

          await tx.listing.update({
            where: {
              id: listingId,
            },
            data: {
              status: 'UNDER_NEGOTIATION',
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
        }
      );

      return res.status(201).json({
        message: 'Offer submitted successfully',
        offer,
      });
    } catch (error) {
      console.error(
        'CREATE OFFER ERROR:',
        error
      );

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
// ============================================================================

router.get(
  '/mine',
  authenticate,
  async (req, res) => {
    try {
      const offers =
        await prisma.offer.findMany({
          where: {
            buyerId: req.user.id,
          },

          include: {
            listing: true,
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
      console.error(
        'MY OFFERS ERROR:',
        error
      );

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
      console.error(
        'GET LISTING OFFERS ERROR:',
        error
      );

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
  const existingOrder =
    await tx.order.findFirst({
      where: {
        listingId: offer.listingId,
      },
    });

  if (existingOrder) {
    throw offerError(
      'An order already exists for this listing',
      409
    );
  }

  const updatedOffer =
    await tx.offer.update({
      where: {
        id: offer.id,
      },

      data: {
        status: 'ACCEPTED',
      },
    });

  await tx.offer.updateMany({
    where: {
      listingId: offer.listingId,

      id: {
        not: offer.id,
      },

      status: {
        in: ['PENDING', 'COUNTERED'],
      },
    },

    data: {
      status: 'REJECTED',
    },
  });

  await tx.listing.update({
    where: {
      id: offer.listingId,
    },

    data: {
      status: 'SOLD',
    },
  });

  const order =
    await tx.order.create({
      data: {
        listingId: offer.listingId,
        buyerId: offer.buyerId,
        sellerId,
        finalPrice,
        status: 'PENDING_PAYMENT',
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
//
// SELLER:
//   ACCEPT
//   REJECT
//   COUNTER
//
// BUYER:
//   ACCEPT_COUNTER
//   RE_COUNTER
//
// NEGOTIATION RULE:
//
// PENDING
//   seller COUNTER
//      ↓
// COUNTERED + counteredBy=SELLER
//      ↓
// buyer ACCEPT_COUNTER OR RE_COUNTER
//      ↓
// COUNTERED + counteredBy=BUYER
//      ↓
// seller ACCEPT OR COUNTER
//      ↓
// repeat
//
// This prevents the same party from countering twice consecutively.
// ============================================================================

router.patch(
  '/:id',
  authenticate,
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
        'RE_COUNTER',
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
        });
        return res.status(409).json({
          error: 'Offer has expired and can no longer be acted on',
        });
      }

      // ======================================================================
      // BUYER ACCEPTS SELLER COUNTER
      // ======================================================================

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

              if (
                freshOffer.status !==
                'COUNTERED'
              ) {
                throw offerError(
                  `Offer cannot be accepted because it is ${freshOffer.status}`,
                  409
                );
              }

              if (
                freshOffer.counteredBy !==
                'SELLER'
              ) {
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
            }
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

        if (offer.status !== 'COUNTERED') {
          return res.status(400).json({
            error:
              `Offer must be COUNTERED before another counter-offer can be made (current: ${offer.status})`,
          });
        }

        // Seller must have made the previous counter.
        if (
          offer.counteredBy !==
          'SELLER'
        ) {
          return res.status(409).json({
            error:
              'The buyer cannot counter twice in a row. The seller must respond first.',
          });
        }

        if (
          !isPositiveNumber(
            counterAmount
          )
        ) {
          return res.status(400).json({
            error:
              'counterAmount must be greater than zero',
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
                throw offerError('Offer has expired and can no longer be acted on', 409);
              }

              if (
                freshOffer.status !==
                'COUNTERED'
              ) {
                throw offerError(
                  `Offer cannot be re-countered because it is ${freshOffer.status}`,
                  409
                );
              }

              if (
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
            }
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

        if (
          !['PENDING', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be accepted because it is ${offer.status}`,
          });
        }

        // If the offer is COUNTERED, it must have been
        // countered by the buyer. The seller cannot accept
        // their own latest counter.
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

              if (
                !['PENDING', 'COUNTERED'].includes(
                  freshOffer.status
                )
              ) {
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

              return acceptOfferAndCreateOrder(
                tx,
                freshOffer,
                finalPrice,
                freshOffer.listing.sellerId,
                req.user.id
              );
            }
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

        if (
          !['PENDING', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be rejected because it is ${offer.status}`,
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
                  include: { listing: true },
                });

              if (!freshOffer) {
                throw offerError(
                  'Offer not found',
                  404
                );
              }

              if (
                !['PENDING', 'COUNTERED'].includes(
                  freshOffer.status
                )
              ) {
                throw offerError(
                  `Offer cannot be rejected because it is ${freshOffer.status}`,
                  409
                );
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

              const remainingOffers =
                await tx.offer.count({
                  where: {
                    listingId:
                      freshOffer.listingId,

                    status: {
                      in: [
                        'PENDING',
                        'COUNTERED',
                      ],
                    },
                  },
                });

              if (
                remainingOffers === 0
              ) {
                await tx.listing.update({
                  where: {
                    id:
                      freshOffer.listingId,
                  },

                  data: {
                    status: 'ACTIVE',
                  },
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
                  remainingActiveOffers: remainingOffers,
                },
              });

              return updatedOffer;
            }
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

        if (
          !isPositiveNumber(
            counterAmount
          )
        ) {
          return res.status(400).json({
            error:
              'counterAmount must be greater than zero',
          });
        }

        if (
          !['PENDING', 'COUNTERED'].includes(
            offer.status
          )
        ) {
          return res.status(400).json({
            error:
              `Offer cannot be countered because it is ${offer.status}`,
          });
        }

        // If already COUNTERED, the previous counter
        // must have been made by the BUYER.
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

              if (
                !['PENDING', 'COUNTERED'].includes(
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
            }
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
      console.error(
        'RESPOND TO OFFER ERROR:',
        error
      );

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
