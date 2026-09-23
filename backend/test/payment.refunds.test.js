'use strict';

// Refund lifecycle tests — opt-in, require a disposable PostgreSQL
// database (same convention as test/payment.financial.test.js and
// test/marketplace.e2e.test.js — see test/README.md).
//
// These exist as regression coverage for the refund lifecycle end to end:
// requestRefund (DB-only) -> processRefund (submits to Chapa) ->
// verifyAndFinalizeRefund (polls Chapa and completes/fails) -> retryRefund
// (reopens a fresh request after a FAILED attempt). Chapa's HTTP endpoint
// itself is stubbed via global.fetch, the same way test/chapa.refunds.test.js
// stubs it, so this suite never makes a real network call.
//
// This file previously exercised a `completeRefund(tx, {...})` /
// `failRefund(tx, {...})` API that paymentRefundService.js no longer
// exports — the service was refactored so the Chapa network call happens
// outside any DB transaction (processRefund claims PROCESSING, calls
// Chapa, then persists the result), and failRefund/verifyAndFinalizeRefund
// now manage their own transactions internally rather than taking one in.
// This rewrite follows that current shape so a real regression here fails
// CI instead of the suite silently testing dead code.
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

  // Stubs global.fetch for the duration of `fn`, always restoring it
  // afterwards even if `fn` throws — Chapa's API is the only thing this
  // suite talks to over HTTP, so intercepting fetch is enough to control
  // every response processRefund/verifyAndFinalizeRefund will see.
  // Each entry is either a plain body object (200 OK) or { status, body }
  // to simulate an HTTP error status, e.g. Chapa rejecting a bad tx_ref.
  async function withStubbedChapa(responses, fn) {
    const originalFetch = global.fetch;
    const originalKey = process.env.CHAPA_SECRET_KEY;
    process.env.CHAPA_SECRET_KEY = 'CHASECK_TEST-refund-lifecycle';
    let call = 0;
    global.fetch = async () => {
      const entry = responses[Math.min(call, responses.length - 1)];
      call += 1;
      const { status = 200, body } = Object.prototype.hasOwnProperty.call(entry, 'body') ? entry : { body: entry };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    try {
      return await fn();
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.CHAPA_SECRET_KEY;
      else process.env.CHAPA_SECRET_KEY = originalKey;
    }
  }

  test('refund lifecycle: request -> process -> verify (Chapa confirms), duplicate requests are idempotent', async (t) => {
    const prisma = require('../src/config/db');
    const bcrypt = require('bcryptjs');
    const { requestRefund, processRefund, verifyAndFinalizeRefund } = require('../src/services/paymentRefundService');

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
        chapaTxRef: `refund-lifecycle-${Date.now()}`,
        createdById: buyer.id,
      },
    });

    t.after(async () => {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: buyer.id } }).catch(() => {});
    });

    // requestRefund must actually move Payment.status to REFUND_PENDING.
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

    // processRefund submits to Chapa; a successful "initiated" response
    // moves the refund to PROCESSING with a providerRefundId on file.
    const submitted = await withStubbedChapa(
      [{ status: 'success', data: { ref_id: 'REF-lifecycle-1', status: 'initiated' } }],
      () => processRefund({ refundId: refund.id, actorId: buyer.id })
    );
    assert.equal(submitted.status, 'PROCESSING');
    assert.equal(submitted.providerRefundId, 'REF-lifecycle-1');

    // Chapa confirming "refunded" on verify must complete both rows.
    const verified = await withStubbedChapa(
      [{ status: 'success', data: { ref_id: 'REF-lifecycle-1', status: 'refunded' } }],
      () => verifyAndFinalizeRefund({ refundId: refund.id, actorId: buyer.id })
    );
    assert.equal(verified.providerStatus, 'refunded');
    assert.equal(verified.refund.status, 'COMPLETED');

    const afterComplete = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(afterComplete.status, 'REFUNDED');

    // Re-verifying an already-completed refund is idempotent: no second
    // Chapa call is even needed, and the same COMPLETED record comes back.
    const verifiedAgain = await verifyAndFinalizeRefund({ refundId: refund.id, actorId: buyer.id });
    assert.equal(verifiedAgain.refund.status, 'COMPLETED');
  });

  test('refund lifecycle: provider failure allows retry via retryRefund', async (t) => {
    const prisma = require('../src/config/db');
    const bcrypt = require('bcryptjs');
    const { requestRefund, processRefund, retryRefund } = require('../src/services/paymentRefundService');

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
        chapaTxRef: `refund-retry-${Date.now()}`,
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

    // A 4xx from Chapa (e.g. an invalid tx_ref) is treated as a definite
    // failure: processRefund must catch it, mark the refund FAILED, and
    // return the payment to PAID rather than leaving it stuck in
    // REFUND_PENDING with nothing retryable.
    await assert.rejects(
      withStubbedChapa(
        [{ status: 400, body: { message: 'Transaction reference not found' } }],
        () => processRefund({ refundId: refund.id, actorId: buyer.id })
      )
    );

    const afterFailedSubmit = await prisma.paymentRefund.findUnique({ where: { id: refund.id } });
    assert.equal(afterFailedSubmit.status, 'FAILED');

    const afterFail = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(afterFail.status, 'PAID');

    // retryRefund opens a fresh PaymentRefund (never resurrects the dead
    // one) and immediately resubmits it to Chapa.
    const retried = await withStubbedChapa(
      [{ status: 'success', data: { ref_id: 'REF-lifecycle-2', status: 'initiated' } }],
      () => retryRefund({ refundId: refund.id, actorId: buyer.id, note: 'Retry after failed Chapa refund' })
    );
    assert.notEqual(retried.id, refund.id);
    assert.equal(retried.status, 'PROCESSING');

    const refundCount = await prisma.paymentRefund.count({ where: { paymentId: payment.id } });
    assert.equal(refundCount, 2);
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
