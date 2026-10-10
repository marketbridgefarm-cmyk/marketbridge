const express = require('express');
const {
  body,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('../services/orderEventService');
const { idempotency } = require('../middleware/idempotency');
const { computePaymentDueAt, computeInspectionWorkflowDueAt } = require('../utils/orderTiming');
const { noticeWaitingLocked, noticeWaitingUnlocked, noticeBuyerReleased } = require('../services/waitingListService');
const { getMarketPriceReference, marketSnapshotData } = require('../services/marketPriceService');
const {
  AMOUNT_LIMITS,
  amountProblem,
  validAmount,
  noContactInfo,
} = require('../utils/contactGuard');
const {
  parseReleaseReason,
  assertAcceptedReleaseWindowElapsed,
  releaseAllowance,
  LIMIT_MESSAGE,
} = require('../services/releaseLimitsService');

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

// No response timers: waiting bids stay until the goods are paid and
// negotiation continues until a price is agreed. The only natural limit is the
// end of an agricultural listing's pickup window (null = no expiry).
function offerExpiry(listing = null) {
  if (listing?.category === 'AGRICULTURAL' && listing.pickupWindowEnd) {
    const end = new Date(listing.pickupWindowEnd);
    if (Number.isFinite(end.getTime())) return end;
  }
  return null;
}

function validateNegotiationWindow(listing) {
  if (listing?.category !== 'AGRICULTURAL' || !listing.pickupWindowEnd) return null;

  const deadline = new Date(listing.pickupWindowEnd).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    return 'The agricultural pickup window has expired; negotiation cannot continue until the listing is updated.';
  }

  return null;
}

// Safety valve for a silent buyer. The seller can never reject a buyer in
// negotiation, but may RELEASE a buyer who has not responded for a while.
// Only when it is the buyer's turn: SELECTED (buyer has not answered) or a
// seller counter (buyer has not answered it). 0 hours = allowed immediately.
function releaseAfterHours() {
  const configured = Number(process.env.OFFER_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 72;
}

function releaseAvailableAt(offer) {
  const buyersTurn =
    offer.status === 'SELECTED' ||
    (offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER');
  if (!buyersTurn) return null;
  const since = new Date(offer.updatedAt || offer.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + releaseAfterHours() * 60 * 60 * 1000);
}

// Provisional release window (24h by default). This is the "you must wait
// before you can release a provisional agreement" cooldown.
const PROVISIONAL_RELEASE_AFTER_HOURS = (() => {
  const configured = Number(process.env.OFFER_PROVISIONAL_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

function provisionalReleaseAvailableAt(offer) {
  if (!offer) return null;
  const since = new Date(offer.updatedAt || offer.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + PROVISIONAL_RELEASE_AFTER_HOURS * 60 * 60 * 1000);
}

function isOfferExpired(offer) {
  return Boolean(
    offer.expiresAt &&
    new Date(offer.expiresAt).getTime() <= Date.now()
  );
}

// ---------------------------------------------------------------------------
// LEAF RESOLUTION
// ---------------------------------------------------------------------------
// A counter-chain is a linked list of immutable rows. The leaf is the row
// with no children — the current live price. Every mutation must resolve the
// leaf first so a stale parent id can never be acted on.
function findLeafOffer(tx, offerId, extra = {}) {
  return tx.offer.findFirst({
    where: { id: offerId, childOffers: { none: {} } },
    ...extra,
  });
}

async function expireOfferIfNeeded(tx, offer, actorId = null) {
  if (!offer || !isOfferExpired(offer)) return false;
  if (!['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(offer.status)) return false;

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

    body('message').optional({ nullable: true }).custom((value) => value == null || value === '').withMessage('Free-text messages are not supported. Use the structured fields provided.'),
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
);

// ============================================================================
// PROVISIONAL TRANSITION
// ============================================================================

async function moveOfferToProvisional(tx, offer, finalUnitPrice, actorId) {
  if (!['AGRICULTURAL', 'PRODUCT'].includes(offer.listing.category)) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }
  if (isOfferExpired(offer)) {
    throw offerError('Offer has expired and can no longer be accepted', 409);
  }

  const unitPrice = Number(finalUnitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw offerError('Offer does not have a valid unit price', 400);
  }

  const claim = await tx.offer.updateMany({
    where: { id: offer.id, status: { in: ['SELECTED', 'COUNTERED'] } },
    data: { status: 'PROVISIONAL' },
  });
  if (claim.count !== 1) throw offerError('This offer has already been acted on', 409);

  const updatedOffer = await tx.offer.findUnique({ where: { id: offer.id } });

  await recordAuditEvent(tx, {
    actorId,
    action: 'OFFER_PROVISIONAL_AGREED',
    resourceType: 'Offer',
    resourceId: updatedOffer.id,
    metadata: {
      listingId: offer.listingId,
      buyerId: offer.buyerId,
      sellerId: offer.sellerId,
      agreedUnitPrice: unitPrice,
      quantity: Number(offer.quantity),
    },
  });

  return { offer: updatedOffer };
}

// ============================================================================
// ACCEPT OFFER AND CREATE ORDER
// ============================================================================

async function acceptOfferAndCreateOrder(
  tx,
  offer,
  finalUnitPrice,
  sellerId,
  actorId = sellerId
) {
  if (!['AGRICULTURAL', 'PRODUCT'].includes(offer.listing.category)) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }

  if (isOfferExpired(offer)) {
    throw offerError('Offer has expired and can no longer be accepted', 409);
  }

  const requestedQuantity = Number(offer.quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw offerError('Offer has no valid quantity', 400);
  }

  const unitPrice = Number(finalUnitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw offerError('Offer does not have a valid unit price', 400);
  }

  const lockedListingRows = await tx.$queryRaw`
    SELECT "id", "availableQuantity", "quantity", "minAcceptablePrice", "category", "sellerId"
    FROM "Listing"
    WHERE "id" = ${offer.listingId}
    FOR UPDATE
  `;
  const lockedListing = lockedListingRows?.[0];
  if (!lockedListing) throw offerError('Listing not found', 404);
  if (!['AGRICULTURAL', 'PRODUCT'].includes(String(lockedListing.category))) {
    throw offerError('Offers can only create orders for physical goods listings', 400);
  }
  if (String(lockedListing.sellerId) !== String(sellerId)) {
    throw offerError('Listing seller changed; refresh and try again', 409);
  }

  const availableQuantity = Number(lockedListing.availableQuantity);
  if (!Number.isFinite(availableQuantity) || availableQuantity < requestedQuantity) {
    throw offerError(
      `Only ${Number.isFinite(availableQuantity) ? availableQuantity : 0} units remain available for this offer`,
      409
    );
  }

  const totalPrice = Math.round(unitPrice * requestedQuantity * 100) / 100;
  const minimumUnitPrice = lockedListing.minAcceptablePrice == null
    ? null
    : Number(lockedListing.minAcceptablePrice);
  if (minimumUnitPrice != null && Number.isFinite(minimumUnitPrice) && unitPrice < minimumUnitPrice) {
    throw offerError(
      "Offer price is below the seller's minimum acceptable price",
      409
    );
  }

  const offerClaim = await tx.offer.updateMany({
    where: {
      id: offer.id,
      status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
    },
    data: { status: 'ACCEPTED' },
  });

  if (offerClaim.count !== 1) {
    throw offerError('This offer has already been acted on', 409);
  }

  const updatedOffer = await tx.offer.findUnique({
    where: { id: offer.id },
  });

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

  const inspectionRequired =
    offer.listing.category === 'AGRICULTURAL' ||
    offer.listing.inspectionRequired === true;

  const order =
    await tx.order.create({
      data: {
        listingId: offer.listingId,
        buyerId: offer.buyerId,
        sellerId,
        finalPrice: totalPrice,
        originalFinalPrice: totalPrice,
        quantity: requestedQuantity,
        status: 'PENDING_PAYMENT',
        agreedOfferId: updatedOffer.id,
        agreedAt: new Date(),
        paymentDueAt: inspectionRequired ? null : computePaymentDueAt(),
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
      finalUnitPrice: unitPrice,
      totalPrice,
      quantity: requestedQuantity,
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
      finalUnitPrice: unitPrice,
      totalPrice,
      quantity: requestedQuantity,
      status: order.status,
    },
  });

  return {
    offer: updatedOffer,
    order,
  };
}

// ============================================================================
// WAITING-LIST / NEGOTIATION NOTICES
// ============================================================================

router.get('/notices', authenticate, async (req, res) => {
  try {
    const notices = await prisma.offerNotification.findMany({
      where: { userId: req.user.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });
    return res.json({
      notices,
      unreadCount: notices.filter((notice) => !notice.readAt).length,
    });
  } catch (error) {
    req.log.error({ err: error }, 'LIST OFFER NOTICES ERROR');
    return res.status(500).json({ error: 'Failed to load notices' });
  }
});

router.patch('/notices/read', authenticate, async (req, res) => {
  try {
    await prisma.offerNotification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'READ OFFER NOTICES ERROR');
    return res.status(500).json({ error: 'Failed to update notices' });
  }
});

// ============================================================================
// ADMIN REOPEN-BIDDING
// PATCH /api/offers/listing/:listingId/reopen-bidding
// ============================================================================

router.patch(
  '/listing/:listingId/reopen-bidding',
  authenticate,
  requireRole('ADMIN'),
  requireMfa(),
  async (req, res) => {
    try {
      const listingId = req.params.listingId;

      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
      });

      if (!listing) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      if (!['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'].includes(listing.status)) {
        return res.status(409).json({
          error: `Bidding cannot be reopened while the listing is ${listing.status}`,
        });
      }

      const reopened = await prisma.$transaction(async (tx) => {
        const lockedListings = await tx.$queryRaw`
          SELECT "id", "status"
          FROM "Listing"
          WHERE "id" = ${listingId}
          FOR UPDATE
        `;
        if (!lockedListings?.length) {
          throw offerError('Listing not found', 404);
        }

        const freshStatus = lockedListings[0].status;
        if (!['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'].includes(freshStatus)) {
          throw offerError(
            `Bidding cannot be reopened while the listing is ${freshStatus}`,
            409
          );
        }

        const liveLeafOffers = await tx.offer.count({
          where: {
            listingId,
            status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL', 'ACCEPTED'] },
            childOffers: { none: {} },
          },
        });
        if (liveLeafOffers > 0) {
          throw offerError(
            `A fresh bidding round cannot be opened while ${liveLeafOffers} offer(s) are still waiting or in negotiation. They stay locked until the current negotiation or order ends.`,
            409
          );
        }

        const activeOrder = await tx.order.findFirst({
          where: {
            listingId,
            status: { notIn: ['CANCELLED', 'COMPLETED'] },
          },
          select: { id: true, status: true },
        });
        if (activeOrder) {
          throw offerError(
            'Bidding cannot be reopened while an active provisional order exists on this listing. Cancel or complete that order first.',
            409
          );
        }

        const activePayment = await tx.payment.findFirst({
          where: {
            order: { listingId },
            status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
          },
          select: { id: true, status: true },
        });
        if (activePayment) {
          throw offerError(
            'Bidding cannot be reopened after a payment has started or completed for this listing.',
            409
          );
        }

        const updated = await tx.listing.update({
          where: { id: listingId },
          data: { status: 'ACTIVE' },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'LISTING_BIDDING_REOPENED',
          resourceType: 'Listing',
          resourceId: updated.id,
          metadata: {
            previousStatus: freshStatus,
            liveLeafOffers: 0,
          },
        });

        return updated;
      }, { maxWait: 10000, timeout: 15000 });

      await noticeWaitingUnlocked(prisma, {
        listingId: reopened.id,
        reason: 'ADMIN_REOPENED_BIDDING',
      });

      return res.json({
        message: 'Fresh bidding round opened for this listing.',
        listing: reopened,
      });
    } catch (error) {
      req.log.error({ err: error }, 'REOPEN LISTING BIDDING ERROR:');

      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      return res.status(500).json({
        error: 'Could not reopen bidding for this listing',
      });
    }
  }
);

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
        'WITHDRAW',
        'RELEASE',
        'CONFIRM_PROVISIONAL',
        'RELEASE_PROVISIONAL',
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
          return res.status(403).json({
            error: 'Only the seller can select a buyer bid',
          });
        }

        if (offer.status !== 'PENDING') {
          return res.status(409).json({
            error: `Only a pending bid can be selected (current: ${offer.status})`,
          });
        }

        const selected = await prisma.$transaction(async (tx) => {
          const lockedListings = await tx.$queryRaw`
            SELECT "id", "sellerId"
            FROM "Listing"
            WHERE "id" = ${offer.listingId}
            FOR UPDATE
          `;

          if (!lockedListings?.length) {
            throw offerError('Listing not found', 404);
          }

          if (String(lockedListings[0].sellerId) !== String(sellerId)) {
            throw offerError('Listing seller changed; refresh and try again', 409);
          }

          const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });

          if (!fresh) throw offerError('Offer not found', 404);

          if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
            throw offerError('Offer has expired and can no longer be selected', 409);
          }

          if (fresh.status !== 'PENDING') {
            throw offerError(
              `This bid is no longer pending (current: ${fresh.status})`,
              409
            );
          }

          const negotiationWindowError = validateNegotiationWindow(fresh.listing);
          if (negotiationWindowError) {
            throw offerError(negotiationWindowError, 409);
          }

          const activeNegotiation = await tx.offer.findFirst({
            where: {
              listingId: fresh.listingId,
              status: { in: ['SELECTED', 'COUNTERED', 'PROVISIONAL'] },
              childOffers: { none: {} },
            },
            select: { id: true, buyerId: true, status: true },
          });

          if (activeNegotiation && String(activeNegotiation.buyerId) !== String(fresh.buyerId)) {
            throw offerError(
              'Another buyer is already in negotiation. Waiting bids cannot be selected until that negotiation is released, rejected, withdrawn, or expires.',
              409
            );
          }

          const provisionalOrder = await tx.order.findFirst({
            where: {
              listingId: fresh.listingId,
              status: { notIn: ['CANCELLED', 'COMPLETED'] },
            },
            select: { id: true },
          });

          if (provisionalOrder) {
            throw offerError(
              'This listing already has an active provisional order. Release or cancel it before selecting another buyer.',
              409
            );
          }

          const claim = await tx.offer.updateMany({
            where: { id: fresh.id, status: 'PENDING' },
            data: { status: 'SELECTED' },
          });

          if (claim.count !== 1) {
            throw offerError(
              'This bid changed while you were selecting it. Refresh and try again.',
              409
            );
          }

          await recordAuditEvent(tx, {
            actorId: req.user.id,
            action: 'OFFER_SELECTED',
            resourceType: 'Offer',
            resourceId: fresh.id,
            metadata: {
              listingId: fresh.listingId,
              buyerId: fresh.buyerId,
            },
          });

          return tx.offer.findUnique({ where: { id: fresh.id } });
        }, { maxWait: 10000, timeout: 15000 });

        await noticeWaitingLocked(prisma, {
          listingId: selected.listingId,
          selectedOfferId: selected.id,
          selectedBuyerId: selected.buyerId,
        });

        return res.json({
          message: 'Buyer bid selected for exclusive price negotiation',
          offer: selected,
        });
      }

      // ======================================================================
      // BUYER ACCEPTS SELECTED BID  →  PROVISIONAL
      // ======================================================================

      if (action === 'ACCEPT_SELECTED') {
        if (!isBuyer && !admin) return res.status(403).json({ error: 'Only the buyer can accept a selected bid' });
        if (offer.status !== 'SELECTED') return res.status(400).json({ error: `Offer must be SELECTED before acceptance (current: ${offer.status})` });
        const result = await prisma.$transaction(async (tx) => {
          const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
          if (!fresh) throw offerError('This selected bid is no longer available', 409);
          if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
            throw offerError('This selected bid has expired and can no longer be accepted', 409);
          }
          if (fresh.status !== 'SELECTED') throw offerError('This selected bid is no longer available', 409);
          return moveOfferToProvisional(tx, fresh, Number(fresh.amount), req.user.id);
        }, { maxWait: 10000, timeout: 15000 });
        return res.json({
          message: 'Provisional agreement reached. Either party can confirm to create the order.',
          offer: result.offer,
          provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
        });
      }

      // ======================================================================
      // BUYER ACCEPTS SELLER COUNTER  →  PROVISIONAL
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
                await findLeafOffer(tx, offer.id, { include: { listing: true } });

              if (!freshOffer) {
                throw offerError(
                  'This negotiation has moved on. Refresh and try again.',
                  409
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

              return moveOfferToProvisional(tx, freshOffer, Number(freshOffer.counterAmount), req.user.id);
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message: 'Provisional agreement reached. Either party can confirm to create the order.',
          offer: result.offer,
          provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
        });
      }

      // ======================================================================
      // SELLER ACCEPTS  →  PROVISIONAL
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
                await findLeafOffer(tx, offer.id, { include: { listing: true } });

              if (!freshOffer) {
                throw offerError(
                  'This negotiation has moved on. Refresh and try again.',
                  409
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

              return moveOfferToProvisional(tx, freshOffer, finalPrice, req.user.id);
            },
            { maxWait: 10000, timeout: 15000 }
          );

        return res.json({
          message: 'Provisional agreement reached. Either party can confirm to create the order.',
          offer: result.offer,
          provisionalReleaseAvailableAt: provisionalReleaseAvailableAt(result.offer),
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
        const marketReference = await getMarketPriceReference(prisma, offer.listing, { quantity: offer.quantity });

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await findLeafOffer(tx, offer.id, { include: { listing: true } });

              if (!freshOffer) {
                throw offerError(
                  'This negotiation has moved on. Refresh and try again.',
                  409
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

              const counterExpiresAt = offerExpiry(freshOffer.listing);
              if (counterExpiresAt && counterExpiresAt.getTime() <= Date.now()) {
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
                  ...marketSnapshotData(marketReference, freshOffer.quantity),
                  message: freshOffer.message,
                },
              });

              // [L] — persist the reason the buyer picked in the counter UI.
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
                  reasonCode: req.body.reasonCode || null,
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
      // SELLER RELEASES A SILENT BUYER (during negotiation — 72h)
      // ======================================================================

      if (action === 'RELEASE') {
        if (!isSeller && !admin) {
          return res.status(403).json({ error: 'Only the seller can release a buyer' });
        }

        const availableAt = releaseAvailableAt(offer);
        if (!availableAt) {
          return res.status(409).json({
            error: 'You can release a buyer only while you are waiting for the buyer to respond. Accept or counter the buyer\'s latest price instead.',
          });
        }
        if (!admin && availableAt.getTime() > Date.now()) {
          return res.status(409).json({
            error: `The buyer has not been inactive long enough. You can release this buyer from ${availableAt.toISOString()}.`,
            releaseAvailableAt: availableAt,
          });
        }

        const released = await prisma.$transaction(
          async (tx) => {
            const freshOffer = await findLeafOffer(tx, offer.id);
            if (!freshOffer) throw offerError('This negotiation has moved on. Refresh and try again.', 409);

            const freshAvailableAt = releaseAvailableAt(freshOffer);
            if (!freshAvailableAt || (!admin && freshAvailableAt.getTime() > Date.now())) {
              throw offerError('This negotiation changed. Refresh and try again.', 409);
            }

            const superseded = await tx.offer.count({ where: { parentOfferId: freshOffer.id } });
            if (superseded > 0) {
              throw offerError('This offer was superseded by a newer counter. Refresh and try again.', 409);
            }

            const updatedOffer = await tx.offer.update({
              where: { id: freshOffer.id },
              data: { status: 'WITHDRAWN' },
            });

            const remainingActiveLeafOffers = await tx.offer.count({
              where: {
                listingId: freshOffer.listingId,
                status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
                childOffers: { none: {} },
              },
            });

            if (remainingActiveLeafOffers === 0) {
              await tx.listing.update({
                where: { id: freshOffer.listingId },
                data: { status: 'ACTIVE' },
              });
            }

            await recordAuditEvent(tx, {
              actorId: req.user.id,
              action: 'OFFER_RELEASED',
              resourceType: 'Offer',
              resourceId: updatedOffer.id,
              metadata: {
                listingId: freshOffer.listingId,
                buyerId: freshOffer.buyerId,
                previousStatus: freshOffer.status,
                inactiveSince: freshOffer.updatedAt,
                remainingActiveLeafOffers,
              },
            });

            return updatedOffer;
          },
          { maxWait: 10000, timeout: 15000 }
        );

        await noticeBuyerReleased(prisma, { listingId: released.listingId, offerId: released.id, buyerId: released.buyerId });
        await noticeWaitingUnlocked(prisma, { listingId: released.listingId, reason: 'SELLER_RELEASED' });

        return res.json({
          message: 'Buyer released. You can now select another waiting bid.',
          offer: released,
        });
      }

      // ======================================================================
      // CONFIRM PROVISIONAL → ORDER CREATED
      // ======================================================================

      if (action === 'CONFIRM_PROVISIONAL') {
        if (!isBuyer && !isSeller && !admin) {
          return res.status(403).json({ error: 'Only a participant can confirm the provisional agreement' });
        }
        if (offer.status !== 'PROVISIONAL') {
          return res.status(400).json({ error: `Offer must be PROVISIONAL before confirmation (current: ${offer.status})` });
        }

        const result = await prisma.$transaction(async (tx) => {
          const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
          if (!fresh) throw offerError('This provisional agreement is no longer available', 409);
          if (await expireOfferIfNeeded(tx, fresh, req.user.id)) {
            throw offerError('This provisional agreement has expired', 409);
          }
          if (fresh.status !== 'PROVISIONAL') {
            throw offerError('This provisional agreement is no longer available', 409);
          }

          const finalPrice =
            fresh.counteredBy != null && Number.isFinite(Number(fresh.counterAmount))
              ? Number(fresh.counterAmount)
              : Number(fresh.amount);

          return acceptOfferAndCreateOrder(tx, fresh, finalPrice, fresh.listing.sellerId, req.user.id);
        }, { maxWait: 10000, timeout: 15000 });

        return res.json({
          message: 'Provisional agreement confirmed and order created successfully',
          offer: result.offer,
          order: result.order,
          transportAutomaticallyAssigned: false,
        });
      }

      // ======================================================================
      // RELEASE PROVISIONAL (24h cooldown + reason + cap for the seller)
      // ======================================================================

      if (action === 'RELEASE_PROVISIONAL') {
        if (!isBuyer && !isSeller && !admin) {
          return res.status(403).json({ error: 'Only a participant can release the provisional agreement' });
        }
        if (offer.status !== 'PROVISIONAL') {
          return res.status(400).json({ error: `Only a provisional agreement can be released (current: ${offer.status})` });
        }

        const availableAt = provisionalReleaseAvailableAt(offer);
        if (availableAt && !admin && availableAt.getTime() > Date.now()) {
          return res.status(409).json({
            error: `The provisional agreement was made recently. You can release it from ${availableAt.toISOString()}.`,
            releaseAvailableAt: availableAt,
          });
        }

        const isBuyerRelease = isBuyer;

        let releaseInfo;
        try {
          releaseInfo = parseReleaseReason(req.body, { provider: isBuyerRelease });
        } catch (limitErr) {
          return res.status(limitErr.statusCode || 400).json({ error: limitErr.message });
        }

        const released = await prisma.$transaction(async (tx) => {
          const lockedListings = await tx.$queryRaw`
            SELECT "id" FROM "Listing" WHERE "id" = ${offer.listingId} FOR UPDATE
          `;
          if (!lockedListings?.length) throw offerError('Listing not found', 404);

          let releaseNumber = null;
          if (isSeller && !admin) {
            const { used, allowed } = await releaseAllowance(tx, {
              action: 'OFFER_PROVISIONAL_RELEASED',
              metadataKey: 'listingId',
              jobId: offer.listingId,
            });
            if (used >= allowed) {
              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: 'OFFER_RELEASE_BLOCKED_ADMIN_REVIEW',
                resourceType: 'Offer',
                resourceId: offer.id,
                metadata: {
                  listingId: offer.listingId,
                  sellerId: offer.sellerId,
                  attemptedReason: releaseInfo.reason,
                  releasesUsed: used,
                  limit: allowed,
                },
              });
              return { blocked: true };
            }
            releaseNumber = used + 1;
          }

          const fresh = await findLeafOffer(tx, offer.id, { include: { listing: true } });
          if (!fresh || fresh.status !== 'PROVISIONAL') {
            throw offerError('This provisional agreement is no longer available', 409);
          }

          const freshAvailableAt = provisionalReleaseAvailableAt(fresh);
          if (freshAvailableAt && !admin && freshAvailableAt.getTime() > Date.now()) {
            throw offerError('This provisional agreement was made recently. Refresh and try again.', 409);
          }

          const updated = await tx.offer.update({
            where: { id: fresh.id },
            data: { status: 'WITHDRAWN' },
          });

          const remainingActiveLeafOffers = await tx.offer.count({
            where: {
              listingId: fresh.listingId,
              status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
              childOffers: { none: {} },
            },
          });
          if (remainingActiveLeafOffers === 0) {
            await tx.listing.update({ where: { id: fresh.listingId }, data: { status: 'ACTIVE' } });
          }

          await recordAuditEvent(tx, {
            actorId: req.user.id,
            action: isBuyerRelease
              ? 'OFFER_PROVISIONAL_RELEASED_BY_BUYER'
              : 'OFFER_PROVISIONAL_RELEASED',
            resourceType: 'Offer',
            resourceId: updated.id,
            metadata: {
              listingId: fresh.listingId,
              buyerId: fresh.buyerId,
              sellerId: fresh.sellerId,
              releasedBy: isBuyerRelease ? 'BUYER' : 'SELLER',
              reason: releaseInfo.reason,
              note: releaseInfo.note,
              releaseNumber,
              remainingActiveLeafOffers,
            },
          });

          return updated;
        }, { maxWait: 10000, timeout: 15000 });

        if (released && released.blocked) {
          return res.status(409).json({ error: LIMIT_MESSAGE, code: 'RELEASE_LIMIT_REACHED' });
        }

        await noticeBuyerReleased(prisma, {
          listingId: released.listingId,
          offerId: released.id,
          buyerId: released.buyerId,
        }).catch(() => {});
        await noticeWaitingUnlocked(prisma, {
          listingId: released.listingId,
          reason: 'PROVISIONAL_RELEASED',
        }).catch(() => {});

        return res.json({
          message: 'Provisional agreement released. Other waiting bids are available again.',
          offer: released,
        });
      }

      // ======================================================================
      // REJECT (buyer only) / WITHDRAW (buyer only, waiting bid)
      // ======================================================================

      if (action === 'REJECT' || action === 'WITHDRAW') {
        const isWithdraw = action === 'WITHDRAW';

        if (isSeller && !admin) {
          return res.status(403).json({
            error: 'Sellers cannot reject bids. Select, accept or counter. If a selected buyer stays silent you can release them after the inactivity period. Waiting bids stay locked until the negotiation or order ends.',
          });
        }

        if (!isBuyer && !admin) {
          return res.status(403).json({ error: 'Only the buyer can do this' });
        }

        const allowedStatuses = isWithdraw ? ['PENDING'] : ['SELECTED', 'COUNTERED'];
        if (!allowedStatuses.includes(offer.status)) {
          return res.status(400).json({
            error: isWithdraw
              ? `Only a waiting bid can be withdrawn (current: ${offer.status})`
              : `Offer cannot be rejected because it is ${offer.status}`,
          });
        }

        const terminalStatus = isWithdraw ? 'WITHDRAWN' : 'REJECTED';

        const result =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer = await findLeafOffer(tx, offer.id, { include: { listing: true } });

              if (!freshOffer) {
                throw offerError('This negotiation has moved on. Refresh and try again.', 409);
              }

              if (!allowedStatuses.includes(freshOffer.status)) {
                throw offerError(
                  `Offer is no longer ${allowedStatuses.join('/')} (current: ${freshOffer.status})`,
                  409
                );
              }

              const superseded = await tx.offer.count({ where: { parentOfferId: freshOffer.id } });
              if (superseded > 0) {
                throw offerError('This offer was superseded by a newer counter. Refresh and try again.', 409);
              }

              const updatedOffer =
                await tx.offer.update({
                  where: { id: freshOffer.id },
                  data: { status: terminalStatus },
                });

              const remainingActiveLeafOffers = await tx.offer.count({
                where: {
                  listingId: freshOffer.listingId,
                  status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'] },
                  childOffers: { none: {} },
                },
              });

              if (remainingActiveLeafOffers === 0) {
                await tx.listing.update({
                  where: { id: freshOffer.listingId },
                  data: { status: 'ACTIVE' },
                });
              }

              await recordAuditEvent(tx, {
                actorId: req.user.id,
                action: isWithdraw ? 'OFFER_WITHDRAWN' : 'OFFER_REJECTED',
                resourceType: 'Offer',
                resourceId: updatedOffer.id,
                metadata: {
                  listingId: freshOffer.listingId,
                  buyerId: freshOffer.buyerId,
                  previousStatus: freshOffer.status,
                  remainingActiveLeafOffers,
                },
              });

              return updatedOffer;
            },
            { maxWait: 10000, timeout: 15000 }
          );

        if (!isWithdraw) {
          await noticeWaitingUnlocked(prisma, { listingId: result.listingId, reason: 'BUYER_REJECTED' });
        }

        return res.json({
          message: isWithdraw
            ? 'You left the waiting list.'
            : 'Offer rejected. The seller can now select another waiting bid.',
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
        const marketReference = await getMarketPriceReference(prisma, offer.listing, { quantity: offer.quantity });

        const updated =
          await prisma.$transaction(
            async (tx) => {
              const freshOffer =
                await findLeafOffer(tx, offer.id, { include: { listing: true } });

              if (!freshOffer) {
                throw offerError(
                  'This negotiation has moved on. Refresh and try again.',
                  409
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

              const counterExpiresAt = offerExpiry(freshOffer.listing);
              if (counterExpiresAt && counterExpiresAt.getTime() <= Date.now()) {
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
                  ...marketSnapshotData(marketReference, freshOffer.quantity),
                  message: freshOffer.message,
                },
              });

              // [L] — persist the reason the seller picked in the counter UI.
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
                  reasonCode: req.body.reasonCode || null,
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
