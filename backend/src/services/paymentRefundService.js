'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { assertTransition } = require('./paymentStateMachine');
const { getAdapter } = require('./paymentProviders');


function isProviderDefinitiveFailure(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

/**
 * Submit a requested refund to the configured provider.
 *
 * This deliberately does NOT hold a Prisma transaction open while waiting for
 * Chapa. The refund row is atomically claimed first, then the provider call is
 * made. Unknown/network/5xx outcomes remain PROCESSING because Chapa may have
 * accepted the refund even though our HTTP request timed out.
 */
async function processRefund({ refundId, actorId }) {
  const prisma = require('../config/db');
  const refund = await prisma.paymentRefund.findUnique({
    where: { id: refundId },
    include: { payment: true },
  });

  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') return refund;
  if (!['REQUESTED', 'PROCESSING'].includes(refund.status)) {
    throw Object.assign(new Error('Refund request is not processable'), { status: 409 });
  }

  if (!refund.payment?.chapaTxRef) {
    throw Object.assign(
      new Error('This payment has no stored Chapa transaction reference. It cannot be safely refunded automatically.'),
      { status: 409, code: 'CHAPA_TX_REF_MISSING' }
    );
  }

  const adapter = getAdapter(refund.payment.method);
  if (typeof adapter.refund !== 'function') {
    throw Object.assign(new Error(`Refunds are not configured for payment method ${refund.payment.method}`), { status: 503, code: 'REFUND_PROVIDER_NOT_CONFIGURED' });
  }

  // If a provider refund id already exists, never submit a second refund.
  if (refund.providerRefundId) {
    return syncRefundStatus({ refundId, actorId });
  }

  const claimed = await prisma.paymentRefund.updateMany({
    where: { id: refundId, status: 'REQUESTED', providerRefundId: null },
    data: { status: 'PROCESSING', failureReason: null },
  });

  if (claimed.count !== 1) {
    const fresh = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
    if (!fresh) throw Object.assign(new Error('Refund request not found'), { status: 404 });
    if (fresh.status === 'COMPLETED') return fresh;
    if (fresh.providerRefundId) return syncRefundStatus({ refundId, actorId });
    if (fresh.status !== 'PROCESSING') throw Object.assign(new Error('Refund is already being handled'), { status: 409 });
    return fresh;
  }

  const reference = `MB-REFUND-${refund.id}`;
  let result;
  try {
    result = await adapter.refund({
      txRef: refund.payment.chapaTxRef,
      amount: refund.amount,
      reason: refund.reason || 'MarketBridge refund',
      reference,
      meta: {
        marketbridge_refund_id: refund.id,
        marketbridge_payment_id: refund.paymentId,
      },
    });
  } catch (error) {
    if (isProviderDefinitiveFailure(error)) {
      return failRefund(prisma, {
        refundId,
        failureReason: error.message || 'Chapa rejected the refund request',
        actorId,
      });
    }

    // Unknown outcome: do not claim failure. The provider may have processed it.
    return prisma.paymentRefund.findUnique({ where: { id: refundId } });
  }

  const providerRefundId = result.refId;
  const providerStatus = result.status;

  if (providerStatus === 'refunded') {
    return completeRefund(prisma, {
      refundId,
      provider: adapter.provider,
      providerRefundId,
      actorId,
      note: 'Chapa confirmed the refund during submission.',
    });
  }

  if (providerStatus === 'reversed') {
    return failRefund(prisma, {
      refundId,
      failureReason: 'Chapa reported the refund as reversed.',
      actorId,
    });
  }

  const updated = await prisma.paymentRefund.updateMany({
    where: { id: refundId, status: 'PROCESSING' },
    data: {
      status: 'PROCESSING',
      provider: adapter.provider,
      providerRefundId,
      failureReason: null,
    },
  });

  await recordAuditEvent(prisma, {
    actorId: actorId || null,
    action: 'PAYMENT_REFUND_SUBMITTED',
    resourceType: 'PaymentRefund',
    resourceId: refundId,
    metadata: {
      paymentId: refund.paymentId,
      provider: adapter.provider,
      providerRefundId,
      providerStatus,
      reference,
      changed: updated.count === 1,
    },
  });

  return prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
}

/** Verify an asynchronous provider refund and synchronize the local ledger. */
async function syncRefundStatus({ refundId, actorId }) {
  const prisma = require('../config/db');
  const refund = await prisma.paymentRefund.findUnique({
    where: { id: refundId },
    include: { payment: true },
  });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') return refund;
  if (!refund.providerRefundId) {
    throw Object.assign(new Error('No Chapa refund reference is stored yet'), { status: 409, code: 'CHAPA_REFUND_ID_MISSING' });
  }

  const adapter = getAdapter(refund.payment.method);
  if (typeof adapter.verifyRefund !== 'function') {
    throw Object.assign(new Error(`Refund verification is not configured for payment method ${refund.payment.method}`), { status: 503, code: 'REFUND_VERIFICATION_NOT_CONFIGURED' });
  }

  const result = await adapter.verifyRefund(refund.providerRefundId);

  if (result.status === 'refunded') {
    return completeRefund(prisma, {
      refundId,
      provider: adapter.provider,
      providerRefundId: refund.providerRefundId,
      actorId,
      note: 'Chapa verification confirmed the refund.',
    });
  }

  if (result.status === 'reversed') {
    return failRefund(prisma, {
      refundId,
      failureReason: 'Chapa reported the refund as reversed.',
      actorId,
    });
  }

  await prisma.paymentRefund.updateMany({
    where: { id: refundId, status: { in: ['REQUESTED', 'PROCESSING'] } },
    data: { status: 'PROCESSING', provider: adapter.provider },
  });

  return prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
}

async function requestRefund(tx, { paymentId, amount, reason, requestedById }) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, amount: true, currency: true, status: true, orderId: true, type: true } });
  if (!payment) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (!['PAID', 'REFUND_PENDING'].includes(payment.status)) throw Object.assign(new Error('Only PAID or retryable REFUND_PENDING payments can be refunded'), { status: 409 });

  const refundAmount = Number(amount ?? payment.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0 || Math.abs(refundAmount - Number(payment.amount)) >= 0.01) {
    throw Object.assign(new Error('Only full refunds are currently supported'), { status: 400 });
  }

  const existing = await tx.paymentRefund.findFirst({
    where: { paymentId, status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  // A failed provider attempt leaves the payment in REFUND_PENDING. Allow
  // a retry only when the latest refund record is FAILED; reset the payment
  // to PAID atomically so concurrent retries cannot create two claims.
  if (payment.status === 'REFUND_PENDING') {
    const failed = await tx.paymentRefund.findFirst({
      where: { paymentId, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!failed) throw Object.assign(new Error('Refund is already in progress'), { status: 409 });
    const reset = await tx.payment.updateMany({
      where: { id: payment.id, status: 'REFUND_PENDING' },
      data: { status: 'PAID' },
    });
    if (reset.count !== 1) throw Object.assign(new Error('Payment status changed before refund retry'), { status: 409 });
    payment.status = 'PAID';
  }

  assertTransition(payment.status, 'REFUND_PENDING');

  // Atomic claim: the findFirst above is a plain SELECT, so two concurrent
  // callers (e.g. a dispute resolution and an order cancellation landing on
  // the same payment at the same moment) could both see "no existing
  // refund" before either commits. Only one updateMany can actually match
  // status: 'PAID' and win; the loser falls through to the re-check below
  // instead of creating a second PaymentRefund row for the same payment.
  const claimed = await tx.payment.updateMany({
    where: { id: payment.id, status: 'PAID' },
    data: { status: 'REFUND_PENDING' },
  });
  if (claimed.count !== 1) {
    const nowExisting = await tx.paymentRefund.findFirst({
      where: { paymentId, status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (nowExisting) return nowExisting;
    throw Object.assign(new Error('Payment status changed before the refund could be requested'), { status: 409 });
  }

  const refund = await tx.paymentRefund.create({
    data: { paymentId, amount: refundAmount, currency: payment.currency, reason: reason || null, requestedById: requestedById || null },
  });

  if (payment.orderId) {
    await recordOrderEvent(tx, {
      orderId: payment.orderId,
      actorId: requestedById || null,
      type: 'PAYMENT_REFUND_REQUESTED',
      metadata: { paymentId: payment.id, paymentType: payment.type, amount: String(refund.amount), reason: reason || null },
    });
  }

  await recordAuditEvent(tx, {
    actorId: requestedById || null,
    action: 'PAYMENT_REFUND_REQUESTED',
    resourceType: 'PaymentRefund',
    resourceId: refund.id,
    metadata: { paymentId, amount: refundAmount, reason: reason || null },
  });

  return refund;
}

async function completeRefund(tx, { refundId, provider, providerRefundId, actorId, note }) {
  const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') return refund;
  if (!['REQUESTED', 'PROCESSING'].includes(refund.status)) throw Object.assign(new Error('Refund request is not completable'), { status: 409 });

  const payment = refund.payment;
  if (Math.abs(Number(refund.amount) - Number(payment.amount)) >= 0.01) {
    throw Object.assign(new Error('Refund amount must equal payment amount'), { status: 409 });
  }

  assertTransition(payment.status, 'REFUNDED');

  // Atomic claim, same reasoning as requestRefund above: the checks so far
  // are plain SELECTs. This updateMany is what actually decides which of
  // two concurrent completeRefund calls (double-click, two admins, a retry
  // racing the original) gets to complete it and fire the one-time side
  // effects below. The loser returns the already-completed row instead of
  // re-running them.
  const claimed = await tx.paymentRefund.updateMany({
    where: { id: refund.id, status: { in: ['REQUESTED', 'PROCESSING'] } },
    data: { status: 'COMPLETED', provider: provider || refund.provider || null, providerRefundId: providerRefundId || refund.providerRefundId || null, completedAt: new Date(), failureReason: null },
  });
  if (claimed.count !== 1) {
    return tx.paymentRefund.findUnique({ where: { id: refund.id }, include: { payment: true } });
  }

  await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });

  if (payment.orderId) {
    await recordOrderEvent(tx, {
      orderId: payment.orderId,
      actorId: actorId || null,
      type: 'PAYMENT_REFUNDED',
      metadata: { paymentId: payment.id, paymentType: payment.type, amount: String(refund.amount), refundId: refund.id },
    });
  }

  await recordAuditEvent(tx, {
    actorId: actorId || null,
    action: 'PAYMENT_REFUND_COMPLETED',
    resourceType: 'PaymentRefund',
    resourceId: refund.id,
    metadata: { paymentId: payment.id, amount: refund.amount, provider: provider || null, providerRefundId: providerRefundId || null, note: note || null },
  });

  return tx.paymentRefund.findUnique({ where: { id: refund.id }, include: { payment: true } });
}

async function failRefund(tx, { refundId, failureReason, actorId }) {
  const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') throw Object.assign(new Error('Completed refund cannot be failed'), { status: 409 });

  // Note: failing a refund does NOT move Payment.status anywhere — it stays
  // wherever it was (typically REFUND_PENDING), which is what allows a
  // retry via another requestRefund/completeRefund attempt after a
  // provider-side failure. There is deliberately no assertTransition call
  // here: this function only ever writes PaymentRefund.status, never
  // Payment.status, so there's no payment transition to validate.

  // Atomic claim: guards against racing a concurrent completeRefund (or
  // another failRefund) the same way requestRefund/completeRefund do above
  // — only the winner fires the audit/order-event side effects below.
  const claimed = await tx.paymentRefund.updateMany({
    where: { id: refundId, status: { not: 'COMPLETED' } },
    data: { status: 'FAILED', failureReason: failureReason || 'Provider refund failed' },
  });
  if (claimed.count !== 1) {
    const fresh = await tx.paymentRefund.findUnique({ where: { id: refundId } });
    if (fresh?.status === 'COMPLETED') {
      throw Object.assign(new Error('Completed refund cannot be failed'), { status: 409 });
    }
    return fresh;
  }

  // Return the payment to PAID only if it is still awaiting this refund.
  // This makes a provider failure retryable without reopening a completed or
  // otherwise reconciled payment.
  if (refund.payment?.status === 'REFUND_PENDING') {
    await tx.payment.updateMany({
      where: { id: refund.payment.id, status: 'REFUND_PENDING' },
      data: { status: 'PAID' },
    });
  }

  const updated = await tx.paymentRefund.findUnique({ where: { id: refundId } });
  if (refund.payment?.orderId) {
    await recordOrderEvent(tx, {
      orderId: refund.payment.orderId,
      actorId: actorId || null,
      type: 'PAYMENT_REFUND_FAILED',
      metadata: { paymentId: refund.payment.id, paymentType: refund.payment.type, refundId: refund.id, failureReason: failureReason || null },
    });
  }
  await recordAuditEvent(tx, { actorId: actorId || null, action: 'PAYMENT_REFUND_FAILED', resourceType: 'PaymentRefund', resourceId: refundId, metadata: { failureReason: failureReason || null } });
  return updated;
}

/**
 * Request the (full) refund for the payment behind each of the given
 * payouts. Used when payouts are CANCELLED because a dispute was resolved
 * against the payee — cancelling the payee's payout without also refunding
 * the buyer would leave the buyer's money with nobody.
 *
 * Safe to call with payouts whose payment is no longer PAID (a refund is
 * already pending/completed, or the payment never settled): those are
 * skipped rather than throwing, so one already-refunded payment can't block
 * the rest of the dispute resolution. requestRefund itself stays idempotent
 * for anything still PAID.
 */
async function requestRefundsForPayouts(tx, { payouts, reason, requestedById }) {
  const refunds = [];

  for (const payout of payouts || []) {
    if (!payout?.paymentId) continue;

    const payment = await tx.payment.findUnique({
      where: { id: payout.paymentId },
      select: { id: true, status: true },
    });
    if (!payment || payment.status !== 'PAID') continue;

    refunds.push(
      await requestRefund(tx, {
        paymentId: payment.id,
        reason,
        requestedById,
      })
    );
  }

  return refunds;
}

module.exports = { requestRefund, processRefund, syncRefundStatus, completeRefund, failRefund, requestRefundsForPayouts };
