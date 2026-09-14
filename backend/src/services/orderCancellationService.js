'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { releaseListingQuantity } = require('./inventoryService');
const { requestRefund } = require('./paymentRefundService');

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
async function cancelOrderInTransaction(tx, { order, actorId = null, reason = null, cancelledByRole }) {
  if (!order || NON_CANCELLABLE_STATUSES.includes(order.status)) {
    throw Object.assign(new Error('Order is no longer cancellable'), { status: 409 });
  }

  await tx.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED' },
  });

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

  // Return allocated agricultural quantity to inventory. Generic products
  // remain whole-listing sales and simply become ACTIVE again.
  const restoredListing = await releaseListingQuantity(tx, order);
  if (!restoredListing) {
    await tx.listing.update({
      where: { id: order.listingId },
      data: { status: 'ACTIVE', availableQuantity: order.quantity },
    });
  }

  // Cascade-cancel a transport job that hasn't moved yet.
  if (order.transportJob && !['DELIVERED', 'CANCELLED'].includes(order.transportJob.status)) {
    await tx.transportJob.update({
      where: { id: order.transportJob.id },
      data: { status: 'CANCELLED' },
    });
  }

  // Create durable refund requests for paid funds. A refund is only marked
  // REFUNDED after the payment provider (or an authorized admin settlement
  // flow) confirms completion.
  const paidOrderPayments = (order.payments || []).filter((p) => p.status === 'PAID');
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
    },
  });

  return tx.order.findUnique({ where: { id: order.id } });
}

module.exports = { cancelOrderInTransaction, NON_CANCELLABLE_STATUSES };
