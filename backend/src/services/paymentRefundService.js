'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');

async function requestRefund(tx, { paymentId, amount, reason, requestedById }) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, amount: true, currency: true, status: true, orderId: true, type: true } });
  if (!payment) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (payment.status !== 'PAID') throw Object.assign(new Error('Only PAID payments can be refunded'), { status: 409 });

  const refundAmount = Number(amount ?? payment.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0 || Math.abs(refundAmount - Number(payment.amount)) >= 0.01) {
    throw Object.assign(new Error('Only full refunds are currently supported'), { status: 400 });
  }

  const existing = await tx.paymentRefund.findFirst({
    where: { paymentId, status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  assertTransition(payment.status, 'REFUND_PENDING');
  await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });

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

  const updated = await tx.paymentRefund.update({
    where: { id: refund.id },
    data: { status: 'COMPLETED', provider: provider || refund.provider || null, providerRefundId: providerRefundId || refund.providerRefundId || null, completedAt: new Date(), failureReason: null },
    include: { payment: true },
  });

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

  return updated;
}

async function failRefund(tx, { refundId, failureReason, actorId }) {
  const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw Object.assign(new Error('Refund request not found'), { status: 404 });
  if (refund.status === 'COMPLETED') throw Object.assign(new Error('Completed refund cannot be failed'), { status: 409 });
  assertTransition(payment.status, 'REFUNDED');

  const updated = await tx.paymentRefund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: failureReason || 'Provider refund failed' } });
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

module.exports = { requestRefund, completeRefund, failRefund };
