'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { releaseListingQuantity } = require('./inventoryService');
const { requestRefund } = require('./paymentRefundService');
const { isInstallmentParent } = require('./installmentService');
const { cancelPayoutsForOrder } = require('./payoutService');
const { transitionOrderStatus } = require('./orderStateMachine');

const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];

/**
 * Cancel an order inside an existing Prisma transaction: flips it to
 * CANCELLED, closes open payment obligations, releases its reserved listing
 * quantity, cascade-cancels a not-yet-moved transport job, requests refunds
 * for anything already paid, and records the order-event + audit trail.
 *
 * Shared by the buyer/seller/admin-initiated PATCH /orders/:id/cancel route
 * and by the maintenance scheduler's automatic expiry of orders left
 * unpaid past their paymentDueAt deadline — both need the exact same
 * unwind, just with a different actor and reason.
 *
 * Callers are responsible for their own authorization checks and for
 * re-reading the order inside `tx` immediately before calling this, so the
 * NON_CANCELLABLE_STATUSES guard below is evaluated against a row locked by
 * the current transaction rather than a possibly-stale earlier read.
 */
async function promoteNextWaitingBuyer(tx, listingId, actorId = null) {
  // Expire stale waiting bids before choosing the next buyer. Otherwise an
  // old/high bid can be promoted even though its negotiation window ended.
  const expiredWaiting = await tx.offer.findMany({
    where: {
      listingId,
      status: 'PENDING',
      expiresAt: { lte: new Date() },
    },
    select: { id: true, buyerId: true, expiresAt: true },
  });

  for (const expired of expiredWaiting) {
    const claim = await tx.offer.updateMany({
      where: { id: expired.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    if (claim.count === 1) {
      await recordAuditEvent(tx, {
        actorId,
        action: 'OFFER_EXPIRED',
        resourceType: 'Offer',
        resourceId: expired.id,
        metadata: {
          listingId,
          buyerId: expired.buyerId,
          previousStatus: 'PENDING',
          expiresAt: expired.expiresAt,
          expiredDuringPromotion: true,
        },
      });
    }
  }

  const listingForPromotion = await tx.listing.findUnique({
    where: { id: listingId },
    select: { availableQuantity: true },
  });
  const availableQuantity = Number(listingForPromotion?.availableQuantity);

  const next = await tx.offer.findFirst({
    where: {
      listingId,
      status: 'PENDING',
      quantity: { gt: 0, lte: Number.isFinite(availableQuantity) ? availableQuantity : 0 },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    orderBy: [
      { amount: 'desc' },
      { createdAt: 'asc' },
    ],
  });

  if (!next) {
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'ACTIVE' },
    });
    return null;
  }

  const selectedClaim = await tx.offer.updateMany({
    where: {
      id: next.id,
      status: 'PENDING',
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    data: { status: 'SELECTED' },
  });

  if (selectedClaim.count !== 1) {
    // Another concurrent workflow claimed or expired this bid. Do not leave
    // the listing in an incorrect state; the caller may retry promotion.
    return null;
  }

  const selected = await tx.offer.findUnique({ where: { id: next.id } });

  await tx.listing.update({
    where: { id: listingId },
    data: { status: 'UNDER_NEGOTIATION' },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'WAITING_BUYER_PROMOTED',
    resourceType: 'Offer',
    resourceId: selected.id,
    metadata: { listingId, buyerId: selected.buyerId },
  });

  return selected;
}

async function cancelOrderInTransaction(tx, { order, actorId = null, reason = null, cancelledByRole }) {
  if (!order || NON_CANCELLABLE_STATUSES.includes(order.status)) {
    throw Object.assign(new Error('Order is no longer cancellable'), { status: 409 });
  }

  const previousOrderStatus = order.status;

  if (cancelledByRole !== 'ADMIN' && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(order.transportJob?.status)) {
    throw Object.assign(new Error('Goods are already in transit or delivered for this order. Raise a dispute instead of cancelling.'), { status: 400, code: 'TRANSPORT_MOVEMENT_STARTED' });
  }

  await transitionOrderStatus(
    tx,
    order.id,
    order.status,
    'CANCELLED'
  );

  await tx.order.updateMany({ where: { id: order.id }, data: { buyerDecisionDueAt: null } });

  await tx.paymentObligation.updateMany({
    where: { orderId: order.id, status: 'OPEN' },
    data: { status: 'CANCELLED' },
  });

  await recordOrderEvent(tx, {
    orderId: order.id,
    actorId,
    type: 'ORDER_CANCELLED',
    fromStatus: order.status,
    toStatus: 'CANCELLED',
    metadata: { reason, cancelledByRole },
  });

  // Only a paid/CONFIRMED order ever consumed agricultural inventory. A
  // PENDING_PAYMENT provisional winner must leave availableQuantity untouched.
  const restoredListing = await releaseListingQuantity(tx, {
    ...order,
    payments: order.payments || [],
  });
  if (!restoredListing && previousOrderStatus !== 'PENDING_PAYMENT') {
    await tx.listing.update({
      where: { id: order.listingId },
      data: { status: 'ACTIVE' },
    });
  }

  // Freeze/cancel every operational sub-resource with the order. This is
  // especially important when cancellation is the outcome of a dispute: an
  // inspector must not be able to continue an inspection, a truck owner must
  // not continue transport proceedings, and a quote must not be accepted
  // after the buyer's transaction has been unwound.
  if (order.transportJob && !['DELIVERED', 'CANCELLED'].includes(order.transportJob.status)) {
    await tx.transportJob.update({
      where: { id: order.transportJob.id },
      data: { status: 'CANCELLED', workflowDueAt: null },
    });
    await tx.transportQuote.updateMany({
      where: {
        transportJobId: order.transportJob.id,
        status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
      },
      data: { status: 'REJECTED' },
    });
    if (order.transportJob.truckId) {
      await tx.truck.updateMany({
        where: {
          id: order.transportJob.truckId,
          availability: 'BUSY',
        },
        data: { availability: 'AVAILABLE' },
      });
    }
  }

  await tx.inspectionRequest.updateMany({
    where: { orderId: order.id, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED' },
  });

  // Close any open inspection negotiations so they cannot be accepted after
  // the order has been cancelled.
  await tx.inspectionQuote.updateMany({
    where: {
      inspectionRequest: { orderId: order.id },
      status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] },
    },
    data: { status: 'REJECTED' },
  });

  // The buyer is about to be refunded, so nobody may still be paid from this
  // order: cancel every payout that has not actually been paid out.
  const cancelledPayouts = await cancelPayoutsForOrder(tx, {
    orderId: order.id,
    actorId,
    reason: reason || 'Order cancellation',
  });

  // Create durable refund requests for paid funds. A refund is only marked
  // REFUNDED after the payment provider (or an authorized admin settlement
  // flow) confirms completion.
  //
  // The order's payments are re-read inside the transaction so installment
  // fields are always present, whatever the caller selected.
  const allPaidOrderPayments = await tx.payment.findMany({
    where: { orderId: order.id, status: 'PAID' },
  });

  // Installment plans (goods paid in installments): the full-price parent has
  // no provider transaction, so it is never refunded directly. Each paid
  // installment is refunded on its own, and the parent is marked REFUNDED once
  // the last of them completes (see refund completion). Unpaid installments
  // and an unsettled parent are closed so they can no longer be paid.
  const planParents = allPaidOrderPayments.filter(isInstallmentParent);
  const paidOrderPayments = allPaidOrderPayments.filter((p) => !isInstallmentParent(p));

  for (const parent of planParents) {
    await tx.payment.updateMany({
      where: { id: parent.id, status: 'PAID' },
      data: { status: 'REFUND_PENDING' },
    });
  }

  await tx.payment.updateMany({
    where: {
      orderId: order.id,
      status: 'PENDING',
      OR: [
        { installmentCount: { not: null } },
        { type: 'MARKETPLACE_INSTALLMENT' },
      ],
    },
    data: { status: 'FAILED' },
  });

  const paidTransportPayments = order.transportJob
    ? await tx.payment.findMany({ where: { transportJobId: order.transportJob.id, status: 'PAID' } })
    : [];
  const toRefund = [...paidOrderPayments, ...paidTransportPayments];
  const refundRequests = [];
  for (const payment of toRefund) {
    const refund = await requestRefund(tx, {
      paymentId: payment.id,
      amount: payment.amount,
      reason: reason || 'Order cancellation',
      requestedById: actorId,
    });
    refundRequests.push(refund);
  }

  // A buyer who cancels before payment was only a provisional winner. Close
  // that accepted negotiation thread so it cannot block the buyer from
  // submitting a fresh offer later. Historical parent offers remain intact.
  if (previousOrderStatus === 'PENDING_PAYMENT' && order.agreedOfferId) {
    await tx.offer.updateMany({
      where: {
        id: order.agreedOfferId,
        status: 'ACCEPTED',
      },
      data: { status: 'WITHDRAWN' },
    });
  }

  // Keep the listing public and immediately promote the next valid waiting
  // buyer so the seller does not have to restart the competition manually.
  if (previousOrderStatus === 'PENDING_PAYMENT') {
    await promoteNextWaitingBuyer(tx, order.listingId, actorId);
  }

  await recordAuditEvent(tx, {
    actorId,
    action: 'ORDER_CANCELLED',
    resourceType: 'Order',
    resourceId: order.id,
    metadata: {
      fromStatus: order.status,
      toStatus: 'CANCELLED',
      cancelledByRole,
      reason,
      refundedPaymentIds: toRefund.map((p) => p.id),
      cancelledPayoutIds: cancelledPayouts.map((p) => p.id),
    },
  });

  return tx.order.findUnique({ where: { id: order.id } });
}

module.exports = { cancelOrderInTransaction, NON_CANCELLABLE_STATUSES, promoteNextWaitingBuyer };
