'use strict';

/**
 * Concurrency regression tests for the marketplace sale invariant.
 *
 * Opt-in only:
 *   MARKETBRIDGE_E2E=1
 *   E2E_DATABASE_URL=<dedicated disposable PostgreSQL database>
 *
 * These tests deliberately issue simultaneous requests with different
 * idempotency keys. The database, rather than request timing, must decide
 * which buyer/offer wins.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
if (process.env.MARKETBRIDGE_E2E !== '1' || !process.env.E2E_DATABASE_URL) {
  test('MarketBridge concurrency E2E suite (opt-in)', {
    skip: 'Set MARKETBRIDGE_E2E=1 and E2E_DATABASE_URL to run against a disposable PostgreSQL database.',
  }, () => {});
} else {
  const jwt = require('jsonwebtoken');

  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-only-secret-'.padEnd(40, 'x');
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.MARKETPLACE_COMMISSION_RATE = '0';
  process.env.INSPECTION_COMMISSION_RATE = '0';
  process.env.TRANSPORT_COMMISSION_RATE = '0';

  const http = require('node:http');
  const app = require('../src/index');
  const prisma = require('../src/config/db');

  let server;
  let baseUrl;
  const created = {
    userIds: [],
    listingIds: [],
    offerIds: [],
    orderIds: [],
  };

  function tokenFor(user) {
    return jwt.sign(
      { sub: user.id, sid: `e2e-${user.id}` },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );
  }

  async function api(path, { token, method = 'GET', body, idempotencyKey } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { raw: text };
    }

    return { status: response.status, body: json };
  }

  async function makeUser(label) {
    const user = await prisma.user.create({
      data: {
        name: `Concurrency ${label}`,
        email: `concurrency-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@marketbridge.test`,
        passwordHash: 'not-used-by-this-test',
        roles: ['BUYER', 'SELLER'],
      },
    });
    created.userIds.push(user.id);
    return user;
  }

  async function cleanup() {
    await prisma.idempotencyRequest.deleteMany({ where: { userId: { in: created.userIds } } }).catch(() => {});

    if (created.orderIds.length) {
      await prisma.paymentObligation.deleteMany({ where: { orderId: { in: created.orderIds } } }).catch(() => {});
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: created.orderIds } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } }).catch(() => {});
    }

    if (created.offerIds.length) {
      await prisma.offer.deleteMany({ where: { id: { in: created.offerIds } } }).catch(() => {});
    }

    if (created.listingIds.length) {
      await prisma.listing.deleteMany({ where: { id: { in: created.listingIds } } }).catch(() => {});
    }

    if (created.userIds.length) {
      await prisma.auditEvent.deleteMany({ where: { actorId: { in: created.userIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: created.userIds } } }).catch(() => {});
    }
  }

  test.before(async () => {
    await prisma.$connect();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  test('concurrent Buy Now requests create exactly one order', async () => {
    const seller = await makeUser('buy-now-seller');
    const buyerA = await makeUser('buy-now-a');
    const buyerB = await makeUser('buy-now-b');

    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.id,
        category: 'PRODUCT',
        title: 'Concurrency Product',
        quantity: 10,
        unit: 'kg',
        askingPrice: 100,
        location: 'Addis Ababa',
        photos: [],
        videos: [],
        status: 'ACTIVE',
      },
    });
    created.listingIds.push(listing.id);

    const [a, b] = await Promise.all([
      api('/api/orders/buy-now', {
        method: 'POST',
        token: tokenFor(buyerA),
        body: { listingId: listing.id },
        idempotencyKey: `buy-now-a-${listing.id}`,
      }),
      api('/api/orders/buy-now', {
        method: 'POST',
        token: tokenFor(buyerB),
        body: { listingId: listing.id },
        idempotencyKey: `buy-now-b-${listing.id}`,
      }),
    ]);

    const results = [a, b];
    const successes = results.filter((result) => result.status === 201);
    const conflicts = results.filter((result) => result.status === 409);

    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(conflicts.length, 1, JSON.stringify(results));

    const orders = await prisma.order.findMany({ where: { listingId: listing.id } });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, 'PENDING_PAYMENT');

    const storedListing = await prisma.listing.findUnique({ where: { id: listing.id } });
    assert.equal(storedListing.status, 'SOLD');

    created.orderIds.push(orders[0].id);
  });

  test('concurrent acceptance of competing offers creates exactly one order', async () => {
    const seller = await makeUser('offer-seller');
    const buyerA = await makeUser('offer-a');
    const buyerB = await makeUser('offer-b');

    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.id,
        category: 'AGRICULTURAL',
        title: 'Concurrency Produce',
        cropType: 'Tomato',
        quantity: 100,
        unit: 'kg',
        askingPrice: 1000,
        minAcceptablePrice: 700,
        location: 'Addis Ababa',
        photos: [],
        videos: [],
        status: 'UNDER_NEGOTIATION',
      },
    });
    created.listingIds.push(listing.id);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const [offerA, offerB] = await Promise.all([
      prisma.offer.create({
        data: {
          listingId: listing.id,
          buyerId: buyerA.id,
          sellerId: seller.id,
          amount: 800,
          quantity: 50,
          status: 'COUNTERED',
          counterAmount: 850,
          counteredBy: 'SELLER',
          expiresAt,
        },
      }),
      prisma.offer.create({
        data: {
          listingId: listing.id,
          buyerId: buyerB.id,
          sellerId: seller.id,
          amount: 780,
          quantity: 50,
          status: 'COUNTERED',
          counterAmount: 830,
          counteredBy: 'SELLER',
          expiresAt,
        },
      }),
    ]);
    created.offerIds.push(offerA.id, offerB.id);

    const [a, b] = await Promise.all([
      api(`/api/offers/${offerA.id}`, {
        method: 'PATCH',
        token: tokenFor(buyerA),
        body: { action: 'ACCEPT_COUNTER' },
        idempotencyKey: `accept-a-${offerA.id}`,
      }),
      api(`/api/offers/${offerB.id}`, {
        method: 'PATCH',
        token: tokenFor(buyerB),
        body: { action: 'ACCEPT_COUNTER' },
        idempotencyKey: `accept-b-${offerB.id}`,
      }),
    ]);

    const results = [a, b];
    const successes = results.filter((result) => result.status === 200);
    const conflicts = results.filter((result) => result.status === 409);

    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(conflicts.length, 1, JSON.stringify(results));

    const orders = await prisma.order.findMany({ where: { listingId: listing.id } });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, 'PENDING_PAYMENT');

    const offers = await prisma.offer.findMany({ where: { listingId: listing.id } });
    assert.equal(offers.filter((offer) => offer.status === 'ACCEPTED').length, 1);
    assert.equal(offers.filter((offer) => offer.status === 'REJECTED').length, 1);

    const storedListing = await prisma.listing.findUnique({ where: { id: listing.id } });
    assert.equal(storedListing.status, 'SOLD');

    created.orderIds.push(orders[0].id);
  });
}
