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
  TRANSPORT_ARRANGED: new Set(['DELIVERED', 'CANCELLED', 'DISPUTED']),
  IN_TRANSIT: new Set(['DELIVERED', 'DISPUTED']),
  DELIVERED: new Set(['COMPLETED', 'DISPUTED']),
  COMPLETED: new Set(),
  DISPUTED: new Set(['COMPLETED', 'CANCELLED']),
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

module.exports = {
  ORDER_TRANSITIONS,
  DISPUTABLE_STATUSES,
  canTransitionOrder,
  assertOrderTransition,
  transitionOrderStatus,
};
