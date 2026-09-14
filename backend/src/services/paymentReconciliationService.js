'use strict';

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');

async function createReconciliationIssue(tx, data) {
  const issue = await tx.paymentReconciliation.create({ data: {
    paymentId: data.paymentId, provider: data.provider || 'UNKNOWN', observedStatus: data.observedStatus || null,
    expectedAmount: data.expectedAmount, observedAmount: data.observedAmount ?? null,
    expectedCurrency: data.expectedCurrency, observedCurrency: data.observedCurrency || null,
    reason: data.reason, payload: data.payload || null,
  }});

  const payment = await tx.payment.findUnique({
    where: { id: data.paymentId },
    select: { orderId: true, type: true },
  });

  if (payment?.orderId) {
    await recordOrderEvent(tx, {
      orderId: payment.orderId,
      actorId: null,
      type: 'PAYMENT_RECONCILIATION_REQUIRED',
      metadata: {
        paymentId: data.paymentId,
        paymentType: payment.type,
        reconciliationId: issue.id,
        reason: data.reason,
      },
    });
  }

  return issue;
}

async function resolveReconciliation({ reconciliationId, status, actorId, note }) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.paymentReconciliation.findUnique({ where: { id: reconciliationId }, include: { payment: true } });
    if (!item) throw Object.assign(new Error('Reconciliation record not found'), { status: 404 });
    if (item.status !== 'OPEN') return item;
    if (!['RESOLVED', 'DISMISSED'].includes(status)) throw Object.assign(new Error('Invalid reconciliation resolution'), { status: 400 });

    const updated = await tx.paymentReconciliation.update({ where: { id: item.id }, data: { status, resolvedById: actorId, resolvedAt: new Date(), resolutionNote: note || null } });
    if (item.payment.orderId) {
      await recordOrderEvent(tx, {
        orderId: item.payment.orderId,
        actorId,
        type: 'PAYMENT_RECONCILIATION_RESOLVED',
        metadata: { paymentId: item.paymentId, paymentType: item.payment.type, reconciliationId: item.id, resolution: status },
      });
    }
    await recordAuditEvent(tx, { actorId, action: 'PAYMENT_RECONCILIATION_RESOLVED', resourceType: 'PaymentReconciliation', resourceId: item.id, metadata: { paymentId: item.paymentId, resolution: status, note: note || null } });
    return updated;
  });
}

module.exports = { createReconciliationIssue, resolveReconciliation };
