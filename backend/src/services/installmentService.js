'use strict';

/**
 * Installment payments for goods payments above the provider's per-transaction
 * limit (Chapa rejects any single transaction over the merchant cap).
 *
 * Model
 * -----
 *   parent  : the normal MARKETPLACE payment for the full order price. It has
 *             installmentCount set and is NEVER sent to the provider. It is
 *             linked to the MARKETPLACE payment obligation exactly like a
 *             normal goods payment.
 *   child   : one MARKETPLACE_INSTALLMENT payment per installment, each with
 *             its own Chapa checkout, callback, webhook and verification. The
 *             existing provider flows work on children unchanged.
 *
 * The parent is settled PAID only after every child is PAID. Settling the
 * parent is what confirms the order, commits inventory, writes the ledger and
 * creates the seller payout hold, so the seller is paid nothing until the whole
 * amount has been received. No business effect runs for a child.
 */

function toCents(value) {
  return Math.round(Number(value) * 100);
}

/**
 * Split `total` into the fewest equal-as-possible installments that are each
 * <= `max`. All maths is done in cents so the parts always sum exactly to the
 * total. The first installments carry any spare cent.
 */
function splitInto(total, count) {
  const totalCents = toCents(total);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    parts.push((base + (i < remainder ? 1 : 0)) / 100);
  }
  return parts;
}

function splitAmount(total, max) {
  const totalCents = toCents(total);
  const maxCents = toCents(max);

  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error('Invalid amount to split'), { status: 400 });
  }
  if (!Number.isFinite(maxCents) || maxCents <= 0) {
    throw Object.assign(new Error('Invalid installment limit'), { status: 400 });
  }

  // Always use the fewest installments needed to keep every Chapa checkout
  // at or below the configured provider limit. There is intentionally no
  // fixed installment-count cap here: a 4M ETB order becomes 4 x 1M, a 20M
  // order becomes 20 x 1M, etc. Any provider/business limit can be enforced
  // separately without making the amount-splitting rule incorrect.
  const count = Math.max(1, Math.ceil(totalCents / maxCents));
  return splitInto(total, count);
}

function isInstallmentParent(payment) {
  return Boolean(payment) && payment.installmentCount != null;
}

function isInstallmentChild(payment) {
  return Boolean(payment) && payment.type === 'MARKETPLACE_INSTALLMENT';
}

/**
 * Create the child payments for a parent plan. Idempotent: if the children
 * already exist they are returned unchanged, so a retry after a partial
 * failure (or a duplicate request) is always safe.
 */
async function ensureInstallmentChildren(parent, max, { db } = {}) {
  const prisma = db || require('../config/db');

  const existing = await prisma.payment.findMany({
    where: { parentPaymentId: parent.id },
    orderBy: { installmentSequence: 'asc' },
  });
  if (existing.length > 0) {
    return existing.filter((child) => child.installmentSequence != null);
  }

  // The parent's recorded count is authoritative (it was fixed when the plan
  // was created), so a later change to the limit cannot reshape the plan.
  const parts = parent.installmentCount != null
    ? splitInto(parent.amount, parent.installmentCount)
    : splitAmount(parent.amount, max);

  await prisma.payment.createMany({
    data: parts.map((amount, index) => ({
      type: 'MARKETPLACE_INSTALLMENT',
      orderId: parent.orderId,
      createdById: parent.createdById,
      parentPaymentId: parent.id,
      installmentSequence: index + 1,
      amount,
      currency: parent.currency || 'ETB',
      method: parent.method,
      status: 'PENDING',
      // Commission belongs to the parent. Children carry none so nothing is
      // counted twice in the ledger or in commission reports.
      commissionRate: 0,
      commissionAmount: 0,
      netAmount: amount,
      reference: parent.reference || null,
    })),
    skipDuplicates: true,
  });

  return prisma.payment.findMany({
    where: { parentPaymentId: parent.id, installmentSequence: { not: null } },
    orderBy: { installmentSequence: 'asc' },
  });
}

/**
 * A failed installment cannot be reopened (FAILED is terminal), so the buyer
 * retries it with a fresh installment for the same sequence and amount. The
 * failed attempt keeps its record but gives up its sequence number.
 */
async function replaceFailedInstallment(childId, userId, { db, isAdmin = false } = {}) {
  const prisma = db || require('../config/db');

  return prisma.$transaction(async (tx) => {
    const failed = await tx.payment.findUnique({
      where: { id: childId },
      include: { parentPayment: true },
    });

    if (!isInstallmentChild(failed) || !failed.parentPayment) {
      throw Object.assign(new Error('Installment not found'), { status: 404 });
    }
    if (failed.createdById !== userId && !isAdmin) {
      throw Object.assign(new Error('Not authorized'), { status: 403 });
    }
    if (failed.status !== 'FAILED') {
      throw Object.assign(
        new Error('Only a failed installment can be retried'),
        { status: 409, code: 'INSTALLMENT_NOT_FAILED' }
      );
    }
    if (failed.installmentSequence == null) {
      throw Object.assign(
        new Error('This installment was already replaced'),
        { status: 409, code: 'INSTALLMENT_ALREADY_REPLACED' }
      );
    }
    if (failed.parentPayment.status !== 'PENDING') {
      throw Object.assign(
        new Error('This installment plan is no longer open'),
        { status: 409, code: 'INSTALLMENT_PLAN_CLOSED' }
      );
    }

    const order = failed.orderId
      ? await tx.order.findUnique({
          where: { id: failed.orderId },
          select: { status: true },
        })
      : null;
    if (order && ['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status)) {
      throw Object.assign(
        new Error(`Order is ${order.status}; installments can no longer be paid`),
        { status: 409, code: 'ORDER_NOT_PAYABLE' }
      );
    }

    await tx.payment.update({
      where: { id: failed.id },
      data: { installmentSequence: null },
    });

    return tx.payment.create({
      data: {
        type: 'MARKETPLACE_INSTALLMENT',
        orderId: failed.orderId,
        createdById: failed.createdById,
        parentPaymentId: failed.parentPaymentId,
        installmentSequence: failed.installmentSequence,
        amount: failed.amount,
        currency: failed.currency,
        method: failed.method,
        status: 'PENDING',
        commissionRate: 0,
        commissionAmount: 0,
        netAmount: failed.amount,
        reference: failed.reference,
      },
    });
  });
}

/**
 * If every installment of the plan is PAID, settle the parent goods payment.
 * Safe to call any number of times and from any code path (callback, webhook,
 * verify, page load): settlement is idempotent through the event id.
 * Returns the parent payment (settled or not), or null if not a plan.
 */
async function finalizeInstallmentPlan(parentPaymentId, { db, settle } = {}) {
  const prisma = db || require('../config/db');
  const settlePayment = settle || require('./paymentService').settlePaymentCore;

  const parent = await prisma.payment.findUnique({
    where: { id: parentPaymentId },
    include: { installments: true },
  });
  if (!isInstallmentParent(parent)) return null;

  if (['PAID', 'REFUNDED', 'REFUND_PENDING', 'FAILED'].includes(parent.status)) {
    return parent;
  }

  // Failed attempts that were replaced have their sequence cleared; only the
  // live installment for each sequence counts.
  const children = (parent.installments || []).filter(
    (child) => child.installmentSequence != null
  );
  const allPaid =
    children.length === parent.installmentCount &&
    children.every((child) => child.status === 'PAID');

  if (!allPaid) return parent;

  return settlePayment({
    paymentId: parent.id,
    status: 'PAID',
    provider: 'INSTALLMENTS',
    providerTransactionId: `installments:${parent.id}`,
    reference: parent.reference || null,
    eventId: `installments-complete:${parent.id}`,
    payload: {
      amount: parent.amount,
      currency: parent.currency || 'ETB',
      installmentPaymentIds: children.map((child) => child.id),
    },
  });
}

/**
 * Called inside the refund-completion transaction after a child installment
 * was refunded. When no installment is still paid (or being refunded) the
 * parent goods payment is marked REFUNDED and its obligation cancelled.
 */
async function markParentRefundedIfComplete(tx, parentPaymentId) {
  const parent = await tx.payment.findUnique({
    where: { id: parentPaymentId },
    include: { installments: true },
  });
  if (!isInstallmentParent(parent)) return null;
  if (parent.status !== 'REFUND_PENDING') return parent;

  const stillHeld = (parent.installments || []).some((child) =>
    ['PAID', 'REFUND_PENDING', 'PROCESSING'].includes(child.status)
  );
  if (stillHeld) return parent;

  const updated = await tx.payment.update({
    where: { id: parent.id },
    data: { status: 'REFUNDED' },
  });

  if (parent.obligationId) {
    await tx.paymentObligation.update({
      where: { id: parent.obligationId },
      data: { status: 'CANCELLED' },
    });
  }

  // No REFUND ledger entry is written for the parent: each refunded child
  // already carries its own REFUND entry and together they equal the parent's
  // amount, so writing one here would double-count the refund.

  return updated;
}

module.exports = {
  splitAmount,
  splitInto,
  isInstallmentParent,
  isInstallmentChild,
  ensureInstallmentChildren,
  replaceFailedInstallment,
  finalizeInstallmentPlan,
  markParentRefundedIfComplete,
};
