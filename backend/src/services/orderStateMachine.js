'use strict';

/**
 * Strict order lifecycle.
 *
 * Order status is a business state, not a free-form field. Every mutation
 * must move through one of the transitions below. This protects the
 * marketplace from impossible states such as DELIVERED -> CONFIRMED.
 *
 * Cancellation/dispute are terminal exits handled by the cancellation/
 * dispute workflows, but are explicitly permitted only from states where
 * those workflows can safely unwind the order.
 */
const ORDER_TRANSITIONS = Object.freeze({
  PENDING_PAYMENT: new Set(['CONFIRMED', 'CANCELLED', 'DISPUTED']),
  CONFIRMED: new Set(['TRANSPORT_ARRANGED', 'CANCELLED', 'DISPUTED']),
  TRANSPORT_ARRANGED: new Set(['IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'DISPUTED']),
  IN_TRANSIT: new Set(['DELIVERED', 'DISPUTED']),
  DELIVERED: new Set(['COMPLETED', 'DISPUTED']),
  COMPLETED: new Set(),
  // A dispute must be able to resolve back into whichever state the order
  // was in when it was raised (dispute.previousOrderStatus), not just into
  // a terminal state — otherwise every dispute resolution/rejection whose
  // previousOrderStatus was PENDING_PAYMENT/CONFIRMED/TRANSPORT_ARRANGED/
  // IN_TRANSIT/DELIVERED fails with "Invalid order status transition".
  DISPUTED: new Set(['PENDING_PAYMENT', 'CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED']),
  CANCELLED: new Set(),
});

function canTransitionOrder(from, to) {
  if (from === to) return true;
  return Boolean(ORDER_TRANSITIONS[from]?.has(to));
}

// Order statuses from which a dispute may be opened — derived directly from
// ORDER_TRANSITIONS (every status that can move into DISPUTED) so this list
// can never silently drift out of sync with what the state machine itself
// actually allows.
const DISPUTABLE_STATUSES = Object.keys(ORDER_TRANSITIONS).filter((status) =>
  ORDER_TRANSITIONS[status].has('DISPUTED')
);

function assertOrderTransition(from, to) {
  if (!canTransitionOrder(from, to)) {
    const error = new Error(`Invalid order status transition: ${from} -> ${to}`);
    error.status = 409;
    error.code = 'INVALID_ORDER_TRANSITION';
    throw error;
  }
  return true;
}

/**
 * Performs an optimistic/concurrency-safe status transition. The WHERE clause
 * ensures another transaction cannot overwrite a newer order state.
 */
async function transitionOrderStatus(tx, orderId, from, to, extraData = {}) {
  assertOrderTransition(from, to);

  const result = await tx.order.updateMany({
    where: { id: orderId, status: from },
    data: { status: to, ...extraData },
  });

  if (result.count !== 1) {
    const error = new Error(
      `Order changed before transition could be applied: expected ${from}`
    );
    error.status = 409;
    error.code = 'ORDER_STATE_CONFLICT';
    throw error;
  }

  return tx.order.findUnique({ where: { id: orderId } });
}

// Guards an action against a narrow race where a dispute or cancellation
// lands on the order in the moment between a caller's pre-check and their
// actual write. A plain SELECT there doesn't help: Postgres only serializes
// against a concurrent writer for statements that take a lock on the row,
// so this takes one explicitly (mirroring the implicit lock
// transitionOrderStatus's own UPDATE above already takes) and re-reads
// status under that lock, inside the same transaction as the caller's
// write. Whichever transaction — this one or the dispute/cancel one — asks
// for the lock first wins; the other blocks until it commits, then sees the
// real, current status instead of a stale pre-check result.
//
// Used anywhere a party can still act on a sub-resource (an inspection, a
// transport quote) that a dispute doesn't itself freeze — holdForDispute
// only touches Payout rows, so nothing else stops a transport job or
// inspection from progressing on an order that just became DISPUTED unless
// the specific route checks for it.
async function lockOrderAndAssertNotClosed(tx, orderId, actionLabel) {
  if (!orderId) return; // some flows have no order to race against
  const rows = await tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  const status = rows?.[0]?.status;
  if (status && ['DISPUTED', 'CANCELLED'].includes(status)) {
    throw Object.assign(
      new Error(`This order is ${status.toLowerCase()}, so ${actionLabel}.`),
      { status: 409, code: 'ORDER_NOT_ACTIONABLE' }
    );
  }
}

module.exports = {
  ORDER_TRANSITIONS,
  DISPUTABLE_STATUSES,
  canTransitionOrder,
  assertOrderTransition,
  transitionOrderStatus,
  lockOrderAndAssertNotClosed,
};
