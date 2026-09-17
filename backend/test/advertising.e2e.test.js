'use strict';

/**
 * Advertising system end-to-end test.
 *
 * Advertising is a direct platform revenue source (see routes/ads.js,
 * services/paymentService.js's ADVERTISING branch, and
 * services/maintenanceService.js), but until now it had zero automated
 * coverage. This suite exercises the full campaign lifecycle end to end:
 * quote -> create -> pay -> (auto-publish | moderation) -> serve -> track
 * -> expire, across both the non-moderated listing-boost types and the
 * moderated BANNER type.
 *
 * It also pins down a real regression: a campaign paid for ahead of its
 * start date is left at SCHEDULED by paymentService.settlePayment. Once
 * the campaign's window actually opens, GET /ads/active, the admin
 * overview count, and withComputedStatus() all correctly treat that row
 * as live — but nothing ever flipped the *stored* status to PUBLISHED,
 * and POST /ads/:id/events (impression/click tracking) only accepted
 * ACTIVE/PUBLISHED. Net effect: any campaign scheduled ahead of time (the
 * dashboard's own default) recorded zero impressions/clicks for its
 * entire run. See the "records events for a live-but-still-SCHEDULED
 * campaign" assertion below and services/maintenanceService.js's
 * activateScheduledAdvertisements().
 *
 * Opt-in only:
 *   MARKETBRIDGE_E2E=1
 *   E2E_DATABASE_URL=<dedicated disposable PostgreSQL database>
 *
 * Never point E2E_DATABASE_URL at production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.env.MARKETBRIDGE_E2E !== '1' || !process.env.E2E_DATABASE_URL) {
  test('MarketBridge advertising E2E suite (opt-in)', {
    skip: 'Set MARKETBRIDGE_E2E=1 and E2E_DATABASE_URL to run against a disposable PostgreSQL database.',
  }, () => {});
} else {
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-only-secret-'.padEnd(40, 'x');
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ADVERTISING_COMMISSION_RATE = process.env.ADVERTISING_COMMISSION_RATE || '0';

  const jwt = require('jsonwebtoken');
  const http = require('node:http');
  const app = require('../src/index');
  const prisma = require('../src/config/db');
  const { createPayment, settlePayment } = require('../src/services/paymentService');
  const { activateScheduledAdvertisements, expireAdvertisements } = require('../src/services/maintenanceService');
  const { createRefreshSession, newSessionId } = require('../src/services/refreshSessionService');
  const { quotePrice } = require('../src/utils/adPricing');

  let server;
  let baseUrl;
  const created = {
    userIds: [],
    listingId: null,
    advertisementIds: [],
    paymentIds: [],
  };

  async function api(path, { token, method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

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

  async function register({ name, email }) {
    const result = await api('/api/auth/register', {
      method: 'POST',
      body: {
        name,
        email,
        password: 'E2E-password-123!',
        phone: '+251900000000',
        location: 'Addis Ababa',
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    created.userIds.push(result.body.user.id);
    return result.body;
  }

  // Admin can't self-register (ADMIN is not an allowed registration role —
  // see OPTIONAL_ROLES in routes/auth.js), so build the row and a real,
  // DB-backed session directly, the same way routes/auth.js's issueSession
  // does it, so middleware/auth.js's session-revocation check passes.
  async function makeAdmin() {
    const user = await prisma.user.create({
      data: {
        name: 'Advertising E2E Admin',
        email: `advertising-admin-${Date.now()}-${Math.random().toString(16).slice(2)}@marketbridge.test`,
        passwordHash: 'not-used-by-this-test',
        roles: ['ADMIN'],
      },
    });
    created.userIds.push(user.id);
    const sessionId = newSessionId();
    await createRefreshSession(prisma, { userId: user.id, sessionId, refreshToken: `e2e-admin-refresh-${sessionId}` });
    const token = jwt.sign({ sub: user.id, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
    return { user, token };
  }

  async function payForAd({ advertisement, amount, createdById }) {
    const payment = await createPayment({
      advertisementId: advertisement.id,
      type: 'ADVERTISING',
      amount,
      method: 'OTHER',
      createdById,
      reference: `E2E-AD-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    created.paymentIds.push(payment.id);

    await settlePayment({
      paymentId: payment.id,
      status: 'PAID',
      provider: 'E2E_TEST_PROVIDER',
      providerTransactionId: `E2E-TX-${payment.id}`,
      eventId: `E2E-EVENT-${payment.id}`,
      payload: { amount: String(amount), currency: 'ETB' },
    });

    return payment;
  }

  async function cleanup() {
    if (created.advertisementIds.length) {
      await prisma.advertisementEvent.deleteMany({ where: { advertisementId: { in: created.advertisementIds } } }).catch(() => {});
    }
    if (created.paymentIds.length) {
      await prisma.paymentLedgerEntry.deleteMany({ where: { paymentId: { in: created.paymentIds } } }).catch(() => {});
      await prisma.paymentEvent.deleteMany({ where: { paymentId: { in: created.paymentIds } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { id: { in: created.paymentIds } } }).catch(() => {});
    }
    if (created.advertisementIds.length) {
      await prisma.advertisement.deleteMany({ where: { id: { in: created.advertisementIds } } }).catch(() => {});
    }
    if (created.listingId) {
      await prisma.listing.delete({ where: { id: created.listingId } }).catch(() => {});
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

  test('non-moderated listing campaign: quote, pay, stay scheduled, then serve/track/publish once its window opens', async () => {
    const { user: seller, token: sellerToken } = await register({
      name: 'Ad E2E Seller',
      email: `ad-e2e-seller-${Date.now()}@marketbridge.test`,
    });

    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.id,
        category: 'PRODUCT',
        title: 'Advertising E2E Product',
        quantity: 10,
        availableQuantity: 10,
        unit: 'kg',
        askingPrice: 100,
        location: 'Addis Ababa',
        photos: [],
        videos: [],
        status: 'ACTIVE',
      },
    });
    created.listingId = listing.id;

    // Deliberately scheduled two days out, mirroring the dashboard's own
    // default (todayPlus(1)) — this is the common case, not an edge case.
    const startDate = new Date(Date.now() + 2 * 86400000);
    const endDate = new Date(Date.now() + 9 * 86400000); // 7-day campaign

    const createResult = await api('/api/ads', {
      method: 'POST',
      token: sellerToken,
      body: {
        type: 'FEATURED_LISTING',
        listingId: listing.id,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    });
    assert.equal(createResult.status, 201, JSON.stringify(createResult.body));
    const ad = createResult.body.ad;
    created.advertisementIds.push(ad.id);
    assert.equal(ad.status, 'PENDING_PAYMENT');

    const expectedPrice = quotePrice('FEATURED_LISTING', startDate, endDate);
    assert.equal(Number(ad.priceQuoted), expectedPrice);

    // Wrong amount must be rejected before any money moves.
    const badPayment = await api('/api/payments', {
      method: 'POST',
      token: sellerToken,
      body: { type: 'ADVERTISING', advertisementId: ad.id, amount: expectedPrice + 1, method: 'TELEBIRR' },
    });
    assert.equal(badPayment.status, 400, JSON.stringify(badPayment.body));

    await payForAd({ advertisement: ad, amount: expectedPrice, createdById: seller.id });

    let stored = await prisma.advertisement.findUnique({ where: { id: ad.id } });
    assert.equal(stored.status, 'SCHEDULED', 'listing-boost campaigns paid ahead of their start date should be SCHEDULED, not live yet');
    assert.equal(Number(stored.amountPaid), expectedPrice);

    // Not live yet: tracking must be refused before the window opens.
    const tooEarly = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(tooEarly.status, 404, JSON.stringify(tooEarly.body));

    // Simulate real time passing without the maintenance cycle having run
    // yet: the campaign's window has genuinely opened, but the row is
    // still exactly what settlePayment left it as (SCHEDULED).
    await prisma.advertisement.update({
      where: { id: ad.id },
      data: { startDate: new Date(Date.now() - 3600000), endDate: new Date(Date.now() + 6 * 86400000) },
    });

    stored = await prisma.advertisement.findUnique({ where: { id: ad.id } });
    assert.equal(stored.status, 'SCHEDULED', 'row should not silently change on its own');

    // Regression check: this is the bug. A campaign that is genuinely live
    // (per GET /ads/active's own criteria) must accept impression/click
    // events even while the stored status still says SCHEDULED.
    const impressionWhileScheduled = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(impressionWhileScheduled.status, 204, JSON.stringify(impressionWhileScheduled.body));

    const clickWhileScheduled = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'CLICK' } });
    assert.equal(clickWhileScheduled.status, 204, JSON.stringify(clickWhileScheduled.body));

    const activeList = await api('/api/ads/active');
    assert.equal(activeList.status, 200, JSON.stringify(activeList.body));
    const activeEntry = (activeList.body.ads || []).find((a) => a.id === ad.id);
    assert.ok(activeEntry, 'live campaign should appear in GET /ads/active');
    assert.equal(activeEntry.status, 'PUBLISHED', 'GET /ads/active should compute PUBLISHED for a live SCHEDULED row');

    const analyticsBefore = await api(`/api/ads/${ad.id}/analytics`, { token: sellerToken });
    assert.equal(analyticsBefore.status, 200, JSON.stringify(analyticsBefore.body));
    assert.equal(analyticsBefore.body.impressions, 1);
    assert.equal(analyticsBefore.body.clicks, 1);
    assert.equal(analyticsBefore.body.ctr, 100);

    // Now run the maintenance job and confirm the stored row converges to
    // reality instead of staying SCHEDULED for its whole run.
    const activation = await activateScheduledAdvertisements(new Date());
    assert.ok(activation.activated >= 1, JSON.stringify(activation));

    stored = await prisma.advertisement.findUnique({ where: { id: ad.id } });
    assert.equal(stored.status, 'PUBLISHED');
    assert.ok(stored.publishedAt);

    // And tracking still works once genuinely PUBLISHED, not just while
    // SCHEDULED-but-live.
    const impressionAfterPublish = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(impressionAfterPublish.status, 204, JSON.stringify(impressionAfterPublish.body));

    const analyticsAfter = await api(`/api/ads/${ad.id}/analytics`, { token: sellerToken });
    assert.equal(analyticsAfter.body.impressions, 2);
    assert.equal(analyticsAfter.body.clicks, 1);

    // Finally, confirm the expiry job still ends the campaign correctly.
    await prisma.advertisement.update({ where: { id: ad.id }, data: { endDate: new Date(Date.now() - 1000) } });
    const expiry = await expireAdvertisements(new Date());
    assert.ok(expiry.expired >= 1, JSON.stringify(expiry));
    stored = await prisma.advertisement.findUnique({ where: { id: ad.id } });
    assert.equal(stored.status, 'EXPIRED');

    const eventAfterExpiry = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(eventAfterExpiry.status, 404, JSON.stringify(eventAfterExpiry.body));
  });

  test('BANNER campaign requires admin moderation even after payment and even if its window already opened', async () => {
    const { user: advertiser, token: advertiserToken } = await register({
      name: 'Ad E2E Banner Advertiser',
      email: `ad-e2e-banner-${Date.now()}@marketbridge.test`,
    });
    const { token: adminToken } = await makeAdmin();

    const startDate = new Date(Date.now() - 3600000); // already open
    const endDate = new Date(Date.now() + 5 * 86400000);
    const priceQuoted = quotePrice('BANNER', startDate, endDate);

    const ad = await prisma.advertisement.create({
      data: {
        advertiserId: advertiser.id,
        type: 'BANNER',
        status: 'PENDING_PAYMENT',
        startDate,
        endDate,
        priceQuoted,
        currency: 'ETB',
        campaignReference: `MB-AD-E2E-${Date.now()}-${Math.random().toString(16).slice(2).toUpperCase()}`,
        headline: 'E2E banner headline',
        bannerTemplate: 'CLASSIC',
      },
    });
    created.advertisementIds.push(ad.id);

    await payForAd({ advertisement: ad, amount: priceQuoted, createdById: advertiser.id });

    let stored = await prisma.advertisement.findUnique({ where: { id: ad.id } });
    assert.equal(stored.status, 'PAID_PENDING_REVIEW', 'BANNER must wait for moderation even though its window already opened');

    // Paid but unreviewed: must not be live.
    const beforeApproval = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(beforeApproval.status, 404, JSON.stringify(beforeApproval.body));

    const nonAdminApproval = await api(`/api/ads/${ad.id}/status`, {
      method: 'PATCH',
      token: advertiserToken,
      body: { status: 'APPROVED' },
    });
    assert.equal(nonAdminApproval.status, 403, JSON.stringify(nonAdminApproval.body));

    const approval = await api(`/api/ads/${ad.id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'APPROVED' },
    });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    // Its window already opened, so approval should publish it immediately
    // rather than leave it SCHEDULED.
    assert.equal(approval.body.ad.status, 'PUBLISHED');
    assert.ok(approval.body.ad.publishedAt);

    const afterApproval = await api(`/api/ads/${ad.id}/events`, { method: 'POST', body: { eventType: 'IMPRESSION' } });
    assert.equal(afterApproval.status, 204, JSON.stringify(afterApproval.body));
  });
}
