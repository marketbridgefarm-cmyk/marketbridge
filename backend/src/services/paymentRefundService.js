'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { assertTransition } = require('./paymentStateMachine');
const chapa = require('../config/chapa');

function providerForPayment(payment) {
  const provider = String(payment?.provider || '').toUpperCase();
  if (provider === 'CHAPA' || provider === 'CHAPA_TELEBIRR') return provider;

  const method = String(payment?.method || '').toUpperCase();
  if (method === 'QR') return 'CHAPA';
  if (method === 'TELEBIRR') return 'CHAPA_TELEBIRR';
  return null;
}

function refundReference(refundId) {
  // Chapa requires this reference to be unique within the merchant account.
  // Keeping it deterministic makes retries safe to reason about.
  return `MB-REFUND-${refundId}`;
}

async function requestRefund(tx, { paymentId, amount, reason, requestedById }) {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true, amount: true, currency: true, status: true,
      orderId: true, type: true,
    },
  });
  if (!payment) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (!['PAID', 'REFUND_PENDING'].includes(payment.status)) {
    throw Object.assign(new Error('Only PAID or retryable REFUND_PENDING payments can be refunded'), { status: 409 });
  }

  const refundAmount = Number(amount ?? payment.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0 || Math.abs(refundAmount - Number(payment.amount)) >= 0.01) {
    throw Object.assign(new Error('Only full refunds are currently supported'), { status: 400 });
  }

  const existing = await tx.paymentRefund.findFirst({
    where: { paymentId, status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

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
    data: {
      paymentId,
      amount: refundAmount,
      currency: payment.currency,
      reason: reason || null,
      requestedById: requestedById || null,
    },
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

/**
 * Submit a requested refund to Chapa. The external API call intentionally
 * happens outside a Prisma transaction. The database first claims the row as
 * PROCESSING, then Chapa is called, then the provider reference is persisted.
 */
async function processRefund({ refundId, actorId, note }) {
  const claimed = await require('../config/db').$transaction(async (tx) => {
    const refund = await tx.paymentRefund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
    if (refund.status === 'COMPLETED') return { refund, alreadyCompleted: true };
    if (refund.status === 'PROCESSING') return { refund, alreadyProcessing: true };
    if (refund.status !== 'REQUESTED') {
      throw Object.assign(new Error('Only REQUESTED refunds can be submitted to Chapa'), { status: 409 });
    }

    const provider = providerForPayment(refund.payment);
    if (!provider) {
      throw Object.assign(new Error(`No live refund adapter is configured for payment provider ${refund.payment.provider || refund.payment.method}`), { status: 503, code: 'REFUND_PROVIDER_NOT_CONFIGURED' });
    }
    if (!refund.payment.chapaTxRef) {
      throw Object.assign(new Error('Original Chapa transaction reference is missing; this payment cannot be safely refunded automatically.'), { status: 409, code: 'CHAPA_TX_REF_MISSING' });
    }

    // Order-linked refunds are only allowed after the order itself has been
    // cancelled. An open DISPUTED/active order must never be refunded while
    // its workflow can still resume; otherwise a refund could race with a
    // payout release or a new payment. Dispute resolution therefore first
    // transitions the order to CANCELLED and only then processes its refund.
    if (refund.payment.orderId) {
      const order = await tx.order.findUnique({
        where: { id: refund.payment.orderId },
        select: { status: true },
      });
      if (order && order.status !== 'CANCELLED') {
        throw Object.assign(
          new Error(`Order is ${order.status}; refund processing is blocked until the order is cancelled`),
          { status: 409, code: 'REFUND_BLOCKED_ORDER_ACTIVE' }
        );
      }
    }

    const result = await tx.paymentRefund.updateMany({
      where: { id: refund.id, status: 'REQUESTED' },
      data: { status: 'PROCESSING', provider, failureReason: null },
    });
    if (result.count !== 1) {
      return { refund: await tx.paymentRefund.findUnique({ where: { id: refund.id }, include: { payment: true } }), alreadyProcessing: true };
    }

    return {
      refund: { ...refund, status: 'PROCESSING', provider },
      provider,
      txRef: refund.payment.chapaTxRef,
    };
  });

  if (claimed.alreadyCompleted || claimed.alreadyProcessing) return claimed.refund;

  try {
    const result = await chapa.refundTransaction({
      txRef: claimed.txRef,
      amount: claimed.refund.amount,
      reason: claimed.refund.reason || 'MarketBridge refund',
      reference: refundReference(claimed.refund.id),
      meta: {
        marketbridge_refund_id: claimed.refund.id,
        marketbridge_payment_id: claimed.refund.paymentId,
      },
    });

    const prisma = require('../config/db');
    const updated = await prisma.paymentRefund.updateMany({
      where: { id: claimed.refund.id, status: 'PROCESSING' },
      data: {
        provider: claimed.provider,
        providerRefundId: result.refId,
        failureReason: null,
      },
    });

    if (updated.count !== 1) {
      return prisma.paymentRefund.findUnique({ where: { id: claimed.refund.id }, include: { payment: true } });
    }

    await recordAuditEvent(prisma, {
      actorId: actorId || null,
      action: 'PAYMENT_REFUND_SUBMITTED',
      resourceType: 'PaymentRefund',
      resourceId: claimed.refund.id,
      metadata: { paymentId: claimed.refund.paymentId, provider: claimed.provider, providerRefundId: result.refId, providerStatus: result.status, note: note || null },
    });

    // Chapa refunds are asynchronous, but many resolve within moments of
    // submission. Rather than making the admin come back and click a
    // separate "check status" action, take one immediate best-effort look
    // right away so a fast refund can land as COMPLETED in the very same
    // request that submitted it. If Chapa is still processing (or this
    // check itself fails for any reason), that's fine — the refund stays
    // PROCESSING and is finalized later by the Chapa webhook or the
    // dashboard's own background polling, with no admin action required.
    try {
      const verified = await verifyAndFinalizeRefund({
        refundId: claimed.refund.id,
        actorId,
        note: 'Auto-verified immediately after submission.',
      });
      return verified.refund;
    } catch {
      return prisma.paymentRefund.findUnique({ where: { id: claimed.refund.id }, include: { payment: true } });
    }
  } catch (error) {
    const prisma = require('../config/db');
    // A timeout/5xx is ambiguous: Chapa may have accepted the refund even if
    // MarketBridge did not receive the response. Never turn an uncertain
    // provider result into FAILED; keep PROCESSING and require verification.
    if (Number(error.status) >= 400 && Number(error.status) < 500) {
      await failRefund({ refundId: claimed.refund.id, failureReason: error.message, actorId, allowProcessing: true });
    } else {
      await prisma.paymentRefund.updateMany({
        where: { id: claimed.refund.id, status: 'PROCESSING' },
        data: { failureReason: `Provider response uncertain: ${error.message}` },
      });
    }
    throw error;
  }
}

async function finalizeRefund({ refundId, actorId, note, providerStatus }) {
  const prisma = require('../config/db');
  const refund = await prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') return refund;
  if (providerStatus !== 'refunded') {
    throw Object.assign(new Error(`Refund is not complete at Chapa (status: ${providerStatus || 'unknown'})`), { status: 409 });
  }

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!fresh) throw Object.assign(new Error('Refund request not found'), { status: 404 });
    if (fresh.status === 'COMPLETED') return fresh;
    if (!['REQUESTED', 'PROCESSING'].includes(fresh.status)) {
      throw Object.assign(new Error(`Refund is ${fresh.status} and cannot be completed`), { status: 409 });
    }

    if (fresh.payment.orderId) {
      const order = await tx.order.findUnique({
        where: { id: fresh.payment.orderId },
        select: { status: true },
      });
      if (order && order.status !== 'CANCELLED') {
        throw Object.assign(
          new Error(`Order is ${order.status}; refund completion is blocked until the order is cancelled`),
          { status: 409, code: 'REFUND_BLOCKED_ORDER_ACTIVE' }
        );
      }
    }

    assertTransition(fresh.payment.status, 'REFUNDED');
    const claimed = await tx.paymentRefund.updateMany({
      where: { id: refundId, status: { in: ['REQUESTED', 'PROCESSING'] } },
      data: { status: 'COMPLETED', completedAt: new Date(), failureReason: null },
    });
    if (claimed.count !== 1) return tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });

    await tx.payment.update({ where: { id: fresh.payment.id }, data: { status: 'REFUNDED' } });

    if (fresh.payment.orderId) {
      await recordOrderEvent(tx, {
        orderId: fresh.payment.orderId,
        actorId: actorId || null,
        type: 'PAYMENT_REFUNDED',
        metadata: { paymentId: fresh.payment.id, paymentType: fresh.payment.type, amount: String(fresh.amount), refundId: fresh.id, provider: fresh.provider, providerRefundId: fresh.providerRefundId },
      });
    }

    await recordAuditEvent(tx, {
      actorId: actorId || null,
      action: 'PAYMENT_REFUND_COMPLETED',
      resourceType: 'PaymentRefund',
      resourceId: refundId,
      metadata: { paymentId: fresh.payment.id, amount: String(fresh.amount), provider: fresh.provider, providerRefundId: fresh.providerRefundId, note: note || null },
    });

    return tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  });
}

async function verifyAndFinalizeRefund({ refundId, actorId, note }) {
  const prisma = require('../config/db');
  const refund = await prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') return { refund, providerStatus: 'refunded' };
  if (!refund.providerRefundId) {
    throw Object.assign(new Error('Chapa refund reference is not available yet. The refund request may still be awaiting a provider response.'), { status: 409, code: 'CHAPA_REFUND_REFERENCE_MISSING' });
  }

  const result = await chapa.verifyRefund(refund.providerRefundId);
  if (result.status === 'refunded') {
    return { refund: await finalizeRefund({ refundId, actorId, note, providerStatus: 'refunded' }), providerStatus: result.status, raw: result.raw };
  }

  if (result.status === 'reversed') {
    const failed = await failRefund({ refundId, failureReason: 'Chapa reversed the refund after processing.', actorId, allowProcessing: true });
    return { refund: failed, providerStatus: result.status, raw: result.raw };
  }

  await prisma.paymentRefund.updateMany({
    where: { id: refundId, status: { in: ['REQUESTED', 'PROCESSING'] } },
    data: { status: 'PROCESSING', failureReason: null },
  });
  return {
    refund: await prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } }),
    providerStatus: result.status,
    raw: result.raw,
  };
}

async function failRefund({ refundId, failureReason, actorId, allowProcessing = false }) {
  const prisma = require('../config/db');
  const refund = await prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') throw Object.assign(new Error('Completed refund cannot be failed'), { status: 409 });
  if (refund.status === 'PROCESSING' && !allowProcessing) {
    throw Object.assign(new Error('A refund submitted to Chapa cannot be manually failed. Verify the provider status instead.'), { status: 409, code: 'REFUND_PROCESSING_PROVIDER_CONTROLLED' });
  }

  const claimed = await prisma.paymentRefund.updateMany({
    where: { id: refundId, status: { not: 'COMPLETED' } },
    data: { status: 'FAILED', failureReason: failureReason || 'Provider refund failed' },
  });
  if (claimed.count !== 1) return prisma.paymentRefund.findUnique({ where: { id: refundId } });

  if (refund.payment?.status === 'REFUND_PENDING') {
    await prisma.payment.updateMany({ where: { id: refund.payment.id, status: 'REFUND_PENDING' }, data: { status: 'PAID' } });
  }

  const updated = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
  if (refund.payment?.orderId) {
    await recordOrderEvent(prisma, {
      orderId: refund.payment.orderId,
      actorId: actorId || null,
      type: 'PAYMENT_REFUND_FAILED',
      metadata: { paymentId: refund.payment.id, paymentType: refund.payment.type, refundId: refund.id, failureReason: failureReason || null },
    });
  }
  await recordAuditEvent(prisma, { actorId: actorId || null, action: 'PAYMENT_REFUND_FAILED', resourceType: 'PaymentRefund', resourceId: refundId, metadata: { failureReason: failureReason || null } });
  return updated;
}

async function retryRefund({ refundId, actorId, note }) {
  const prisma = require('../config/db');
  const previous = await prisma.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!previous) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (previous.status !== 'FAILED') throw Object.assign(new Error('Only FAILED refunds can be retried'), { status: 409 });

  const refund = await prisma.$transaction((tx) => requestRefund(tx, {
    paymentId: previous.paymentId,
    amount: previous.amount,
    reason: note || previous.reason || 'Retry after failed Chapa refund',
    requestedById: actorId,
  }));

  return processRefund({ refundId: refund.id, actorId, note: note || 'Retry after failed Chapa refund' });
}

async function requestRefundsForPayouts(tx, { payouts, reason, requestedById }) {
  const refunds = [];
  for (const payout of payouts || []) {
    if (!payout?.paymentId) continue;
    const payment = await tx.payment.findUnique({ where: { id: payout.paymentId }, select: { id: true, status: true } });
    if (!payment || payment.status !== 'PAID') continue;
    refunds.push(await requestRefund(tx, { paymentId: payment.id, reason, requestedById }));
  }
  return refunds;
}

module.exports = {
  requestRefund,
  processRefund,
  verifyAndFinalizeRefund,
  finalizeRefund,
  retryRefund,
  failRefund,
  requestRefundsForPayouts,
};
