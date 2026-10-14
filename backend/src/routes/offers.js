const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { idempotency } = require('../middleware/idempotency');

const { validators: createOfferValidators, createOffer } = require('./offerHandlers/createOffer');
const { myOffers } = require('./offerHandlers/myOffers');
const { listingOffers } = require('./offerHandlers/listingOffers');
const { listNotices, markNoticesRead } = require('./offerHandlers/notices');
const { reopenBidding } = require('./offerHandlers/reopenBidding');
const { respondToOffer } = require('./offerHandlers/respondToOffer');

// Offer / negotiation routes, mounted at /api/offers (see src/index.js).
//
// This file only wires routes to handlers. Logic lives in:
//   routes/offerHandlers/*            one file per endpoint
//   routes/offerHandlers/actions/*    one file per PATCH /:id action
//   services/offers/offerHelpers.js   shared predicates, timing and leaf resolution
//   services/offers/offerOrderService.js   provisional agreement + order creation
//
// ORDER MATTERS: the literal paths ('/mine', '/notices', '/listing/...') must be
// registered before the catch-all PATCH '/:id'.

const router = express.Router();

// Buyer makes an offer
router.post(
  '/',
  authenticate,
  requireRole('BUYER'),
  idempotency('offers.create'),
  createOfferValidators,
  createOffer
);

// Buyer: my offers
router.get('/mine', authenticate, myOffers);

// Offers on a listing (seller/admin see all, buyers see their own)
router.get('/listing/:listingId', authenticate, listingOffers);

// Waiting-list / negotiation notices
router.get('/notices', authenticate, listNotices);
router.patch('/notices/read', authenticate, markNoticesRead);

// Admin: reopen bidding on a listing
router.patch(
  '/listing/:listingId/reopen-bidding',
  authenticate,
  requireRole('ADMIN'),
  requireMfa(),
  reopenBidding
);

// Respond to an offer (select / counter / accept / release / reject / ...)
router.patch(
  '/:id',
  authenticate,
  idempotency('offers.action'),
  respondToOffer
);

module.exports = router;
