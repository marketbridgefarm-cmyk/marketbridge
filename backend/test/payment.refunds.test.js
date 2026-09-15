'use strict';

// Refund lifecycle tests — opt-in, require a disposable PostgreSQL
// database (same convention as test/payment.financial.test.js and
// test/marketplace.e2e.test.js — see test/README.md).
//
// These exist specifically as regression coverage for a bug found during
// a production-readiness review: paymentRefundService.js called
// `assertTransition` in requestRefund, completeRefund AND failRefund
// without ever importing it — every refund attempt (auto order-expiry
// refunds, ad-cancellation refunds, and both admin refund actions) threw
// `ReferenceError: assertTransition is not defined` at runtime. A second,
// related bug: prisma/schema.prisma's PaymentStatus enum was missing
// PROCESSING and REFUND_PENDING even though a migration had already added
// them to the database, so `requestRefund`'s own
// `payment.update({ status: 'REFUND_PENDING' })` would have failed
// Prisma's client-side enum validation even with the import fixed. Both
// are fixed; this suite exercises the full lifecycle end to end so a
// regression here fails CI instead of failing silently in production.
//
// Run with:
//   MARKETBRIDGE_E2E=1 E2E_DATABASE_URL='postgresql://...' npx prisma migrate deploy
//   MARKETBRIDGE_E2E=1 E2E_DATABASE_URL='postgresql://...' npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.MARKETBRIDGE_E2E === '1' && process.env.E2E_DATABASE_URL;

test('refund lifecycle suite is explicitly opt-in', { skip: !enabled }, async () => {
  assert.ok(process.env.E2E_DATABASE_URL);
});

if (enabled) {
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  test('refund lifecycle: request -> complete, duplicate requests are idempotent', async (t) => {
    const prisma = require('../src/config/db');
    const bcrypt = require('bcryptjs');
    const { requestRefund, completeRefund } = require('../src/services/paymentRefundService');

    const buyer = await prisma.user.create({
      data: {
        name: 'Refund Test Buyer',
        email: `refund-buyer-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('Password123!', 10),
        roles: ['BUYER'],
      },
    });

    const payment = await prisma.payment.create({
      data: {
        type: 'MARKETPLACE',
        amount: '1000.00',
        currency: 'ETB',
        method: 'TELEBIRR',
        status: 'PAID',
        createdById: buyer.id,
      },
    });

    t.after(async () => {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: buyer.id } }).catch(() => {});
    });

    // requestRefund must not throw (regression: was ReferenceError before
    // the fix) and must actually move Payment.status to REFUND_PENDING —
    // a value that requires the corrected schema.prisma enum to accept.
    const refund = await prisma.$transaction((tx) =>
      requestRefund(tx, { paymentId: payment.id, requestedById: buyer.id, reason: 'Test refund' })
    );
    assert.equal(refund.status, 'REQUESTED');

    const afterRequest = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(afterRequest.status, 'REFUND_PENDING');

    // Duplicate request while one is already in flight must be idempotent:
    // same refund row back, no second PaymentRefund created.
    const duplicate = await prisma.$transaction((tx) =>
      requestRefund(tx, { paymentId: payment.id, requestedById: buyer.id, reason: 'Test refund again' })
    );
    assert.equal(duplicate.id, refund.id);

    const refundCount = await prisma.paymentRefund.count({ where: { paymentId: payment.id } });
    assert.equal(refundCount, 1);

    // Completing must not throw and must move both rows to their terminal
    // state.
    const completed = await prisma.$transaction((tx) =>
      completeRefund(tx, { refundId: refund.id, provider: 'CHAPA', providerRefundId: 'test-provider-ref' })
    );
    assert.equal(completed.status, 'COMPLETED');

    const afterComplete = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(afterComplete.status, 'REFUNDED');

    // Completing an already-completed refund is idempotent (returns the
    // same record, doesn't throw on the state-transition guard).
    const completedAgain = await prisma.$transaction((tx) =>
      completeRefund(tx, { refundId: refund.id })
    );
    assert.equal(completedAgain.status, 'COMPLETED');
  });

  test('refund lifecycle: provider failure allows retry via a fresh request', async (t) => {
    const prisma = require('../src/config/db');
    const bcrypt = require('bcryptjs');
    const { requestRefund, failRefund, completeRefund } = require('../src/services/paymentRefundService');

    const buyer = await prisma.user.create({
      data: {
        name: 'Refund Retry Buyer',
        email: `refund-retry-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('Password123!', 10),
        roles: ['BUYER'],
      },
    });

    const payment = await prisma.payment.create({
      data: {
        type: 'MARKETPLACE',
        amount: '500.00',
        currency: 'ETB',
        method: 'TELEBIRR',
        status: 'PAID',
        createdById: buyer.id,
      },
    });

    t.after(async () => {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: buyer.id } }).catch(() => {});
    });

    const refund = await prisma.$transaction((tx) =>
      requestRefund(tx, { paymentId: payment.id, requestedById: buyer.id })
    );

    // failRefund must not throw (regression: previously referenced an
    // undefined `payment` variable) and must leave Payment.status
    // untouched so a retry is possible.
    const failed = await prisma.$transaction((tx) =>
      failRefund(tx, { refundId: refund.id, failureReason: 'Provider timeout' })
    );
    assert.equal(failed.status, 'FAILED');

    const afterFail = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(afterFail.status, 'REFUND_PENDING');

    // A fresh requestRefund after a FAILED refund creates a new refund
    // request rather than being blocked by the dead one.
    const retryRefund = await prisma.$transaction((tx) =>
      requestRefund(tx, { paymentId: payment.id, requestedById: buyer.id })
    );
    assert.notEqual(retryRefund.id, refund.id);

    const completed = await prisma.$transaction((tx) =>
      completeRefund(tx, { refundId: retryRefund.id })
    );
    assert.equal(completed.status, 'COMPLETED');
  });

  test('refund lifecycle: partial refunds are explicitly rejected (not yet supported)', async (t) => {
    const prisma = require('../src/config/db');
    const bcrypt = require('bcryptjs');
    const { requestRefund } = require('../src/services/paymentRefundService');

    const buyer = await prisma.user.create({
      data: {
        name: 'Refund Partial Buyer',
        email: `refund-partial-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('Password123!', 10),
        roles: ['BUYER'],
      },
    });

    const payment = await prisma.payment.create({
      data: {
        type: 'MARKETPLACE',
        amount: '1000.00',
        currency: 'ETB',
        method: 'TELEBIRR',
        status: 'PAID',
        createdById: buyer.id,
      },
    });

    t.after(async () => {
      await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: buyer.id } }).catch(() => {});
    });

    await assert.rejects(
      prisma.$transaction((tx) =>
        requestRefund(tx, { paymentId: payment.id, amount: 400, requestedById: buyer.id })
      ),
      /Only full refunds are currently supported/
    );
  });
}
