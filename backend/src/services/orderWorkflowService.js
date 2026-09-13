'use strict';

// ============================================================================
// ORDER WORKFLOW SERVICE
// ============================================================================
//
// Server-authoritative view of "what stage is this order at, whose turn is
// it, and what can each party do right now".
//
// This is a *read model*: it derives everything from data that already
// exists (Order, TransportJob, Payment, InspectionRequest) rather than
// introducing new persisted state. Every route referenced in `actions[].route`
// already enforces its own rules independently — this service must never be
// treated as the authorization layer, only as a consistent summary of it so
// the frontend stops having to reconstruct these rules itself.
//
// Consumed by GET /orders/:id/workflow.
// ============================================================================

// Once an order reaches one of these, the transaction lifecycle is over.
const TERMINAL_ORDER_STATUSES = ['COMPLETED', 'CANCELLED', 'DISPUTED'];

// Mirrors the cancellation rules in routes/orders.js PATCH /:id/cancel.
const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];
const TRANSPORT_IN_MOTION_STATUSES = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];

function isPaid(payments, type) {
  return (payments || []).some((p) => p.type === type && p.status === 'PAID');
}

// ----------------------------------------------------------------------------
// PAYMENT OBLIGATIONS
// ----------------------------------------------------------------------------
// Mirrors the gating rules in routes/transport.js getTransportPaymentGate():
// goods payment, every fee-bearing inspection, and (when hired) transport.
// ----------------------------------------------------------------------------

function buildPaymentSnapshot(order) {
  const orderPayments = order.payments || [];

  const marketplace = {
    type: 'MARKETPLACE',
    label: 'Goods payment',
    required: true,
    amount: Number(order.finalPrice),
    paid: isPaid(orderPayments, 'MARKETPLACE'),
    payerRole: 'BUYER',
    beneficiaryRole: 'SELLER',
  };

  const inspectionRequests = (order.listing?.inspectionRequests || []).filter(
    (r) => r.status !== 'CANCELLED'
  );

  const inspections = inspectionRequests
    .filter((r) => r.fee != null && Number(r.fee) > 0)
    .map((r) => ({
      type: 'INSPECTOR',
      label: 'Inspection fee',
      inspectionRequestId: r.id,
      requestedById: r.requestedById,
      required: true,
      amount: Number(r.fee),
      paid: isPaid(r.payments, 'INSPECTOR'),
      payerRole: 'BUYER',
      beneficiaryRole: 'INSPECTOR',
      inspectionStatus: r.status,
    }));

  const job = order.transportJob || null;
  const transportRequired = Boolean(job) && job.method === 'HIRE_TRANSPORTER';

  const transport = job
    ? {
        type: 'TRANSPORT',
        label: 'Transport payment',
        required: transportRequired,
        amount: job.agreedAmount != null ? Number(job.agreedAmount) : null,
        paid: !transportRequired || isPaid(orderPayments, 'TRANSPORT'),
        payerRole: 'BUYER',
        beneficiaryRole: 'TRUCK_OWNER',
      }
    : null;

  const allInspectionsPaid = inspections.every((o) => o.paid);
  const allInspectionsCompleted =
    inspectionRequests.length === 0 ||
    inspectionRequests.every((r) => r.status === 'COMPLETED');
  const transportPaid = !transport || transport.paid;

  return {
    marketplace,
    inspections,
    transport,
    inspectionRequestsExist: inspectionRequests.length > 0,
    allInspectionsPaid,
    allInspectionsCompleted,
    allPaid: marketplace.paid && allInspectionsPaid && transportPaid,
  };
}

// ----------------------------------------------------------------------------
// TIMELINE
// ----------------------------------------------------------------------------
// Recommendation #5: Offer accepted -> Order created -> Inspection completed
// -> Transport accepted -> Payment -> Pickup -> In Transit -> Delivery ->
// Receipt -> Completed. Steps that don't apply to this order (no inspection,
// no transport job yet) are omitted rather than shown as permanently pending.
// ----------------------------------------------------------------------------

function buildTimeline(order, payments) {
  const job = order.transportJob || null;
  const steps = [];

  steps.push({
    code: 'ORDER_CREATED',
    label: 'Order created',
    completed: true,
    at: order.createdAt,
  });

  if (payments.inspectionRequestsExist) {
    steps.push({
      code: 'INSPECTION_COMPLETED',
      label: 'Inspection completed',
      completed: payments.allInspectionsCompleted,
      at: null,
    });
  }

  steps.push({
    code: 'GOODS_PAID',
    label: 'Goods payment received',
    completed: payments.marketplace.paid,
    at: null,
  });

  if (job) {
    steps.push({
      code: 'TRANSPORT_ACCEPTED',
      label: 'Transport accepted',
      completed: !['REQUESTED', 'QUOTED', 'CANCELLED'].includes(job.status),
      at: null,
    });

    if (payments.transport?.required) {
      steps.push({
        code: 'TRANSPORT_PAID',
        label: 'Transport payment received',
        completed: payments.transport.paid,
        at: null,
      });
    }

    steps.push({
      code: 'PICKUP',
      label: 'Pickup',
      completed: ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status),
      at: job.pickupConfirmedAt,
    });

    steps.push({
      code: 'IN_TRANSIT',
      label: 'In transit',
      completed: ['IN_TRANSIT', 'DELIVERED'].includes(job.status),
      at: null,
    });

    steps.push({
      code: 'DELIVERED',
      label: 'Delivered',
      completed: job.status === 'DELIVERED',
      at: job.deliveredConfirmedAt,
    });
  }

  steps.push({
    code: 'COMPLETED',
    label: 'Receipt confirmed / order completed',
    completed: order.status === 'COMPLETED',
    at: null,
  });

  return steps;
}

// ----------------------------------------------------------------------------
// STAGE
// ----------------------------------------------------------------------------

function computeStage(order, payments) {
  if (order.status === 'CANCELLED') return 'CANCELLED';
  if (order.status === 'DISPUTED') return 'DISPUTED';
  if (order.status === 'COMPLETED') return 'COMPLETED';

  const job = order.transportJob || null;

  if (!payments.marketplace.paid && !job) return 'PENDING_PAYMENT';
  if (!job) return payments.marketplace.paid ? 'ARRANGING_TRANSPORT' : 'PENDING_PAYMENT';

  if (['REQUESTED', 'QUOTED'].includes(job.status)) return 'ARRANGING_TRANSPORT';
  if (!payments.allPaid) return 'PAYMENT';
  if (job.status === 'ACCEPTED') return 'PICKUP_READY';
  if (job.status === 'PICKUP') return 'PICKED_UP';
  if (job.status === 'IN_TRANSIT') return 'IN_TRANSIT';
  if (job.status === 'DELIVERED') return 'AWAITING_RECEIPT';
  if (job.status === 'CANCELLED') return payments.marketplace.paid ? 'ARRANGING_TRANSPORT' : 'PENDING_PAYMENT';

  return 'PAYMENT';
}

// ----------------------------------------------------------------------------
// CANCELLATION ELIGIBILITY (mirrors PATCH /orders/:id/cancel)
// ----------------------------------------------------------------------------

function cancelEligibility(order, isBuyer, isSeller, isAdmin) {
  if (NON_CANCELLABLE_STATUSES.includes(order.status)) {
    return { ready: false, reason: `Order is already ${order.status.toLowerCase()}` };
  }
  if (order.transportJob && TRANSPORT_IN_MOTION_STATUSES.includes(order.transportJob.status)) {
    return { ready: false, reason: 'Goods are already in transit or delivered; raise a dispute instead' };
  }
  if (isAdmin) return { ready: true, reason: null };
  if (isBuyer && order.status !== 'PENDING_PAYMENT') {
    return { ready: false, reason: 'Buyer can only cancel before payment' };
  }
  if (isSeller && !['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)) {
    return { ready: false, reason: 'Seller can no longer cancel directly at this stage' };
  }
  if (!isBuyer && !isSeller) return { ready: false, reason: 'Not a party to this order' };
  return { ready: true, reason: null };
}

// ----------------------------------------------------------------------------
// ACTIONS
// ----------------------------------------------------------------------------

function buildActions(order, payments, viewer) {
  const { isBuyer, isSeller, isTruckOwner, isAdmin } = viewer;
  const job = order.transportJob || null;
  const terminal = TERMINAL_ORDER_STATUSES.includes(order.status);
  const actions = [];

  const push = (action) => actions.push({ reason: null, ...action, enabled: action.ready && action.viewerCanPerform });

  // 1. Pay for the goods.
  if (!payments.marketplace.paid) {
    push({
      code: 'PAY_MARKETPLACE',
      label: 'Pay for goods',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready: !terminal,
      reason: terminal ? 'Order is no longer active' : null,
      route: {
        method: 'POST',
        path: '/payments',
        body: { type: 'MARKETPLACE', orderId: order.id, amount: payments.marketplace.amount },
      },
    });
  }

  // 2. Pay each fee-bearing inspection.
  for (const obligation of payments.inspections) {
    if (obligation.paid) continue;
    const viewerIsRequester = obligation.requestedById === viewer.userId;
    push({
      code: 'PAY_INSPECTION',
      label: 'Pay inspection fee',
      actorRole: 'BUYER',
      inspectionRequestId: obligation.inspectionRequestId,
      viewerCanPerform: isBuyer || viewerIsRequester,
      ready: !terminal,
      reason: terminal ? 'Order is no longer active' : null,
      route: {
        method: 'POST',
        path: '/payments',
        body: { type: 'INSPECTOR', inspectionRequestId: obligation.inspectionRequestId, amount: obligation.amount },
      },
    });
  }

  // 3. Arrange transport if nothing has been set up yet.
  if (!job) {
    const ready = !terminal && ['CONFIRMED', 'PENDING_PAYMENT'].includes(order.status);
    push({
      code: 'ARRANGE_TRANSPORT',
      label: 'Arrange transport',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller,
      ready,
      reason: ready ? null : `Transport cannot be arranged while order is ${order.status}`,
      route: { method: 'POST', path: '/transport', body: { orderId: order.id } },
    });
  }

  // 4. Transport quotes awaiting a response from whoever arranged transport.
  if (job && job.method === 'HIRE_TRANSPORTER' && ['REQUESTED', 'QUOTED'].includes(job.status)) {
    const pendingQuotes = (job.quotes || []).filter((q) =>
      ['PENDING', 'COUNTERED'].includes(q.status) && q.counteredBy !== 'REQUESTER'
    );
    const arrangerCanAct =
      (job.arrangingParty === 'SELLER' && isSeller) ||
      (job.arrangingParty === 'BUYER' && isBuyer) ||
      (job.arrangingParty === 'JOINT' && (isBuyer || isSeller));
    push({
      code: 'REVIEW_TRANSPORT_QUOTES',
      label: 'Review transport quotes',
      actorRole: job.arrangingParty,
      viewerCanPerform: arrangerCanAct,
      ready: pendingQuotes.length > 0,
      reason: pendingQuotes.length > 0 ? null : 'No transport quotes awaiting a response',
      pendingQuoteCount: pendingQuotes.length,
      route: { method: 'GET', path: `/transport/${job.id}/quotes` },
    });
  }

  // 5. Pay the hired transporter.
  if (job && payments.transport?.required && !payments.transport.paid) {
    const ready = job.status === 'ACCEPTED' && job.agreedAmount != null;
    push({
      code: 'PAY_TRANSPORT',
      label: 'Pay transport',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready,
      reason: ready ? null : 'Transport must be accepted with an agreed amount before it can be paid',
      route: {
        method: 'POST',
        path: '/payments',
        body: { type: 'TRANSPORT', orderId: order.id, amount: payments.transport.amount },
      },
    });
  }

  // 6-8. Movement actions, owned by the assigned transporter.
  if (job) {
    const movementReady = {
      START_PICKUP: job.status === 'ACCEPTED' && payments.allPaid,
      MARK_IN_TRANSIT: job.status === 'PICKUP',
      MARK_DELIVERED: job.status === 'IN_TRANSIT',
    };

    if (job.status === 'ACCEPTED' || movementReady.START_PICKUP) {
      push({
        code: 'START_PICKUP',
        label: 'Start pickup',
        actorRole: 'TRUCK_OWNER',
        viewerCanPerform: isTruckOwner,
        ready: movementReady.START_PICKUP,
        reason: movementReady.START_PICKUP ? null : 'All required payments must be completed before pickup',
        route: { method: 'PATCH', path: `/transport/${job.id}/status`, body: { status: 'PICKUP' } },
      });
    }

    if (job.status === 'PICKUP') {
      push({
        code: 'MARK_IN_TRANSIT',
        label: 'Mark in transit',
        actorRole: 'TRUCK_OWNER',
        viewerCanPerform: isTruckOwner,
        ready: movementReady.MARK_IN_TRANSIT,
        reason: 'Requires pickup evidence to be uploaded first',
        route: { method: 'PATCH', path: `/transport/${job.id}/status`, body: { status: 'IN_TRANSIT' } },
      });
    }

    if (job.status === 'IN_TRANSIT') {
      push({
        code: 'MARK_DELIVERED',
        label: 'Mark delivered',
        actorRole: 'TRUCK_OWNER',
        viewerCanPerform: isTruckOwner,
        ready: movementReady.MARK_DELIVERED,
        reason: 'Requires delivery evidence to be uploaded first',
        route: { method: 'PATCH', path: `/transport/${job.id}/status`, body: { status: 'DELIVERED' } },
      });
    }
  }

  // 9. Buyer confirms receipt.
  if (!terminal) {
    const ready = Boolean(
      job && job.status === 'DELIVERED' && payments.allPaid
    );
    push({
      code: 'CONFIRM_RECEIPT',
      label: 'Confirm receipt',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready,
      reason: ready ? null : 'Goods must be marked delivered and fully paid for first',
      route: { method: 'PATCH', path: `/orders/${order.id}/confirm-receipt` },
    });
  }

  // 10. Raise a dispute — always available on an active order.
  if (!terminal) {
    push({
      code: 'RAISE_DISPUTE',
      label: 'Raise a dispute',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller,
      ready: true,
      route: { method: 'POST', path: '/disputes', body: { orderId: order.id } },
    });
  }

  // 11. Cancel the order.
  {
    const viewerEligibility = cancelEligibility(order, isBuyer, isSeller, isAdmin);
    const anyoneEligible =
      cancelEligibility(order, true, false, false).ready ||
      cancelEligibility(order, false, true, false).ready ||
      isAdmin;
    push({
      code: 'CANCEL_ORDER',
      label: 'Cancel order',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller || isAdmin,
      ready: anyoneEligible && viewerEligibility.ready,
      reason: viewerEligibility.reason,
      route: { method: 'PATCH', path: `/orders/${order.id}/cancel` },
    });
  }

  return actions;
}

// ----------------------------------------------------------------------------
// PUBLIC API
// ----------------------------------------------------------------------------

function computeOrderWorkflow(order, viewerUserId, viewerRoles = []) {
  const isBuyer = order.buyerId === viewerUserId;
  const isSeller = order.sellerId === viewerUserId;
  const isTruckOwner = order.transportJob?.truckOwnerId === viewerUserId;
  const isAdmin = (viewerRoles || []).includes('ADMIN');

  const viewer = { userId: viewerUserId, isBuyer, isSeller, isTruckOwner, isAdmin };

  const payments = buildPaymentSnapshot(order);
  const currentStage = computeStage(order, payments);
  const timeline = buildTimeline(order, payments);
  const actions = buildActions(order, payments, viewer);

  const nextReadyAction = actions.find((a) => a.ready) || null;

  return {
    orderId: order.id,
    orderStatus: order.status,
    currentStage,
    nextActor: nextReadyAction?.actorRole || null,
    viewerRole: isAdmin
      ? 'ADMIN'
      : isBuyer
      ? 'BUYER'
      : isSeller
      ? 'SELLER'
      : isTruckOwner
      ? 'TRUCK_OWNER'
      : 'OTHER',
    payments,
    transport: order.transportJob
      ? {
          id: order.transportJob.id,
          method: order.transportJob.method,
          status: order.transportJob.status,
          arrangingParty: order.transportJob.arrangingParty,
          truckOwnerId: order.transportJob.truckOwnerId,
          agreedAmount: order.transportJob.agreedAmount,
        }
      : null,
    timeline,
    actions,
  };
}

module.exports = { computeOrderWorkflow };
