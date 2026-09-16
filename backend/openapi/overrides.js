'use strict';

/**
 * Hand-authored enrichment, keyed by `"METHOD /openapi/path"` (path params
 * as `{id}`, matching what generate-openapi.js produces). Deep-merged over
 * the generated operation for that route — anything you don't set here
 * (parameters, requestBody, auth) is left as whatever the generator found.
 *
 * Scope: the endpoints an outside integrator hits first — auth, listings,
 * offers, orders, payments, plus one representative each for inspections,
 * transport, digital products, ratings, messages, disputes. Everything
 * else still documents correctly (path, params, auth, status codes) from
 * the generator alone; it just doesn't have a hand-typed response body
 * yet. Add an entry here the next time you're in one of those endpoints.
 */

const j = (schema) => ({ content: { 'application/json': { schema } } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

module.exports = {
  // ---------------------------------------------------------------- AUTH --
  'POST /api/auth/register': {
    summary: 'Register a new account',
    description:
      'Creates a user with default roles [BUYER, SELLER] unless `roles` is given (may additionally ' +
      'include INSPECTOR, TRUCK_OWNER, ADVERTISER). Sets the refresh token as an HttpOnly cookie and ' +
      'returns a short-lived access token in the body.',
    responses: {
      201: { description: 'Account created.', ...j({ type: 'object', properties: { user: ref('User'), token: { type: 'string' }, expiresIn: { type: 'string' } } }) },
      409: { description: 'Email already registered.', ...j(ref('Error')) },
    },
  },
  'POST /api/auth/login': {
    summary: 'Log in with email and password',
    description:
      'On success without MFA, returns an access token and sets the refresh cookie. If the account has ' +
      'MFA enabled, instead returns `{ mfaRequired: true, challengeToken }` — exchange that at ' +
      'POST /auth/mfa/verify-login for the real session.',
    responses: {
      200: {
        description: 'Logged in, or an MFA challenge was issued.',
        ...j({
          oneOf: [
            { type: 'object', properties: { user: ref('User'), token: { type: 'string' }, expiresIn: { type: 'string' } } },
            { type: 'object', properties: { mfaRequired: { type: 'boolean' }, challengeToken: { type: 'string' } } },
          ],
        }),
      },
      401: { description: 'Invalid credentials.', ...j(ref('Error')) },
      403: { description: 'Account suspended.', ...j(ref('Error')) },
    },
  },
  'POST /api/auth/refresh': {
    summary: 'Rotate the refresh session for a new access token',
    description:
      'Reads the `mb_refresh` HttpOnly cookie (not a request body) and returns a new access token, ' +
      'rotating the refresh session. In production, requires the request Origin/Referer to match ' +
      'CLIENT_URL (CSRF hardening for this cookie-authenticated endpoint).',
    responses: {
      200: { description: 'New access token issued.', ...j({ type: 'object', properties: { token: { type: 'string' }, expiresIn: { type: 'string' } } }) },
      401: { description: 'Missing, invalid, expired, or revoked refresh session.', ...j(ref('Error')) },
      403: { description: 'Request origin not allowed.', ...j(ref('Error')) },
    },
  },
  'GET /api/auth/me': {
    summary: 'Get the current user',
    responses: { 200: { description: 'The authenticated user.', ...j({ type: 'object', properties: { user: ref('User') } }) } },
  },
  'POST /api/auth/logout': {
    summary: 'Revoke the current session',
    description: 'Revokes the refresh session behind the current access token and clears the refresh cookie.',
    responses: { 200: { description: 'Logged out.', ...j({ type: 'object' }) } },
  },

  // ----------------------------------------------------------- LISTINGS --
  'GET /api/listings': {
    summary: 'List active listings (paginated, filterable)',
    description: 'Works without authentication. Optionally authenticated to personalize results.',
    parameters: [
      { name: 'category', in: 'query', schema: { type: 'string', enum: ['AGRICULTURAL', 'PRODUCT', 'DIGITAL'] } },
      { name: 'region', in: 'query', schema: { type: 'string' } },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'limit', in: 'query', schema: { type: 'integer' } },
    ],
    responses: { 200: { description: 'Paginated listings.', ...j({ type: 'object', properties: { listings: { type: 'array', items: ref('Listing') } } }) } },
  },
  'GET /api/listings/search': {
    summary: 'Full-text / filtered listing search',
    responses: { 200: { description: 'Matching listings.', ...j({ type: 'object', properties: { listings: { type: 'array', items: ref('Listing') }, total: { type: 'integer' } } }) } },
  },
  'GET /api/listings/{id}': {
    summary: 'Get a single listing',
    responses: {
      200: { description: 'The listing, with seller summary.', ...j({ type: 'object', properties: { listing: { allOf: [ref('Listing'), { type: 'object', properties: { seller: { type: 'object' } } }] } } }) },
      404: { description: 'Listing not found.', ...j(ref('Error')) },
    },
  },
  'POST /api/listings': {
    summary: 'Create a listing',
    description: 'Requires the SELLER role.',
    responses: {
      201: { description: 'Listing created.', ...j({ type: 'object', properties: { listing: ref('Listing') } }) },
      400: { description: 'Validation failed.', ...j(ref('Error')) },
    },
  },

  // ------------------------------------------------------------- OFFERS --
  'POST /api/offers': {
    summary: 'Make (or counter) an offer on a listing',
    description:
      'Requires the BUYER role for a new offer. Enforces listing availability, minimum quantity, and ' +
      'any pickup-window/negotiation-window constraints on the listing.',
    responses: {
      201: { description: 'Offer created.', ...j({ type: 'object', properties: { message: { type: 'string' }, offer: ref('Offer') } }) },
      400: { description: 'Validation failed, or invalid quantity.', ...j(ref('Error')) },
      404: { description: 'Listing not found.', ...j(ref('Error')) },
      409: { description: 'No quantity remains, or the negotiation/pickup window has closed.', ...j(ref('Error')) },
    },
  },
  'GET /api/offers/mine': {
    summary: "List the current user's offers (as buyer or seller)",
    responses: { 200: { description: 'Offers.', ...j({ type: 'object', properties: { offers: { type: 'array', items: ref('Offer') } } }) } },
  },

  // ------------------------------------------------------------- ORDERS --
  'POST /api/orders/buy-now': {
    summary: 'Buy a listing directly at its asking price',
    description:
      'Requires the BUYER role. Supports the `Idempotency-Key` header (or `idempotencyKey` body field) ' +
      'via the idempotency middleware — retrying with the same key returns the original order rather than ' +
      'creating a duplicate. Creates an Order in PENDING_PAYMENT with a payment deadline.',
    responses: {
      201: {
        description: 'Order created; payment still required.',
        ...j({ type: 'object', properties: { message: { type: 'string' }, order: ref('Order'), paymentConfirmed: { type: 'boolean' } } }),
      },
      400: { description: 'listingId missing, or listing not purchasable.', ...j(ref('Error')) },
      403: { description: 'Only buyers can purchase listings.', ...j(ref('Error')) },
    },
  },
  'GET /api/orders': {
    summary: "List the current user's orders (as buyer or seller)",
    responses: { 200: { description: 'Orders.', ...j({ type: 'object', properties: { orders: { type: 'array', items: ref('Order') }, count: { type: 'integer' } } }) } },
  },
  'GET /api/orders/{id}': {
    summary: 'Get a single order',
    responses: {
      200: { description: 'The order.', ...j({ type: 'object', properties: { order: ref('Order') } }) },
      404: { description: 'Order not found.', ...j(ref('Error')) },
    },
  },

  // ----------------------------------------------------------- PAYMENTS --
  'GET /api/payments/methods': {
    summary: 'List available payment methods',
    responses: { 200: { description: 'Supported methods.', ...j({ type: 'object', properties: { methods: { type: 'array', items: { type: 'string', enum: ['TELEBIRR', 'CBE', 'QR', 'OTHER'] } } } }) } },
  },
  'POST /api/payments': {
    summary: 'Create a payment (intent) for an order, transport job, digital product, ad, or inspection',
    description:
      'Supports the `Idempotency-Key` header — replaying the same key for the same caller returns the ' +
      'original payment (200) instead of creating a second one; a different caller reusing the key gets 409.',
    responses: {
      201: { description: 'Payment created.', ...j({ type: 'object', properties: { payment: ref('Payment') } }) },
      200: { description: 'Idempotent replay — the original payment for this key.', ...j({ type: 'object', properties: { payment: ref('Payment') } }) },
      400: { description: 'Validation failed.', ...j(ref('Error')) },
      409: { description: 'Idempotency-Key already used by a different request, or an active payment already exists.', ...j(ref('Error')) },
    },
  },
  'GET /api/payments/{id}': {
    summary: 'Get a single payment',
    responses: { 200: { description: 'The payment.', ...j({ type: 'object', properties: { payment: ref('Payment') } }) }, 404: { description: 'Payment not found.', ...j(ref('Error')) } },
  },

  // ------------------------------------------------------- DIGITAL PRODUCTS --
  'GET /api/digital-products': {
    summary: 'List active digital products',
    responses: { 200: { description: 'Digital products.', ...j({ type: 'object', properties: { products: { type: 'array', items: ref('DigitalProduct') } } }) } },
  },
  'POST /api/digital-products': {
    summary: 'List a new digital product for sale',
    description: 'Requires the SELLER role.',
    responses: { 201: { description: 'Product created.', ...j({ type: 'object', properties: { product: ref('DigitalProduct') } }) } },
  },
  'POST /api/digital-products/{id}/purchase': {
    summary: 'Purchase a digital product',
    description: 'Requires the BUYER role. Creates a Payment; the download link unlocks once payment is confirmed.',
    responses: { 201: { description: 'Purchase initiated.', ...j({ type: 'object' }) } },
  },

  // ---------------------------------------------------------- INSPECTIONS --
  'POST /api/inspections': {
    summary: 'Request an inspection for a listing',
    responses: { 201: { description: 'Inspection request created.', ...j({ type: 'object', properties: { request: ref('InspectionRequest') } }) } },
  },

  // ------------------------------------------------------------ TRANSPORT --
  'POST /api/transport': {
    summary: 'Arrange transport for an order',
    responses: { 201: { description: 'Transport job created.', ...j({ type: 'object', properties: { job: ref('TransportJob') } }) } },
  },

  // ------------------------------------------------------------- RATINGS --
  'POST /api/ratings': {
    summary: 'Rate a counterparty on a completed order',
    responses: { 201: { description: 'Rating recorded.', ...j({ type: 'object', properties: { rating: ref('Rating') } }) } },
  },

  // ------------------------------------------------------------ MESSAGES --
  'POST /api/messages': {
    summary: 'Send a message to another user (optionally scoped to an order)',
    responses: { 201: { description: 'Message sent.', ...j({ type: 'object', properties: { message: ref('Message') } }) } },
  },

  // ------------------------------------------------------------ DISPUTES --
  'POST /api/disputes': {
    summary: 'Raise a dispute on an order',
    responses: { 201: { description: 'Dispute created.', ...j({ type: 'object', properties: { dispute: ref('Dispute') } }) } },
  },
};
