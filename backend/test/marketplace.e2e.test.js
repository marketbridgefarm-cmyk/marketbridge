'use strict';

/**
 * MarketBridge end-to-end transaction test.
 *
 * This suite intentionally uses Node's built-in fetch rather than adding a
 * test HTTP dependency. It exercises the real Express routes, Prisma client,
 * workflow services, authorization middleware, negotiation chains, payment
 * settlement logic, transport gates, evidence requirements, and receipt
 * completion.
 *
 * SAFETY:
 * The suite only runs when BOTH variables below are explicitly supplied:
 *
 *   MARKETBRIDGE_E2E=1
 *   E2E_DATABASE_URL=<dedicated disposable PostgreSQL database>
 *
 * Never point E2E_DATABASE_URL at production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.env.MARKETBRIDGE_E2E !== '1' || !process.env.E2E_DATABASE_URL) {
  test('MarketBridge marketplace E2E suite (opt-in)', {
    skip: 'Set MARKETBRIDGE_E2E=1 and E2E_DATABASE_URL to run against a disposable PostgreSQL database.',
  }, () => {});
} else {
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-only-secret-'.padEnd(40, 'x');
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.MARKETPLACE_COMMISSION_RATE = process.env.MARKETPLACE_COMMISSION_RATE || '0';
  process.env.INSPECTION_COMMISSION_RATE = process.env.INSPECTION_COMMISSION_RATE || '0';
  process.env.TRANSPORT_COMMISSION_RATE = process.env.TRANSPORT_COMMISSION_RATE || '0';

  const http = require('node:http');
  const app = require('../src/index');
  const prisma = require('../src/config/db');
  const { createPayment, settlePayment } = require('../src/services/paymentService');
  const { syncOrderPaymentObligations } = require('../src/services/paymentObligationService');

  let server;
  let baseUrl;
  const created = {
    userIds: [],
    listingId: null,
    offerIds: [],
    inspectionRequestId: null,
    inspectionQuoteIds: [],
    orderId: null,
    transportJobId: null,
    transportQuoteIds: [],
    truckId: null,
    paymentIds: [],
  };

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

  async function register({ name, email, roles }) {
    const result = await api('/api/auth/register', {
      method: 'POST',
      body: {
        name,
        email,
        password: 'E2E-password-123!',
        phone: '+251900000000',
        location: 'Addis Ababa',
        roles,
      },
    });

    assert.equal(result.status, 201, JSON.stringify(result.body));
    created.userIds.push(result.body.user.id);
    return result.body;
  }

  async function assertNotification(token, eventType) {
    const result = await api('/api/notifications?limit=50', { token });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const match = (result.body.notifications || []).find(
      (notification) => notification.metadata?.eventType === eventType && notification.orderId === created.orderId
    );
    assert.ok(match, `Expected ${eventType} notification for order ${created.orderId}`);
    return match;
  }

  async function settleOrderPayment({ orderId, type, amount, transportJobId, inspectionRequestId }) {
    const payment = await createPayment({
      orderId,
      type,
      amount,
      method: 'OTHER',
      createdById: created.userIds[1], // buyer
      transportJobId: transportJobId || undefined,
      inspectionRequestId: inspectionRequestId || undefined,
      reference: `E2E-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });

    created.paymentIds.push(payment.id);

    await settlePayment({
      paymentId: payment.id,
      status: 'PAID',
      provider: 'E2E_TEST_PROVIDER',
      providerTransactionId: `E2E-TX-${payment.id}`,
      eventId: `E2E-EVENT-${payment.id}`,
      payload: {
        amount: String(amount),
        currency: 'ETB',
      },
    });

    return payment;
  }

  async function cleanup() {
    // Delete in dependency order. All identifiers belong to this isolated
    // test run, so this cleanup never performs broad destructive deletes.
    if (created.transportJobId) {
      await prisma.transportEvidence.deleteMany({ where: { transportJobId: created.transportJobId } });
      await prisma.transportQuote.deleteMany({ where: { transportJobId: created.transportJobId } });
    }

    if (created.paymentIds.length) {
      // Payment owns the FK to PaymentObligation, so payments must be removed
      // before their obligations during cleanup. Ledger/event rows are
      // children of Payment and are removed first for explicitness.
      await prisma.paymentLedgerEntry.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
      await prisma.paymentEvent.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: created.paymentIds } } });
    }

    if (created.transportJobId) {
      await prisma.paymentObligation.deleteMany({ where: { transportJobId: created.transportJobId } });
      await prisma.transportJob.delete({ where: { id: created.transportJobId } }).catch(() => {});
    }

    if (created.orderId) {
      await prisma.paymentObligation.deleteMany({ where: { orderId: created.orderId } });
      await prisma.orderEvent.deleteMany({ where: { orderId: created.orderId } });
      await prisma.order.delete({ where: { id: created.orderId } }).catch(() => {});
    }

    if (created.inspectionRequestId) {
      const report = await prisma.inspectionReport.findUnique({ where: { requestId: created.inspectionRequestId } });
      if (report) {
        await prisma.inspectionEvidence.deleteMany({ where: { reportId: report.id } });
        await prisma.inspectionReport.delete({ where: { id: report.id } }).catch(() => {});
      }
      await prisma.inspectionQuote.deleteMany({ where: { inspectionRequestId: created.inspectionRequestId } });
      await prisma.paymentObligation.deleteMany({ where: { inspectionRequestId: created.inspectionRequestId } });
      await prisma.inspectionRequest.delete({ where: { id: created.inspectionRequestId } }).catch(() => {});
    }

    if (created.offerIds.length) {
      await prisma.offer.deleteMany({ where: { id: { in: created.offerIds } } });
    }

    if (created.listingId) {
      await prisma.advertisement.deleteMany({ where: { listingId: created.listingId } }).catch(() => {});
      await prisma.listing.delete({ where: { id: created.listingId } }).catch(() => {});
    }

    if (created.truckId) {
      await prisma.truck.delete({ where: { id: created.truckId } }).catch(() => {});
    }

    if (created.userIds.length) {
      await prisma.auditEvent.deleteMany({ where: { actorId: { in: created.userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    }
  }

  test.before(async () => {
    await prisma.$connect();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  test('full agricultural marketplace transaction completes end-to-end', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const seller = await register({
      name: 'E2E Seller',
      email: `seller-${suffix}@marketbridge.test`,
      roles: ['SELLER', 'BUYER'],
    });

    const buyer = await register({
      name: 'E2E Buyer',
      email: `buyer-${suffix}@marketbridge.test`,
      roles: ['BUYER', 'SELLER'],
    });

    const competingBuyer = await register({
      name: 'E2E Competing Buyer',
      email: `competing-buyer-${suffix}@marketbridge.test`,
      roles: ['BUYER'],
    });

    const inspector = await register({
      name: 'E2E Inspector',
      email: `inspector-${suffix}@marketbridge.test`,
      roles: ['INSPECTOR'],
    });

    const transporter = await register({
      name: 'E2E Transporter',
      email: `transporter-${suffix}@marketbridge.test`,
      roles: ['TRUCK_OWNER'],
    });

    const outsider = await register({
      name: 'E2E Outsider',
      email: `outsider-${suffix}@marketbridge.test`,
      roles: ['BUYER'],
    });

    // 1. Seller creates a perishable agricultural listing with a private
    // minimum acceptable price.
    const pickupStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pickupEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const listingResponse = await api('/api/listings', {
      token: seller.token,
      method: 'POST',
      body: {
        category: 'AGRICULTURAL',
        sellerId: seller.user.id,
        title: 'E2E Fresh Tomatoes',
        cropType: 'Tomato',
        quantity: 1000,
        unit: 'kg',
        askingPrice: 50000,
        minAcceptablePrice: 42000,
        location: 'Addis Ababa',
        pickupWindowStart: pickupStart,
        pickupWindowEnd: pickupEnd,
        description: 'End-to-end test produce',
      },
    });
    assert.equal(listingResponse.status, 201, JSON.stringify(listingResponse.body));
    created.listingId = listingResponse.body.listing.id;

    // Public response must not leak the seller's reservation price.
    const publicListing = await api(`/api/listings/${created.listingId}`);
    assert.equal(publicListing.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(publicListing.body.listing, 'minAcceptablePrice'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(publicListing.body.listing, 'photoKeys'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(publicListing.body.listing, 'offers'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(publicListing.body.listing, 'orders'), false);

    // 2. Buyer makes an offer; seller counters; buyer accepts.
    const offerResponse = await api('/api/offers', {
      token: buyer.token,
      method: 'POST',
      idempotencyKey: `e2e-offer-${suffix}`,
      body: {
        listingId: created.listingId,
        amount: 40000,
        quantity: 1000,
        message: 'Buyer initial offer',
      },
    });
    assert.equal(offerResponse.status, 201, JSON.stringify(offerResponse.body));
    const offerId = offerResponse.body.offer.id;
    created.offerIds.push(offerId);

    // A buyer bid must not close or hide the public produce listing. A second
    // buyer must still be able to enter the competition until the seller
    // accepts one of the competing negotiations.
    const publicListingAfterFirstOffer = await api(`/api/listings/${created.listingId}`);
    assert.equal(publicListingAfterFirstOffer.status, 200, JSON.stringify(publicListingAfterFirstOffer.body));
    assert.equal(publicListingAfterFirstOffer.body.listing.status, 'ACTIVE');

    const competingOfferResponse = await api('/api/offers', {
      token: competingBuyer.token,
      method: 'POST',
      idempotencyKey: `e2e-competing-offer-${suffix}`,
      body: {
        listingId: created.listingId,
        amount: 39000,
        quantity: 1,
        message: 'Competing buyer offer',
      },
    });
    assert.equal(competingOfferResponse.status, 201, JSON.stringify(competingOfferResponse.body));
    created.offerIds.push(competingOfferResponse.body.offer.id);

    const publicListingAfterCompetingOffer = await api(`/api/listings/${created.listingId}`);
    assert.equal(publicListingAfterCompetingOffer.status, 200, JSON.stringify(publicListingAfterCompetingOffer.body));
    assert.equal(publicListingAfterCompetingOffer.body.listing.status, 'ACTIVE');

    const selectResponse = await api(`/api/offers/${offerId}`, {
      token: seller.token,
      method: 'PATCH',
      idempotencyKey: `e2e-offer-select-${suffix}`,
      body: { action: 'SELECT' },
    });
    assert.equal(selectResponse.status, 200, JSON.stringify(selectResponse.body));
    assert.equal(selectResponse.body.offer.status, 'SELECTED');

    const counterResponse = await api(`/api/offers/${offerId}`, {
      token: seller.token,
      method: 'PATCH',
      idempotencyKey: `e2e-offer-counter-${suffix}`,
      body: { action: 'COUNTER', counterAmount: 45000, message: 'Seller counter' },
    });
    assert.equal(counterResponse.status, 201, JSON.stringify(counterResponse.body));
    const counterId = counterResponse.body.offer.id;
    created.offerIds.push(counterId);

    const acceptResponse = await api(`/api/offers/${counterId}`, {
      token: buyer.token,
      method: 'PATCH',
      idempotencyKey: `e2e-offer-accept-${suffix}`,
      body: { action: 'ACCEPT_COUNTER' },
    });
    assert.equal(acceptResponse.status, 200, JSON.stringify(acceptResponse.body));
    created.orderId = acceptResponse.body.order.id;
    assert.equal(acceptResponse.body.order.status, 'PENDING_PAYMENT');
    await assertNotification(seller.token, 'ORDER_CREATED');

    // 3. Outsider cannot view the private order workflow.
    const outsiderOrder = await api(`/api/orders/${created.orderId}`, { token: outsider.token });
    assert.equal(outsiderOrder.status, 403);

    // 4. Buyer requests an inspection; inspector quotes; buyer accepts.
    const inspectionRequestResponse = await api('/api/inspections', {
      token: buyer.token,
      method: 'POST',
      body: {
        orderId: created.orderId,
        listingId: created.listingId,
        mode: 'BUYER_REQUESTED',
      },
    });
    assert.equal(inspectionRequestResponse.status, 201, JSON.stringify(inspectionRequestResponse.body));
    created.inspectionRequestId = inspectionRequestResponse.body.request.id;

    const inspectionQuoteResponse = await api(`/api/inspections/${created.inspectionRequestId}/quote`, {
      token: inspector.token,
      method: 'POST',
      body: { amount: 1000, message: 'Inspection fee' },
    });
    assert.equal(inspectionQuoteResponse.status, 201, JSON.stringify(inspectionQuoteResponse.body));
    const inspectionQuoteId = inspectionQuoteResponse.body.quote.id;
    created.inspectionQuoteIds.push(inspectionQuoteId);

    const inspectionAcceptResponse = await api(
      `/api/inspections/${created.inspectionRequestId}/quotes/${inspectionQuoteId}/accept`,
      { token: buyer.token, method: 'PATCH' }
    );
    assert.equal(inspectionAcceptResponse.status, 200, JSON.stringify(inspectionAcceptResponse.body));

    const inspectionStartResponse = await api(`/api/inspections/${created.inspectionRequestId}/start`, {
      token: inspector.token,
      method: 'POST',
    });
    assert.equal(inspectionStartResponse.status, 200, JSON.stringify(inspectionStartResponse.body));

    const inspectionReportResponse = await api(`/api/inspections/${created.inspectionRequestId}/report`, {
      token: inspector.token,
      method: 'POST',
      body: {
        quantity: 995,
        grade: 'A',
        moisture: 8,
        visibleDefects: 'None significant',
        gpsLocation: '8.98,38.75',
        photos: ['e2e-inspection-photo'],
      },
    });
    assert.equal(inspectionReportResponse.status, 201, JSON.stringify(inspectionReportResponse.body));

    // 5. The server must reject a goods payment before the buyer decision.
    const prematurePayment = await api('/api/payments', {
      token: buyer.token,
      method: 'POST',
      idempotencyKey: `e2e-premature-marketplace-payment-${suffix}`,
      body: {
        type: 'MARKETPLACE',
        orderId: created.orderId,
        amount: 45000,
        method: 'OTHER',
      },
    });
    assert.equal(prematurePayment.status, 409, JSON.stringify(prematurePayment.body));
    assert.equal(prematurePayment.body.code, 'BUYER_DECISION_REQUIRED');

    // 6. Buyer must explicitly accept the inspected produce before any
    // marketplace/goods payment is allowed.
    const buyerDecision = await api(`/api/orders/${created.orderId}/buyer-decision`, {
      token: buyer.token,
      method: 'PATCH',
      idempotencyKey: `e2e-buyer-decision-${suffix}`,
      body: { decision: 'BUY' },
    });
    assert.equal(buyerDecision.status, 200, JSON.stringify(buyerDecision.body));
    assert.equal(buyerDecision.body.order.buyerDecision, 'BUY');

    // 7. Simulate authoritative payment-provider settlement for marketplace
    // and inspection obligations. This deliberately exercises paymentService
    // rather than pretending a PAID row is enough.
    await syncOrderPaymentObligations(prisma, created.orderId);
    await settleOrderPayment({
      orderId: created.orderId,
      type: 'MARKETPLACE',
      amount: 45000,
    });
    await settleOrderPayment({
      orderId: created.orderId,
      type: 'INSPECTOR',
      amount: 1000,
      inspectionRequestId: created.inspectionRequestId,
    });

    const orderAfterPayment = await prisma.order.findUnique({ where: { id: created.orderId } });
    assert.equal(orderAfterPayment.status, 'CONFIRMED');

    // 8. Buyer arranges hired transport.
    const transportJobResponse = await api('/api/transport', {
      token: buyer.token,
      method: 'POST',
      body: {
        orderId: created.orderId,
        arrangingParty: 'BUYER',
        method: 'HIRE_TRANSPORTER',
        pickupLocation: 'Addis Ababa Market',
        destination: 'Adama',
        load: '995 kg tomatoes',
        requiredCapacity: 2000,
      },
    });
    assert.equal(transportJobResponse.status, 201, JSON.stringify(transportJobResponse.body));
    created.transportJobId = transportJobResponse.body.transportJob.id;

    // Truck is a fixture because truck registration itself is not part of the
    // transaction under test.
    const truck = await prisma.truck.create({
      data: {
        ownerId: transporter.user.id,
        registration: `E2E-${suffix}`,
        truckType: 'Refrigerated',
        capacity: 2000,
        operatingArea: 'Addis Ababa / Adama',
        availability: 'AVAILABLE',
      },
    });
    created.truckId = truck.id;

    const transportQuoteResponse = await api(`/api/transport/${created.transportJobId}/quotes`, {
      token: transporter.token,
      method: 'POST',
      idempotencyKey: `e2e-transport-quote-${suffix}`,
      body: {
        amount: 5000,
        truckId: truck.id,
        message: 'Transport quote',
      },
    });
    assert.equal(transportQuoteResponse.status, 201, JSON.stringify(transportQuoteResponse.body));
    const transportQuoteId = transportQuoteResponse.body.quote.id;
    created.transportQuoteIds.push(transportQuoteId);

    const transportAcceptResponse = await api(`/api/transport/quotes/${transportQuoteId}`, {
      token: buyer.token,
      method: 'PATCH',
      idempotencyKey: `e2e-transport-accept-${suffix}`,
      body: { action: 'ACCEPT' },
    });
    assert.equal(transportAcceptResponse.status, 200, JSON.stringify(transportAcceptResponse.body));

    // 9. Simulate transport payment settlement.
    await syncOrderPaymentObligations(prisma, created.orderId);
    await settleOrderPayment({
      orderId: created.orderId,
      type: 'TRANSPORT',
      amount: 5000,
      transportJobId: created.transportJobId,
    });

    // 10. Transporter adds pickup evidence and moves the load through the
    // physical chain. The payment gate and evidence gate are exercised here.
    const pickupEvidence = await api(`/api/transport/${created.transportJobId}/evidence`, {
      token: transporter.token,
      method: 'POST',
      body: {
        type: 'PICKUP',
        photos: ['e2e-pickup-photo'],
        gpsLocation: '8.98,38.75',
        notes: 'Produce loaded and sealed',
      },
    });
    assert.equal(pickupEvidence.status, 201, JSON.stringify(pickupEvidence.body));

    const pickup = await api(`/api/transport/${created.transportJobId}/status`, {
      token: transporter.token,
      method: 'PATCH',
      body: { status: 'PICKUP' },
    });
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));

    const inTransit = await api(`/api/transport/${created.transportJobId}/status`, {
      token: transporter.token,
      method: 'PATCH',
      body: { status: 'IN_TRANSIT' },
    });
    assert.equal(inTransit.status, 200, JSON.stringify(inTransit.body));

    const unauthorizedDelivery = await api(`/api/transport/${created.transportJobId}/status`, {
      token: buyer.token,
      method: 'PATCH',
      body: { status: 'DELIVERED' },
    });
    assert.equal(unauthorizedDelivery.status, 403);

    const deliveryEvidence = await api(`/api/transport/${created.transportJobId}/evidence`, {
      token: transporter.token,
      method: 'POST',
      body: {
        type: 'DELIVERY',
        photos: ['e2e-delivery-photo'],
        gpsLocation: '8.54,39.27',
        notes: 'Goods delivered',
      },
    });
    assert.equal(deliveryEvidence.status, 201, JSON.stringify(deliveryEvidence.body));

    const delivered = await api(`/api/transport/${created.transportJobId}/status`, {
      token: transporter.token,
      method: 'PATCH',
      body: { status: 'DELIVERED' },
    });
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

    // 9. Buyer confirms receipt. This must complete the order only after all
    // required payments and transport delivery are satisfied.
    const receipt = await api(`/api/orders/${created.orderId}/confirm-receipt`, {
      token: buyer.token,
      method: 'PATCH',
      idempotencyKey: `e2e-receipt-${suffix}`,
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.equal(receipt.body.order.status, 'COMPLETED');
    const receiptNotification = await assertNotification(seller.token, 'RECEIPT_CONFIRMED');
    assert.equal(receiptNotification.readAt, null);

    // 10. Durable customer-facing event history exists for the journey.
    const events = await prisma.orderEvent.findMany({
      where: { orderId: created.orderId },
      orderBy: { createdAt: 'asc' },
    });
    const eventTypes = new Set(events.map((event) => event.type));
    assert.ok(eventTypes.has('ORDER_CREATED'));
    assert.ok(eventTypes.has('INSPECTION_STARTED'));
    assert.ok(eventTypes.has('INSPECTION_COMPLETED'));
    assert.ok(eventTypes.has('TRANSPORT_STATUS_CHANGED'));
    assert.ok(eventTypes.has('RECEIPT_CONFIRMED'));
  });
}
