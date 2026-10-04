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

const chapaConfig = require('../config/chapa');

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
  const durable = order.paymentObligations || [];

  const findObligation = (type, inspectionRequestId = null, transportJobId = null) =>
    durable.find((o) =>
      o.type === type &&
      (type !== 'INSPECTOR' || o.inspectionRequestId === inspectionRequestId) &&
      (type !== 'TRANSPORT' || o.transportJobId === transportJobId)
    );

  const marketplaceObligation = findObligation('MARKETPLACE');
  const marketplace = {
    type: 'MARKETPLACE',
    label: 'Goods payment',
    required: true,
    amount: marketplaceObligation?.amount ?? order.finalPrice,
    paid: marketplaceObligation?.status === 'PAID' ||
      isPaid(orderPayments, 'MARKETPLACE'),
    payerRole: 'BUYER',
    payerId: marketplaceObligation?.payerId || order.buyerId,
    beneficiaryRole: 'SELLER',
    beneficiaryId: marketplaceObligation?.beneficiaryId || order.sellerId,
    obligationId: marketplaceObligation?.id || null,
    // Largest single amount the payment provider accepts. The UI shows this
    // before the buyer tries to pay an amount above it.
    maxOnlineAmount: chapaConfig.getMaxTransactionAmount(),
  };

  const inspectionRequests = (order.listing?.inspectionRequests || order.inspectionRequests || [])
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // One active inspection workflow is the business rule. Keep the newest
  // request as the canonical request in the read model so legacy duplicate
  // requests cannot make a completed inspection appear incomplete.
  const currentInspectionRequest = inspectionRequests[0] || null;
  const currentInspectionRequests = currentInspectionRequest ? [currentInspectionRequest] : [];

  const inspections = currentInspectionRequests
    .filter((r) => r.fee != null && Number(r.fee) > 0)
    .map((r) => {
      const o = findObligation('INSPECTOR', r.id);
      return {
        type: 'INSPECTOR',
        label: 'Inspection fee',
        inspectionRequestId: r.id,
        requestedById: r.requestedById,
        mode: r.mode,
        required: true,
        amount: o?.amount ?? r.fee,
        paid: o?.status === 'PAID' ||
          isPaid(r.payments, 'INSPECTOR'),
        payerRole: r.mode === 'SELLER_REQUESTED' ? 'SELLER' : 'BUYER',
        payerId: o?.payerId || (r.mode === 'SELLER_REQUESTED' ? order.sellerId : order.buyerId),
        beneficiaryRole: 'INSPECTOR',
        beneficiaryId: o?.beneficiaryId || r.inspectorId || null,
        inspectionStatus: r.status,
        obligationId: o?.id || null,
      };
    });

  const job = order.transportJob || null;
  const transportRequired = Boolean(job) && job.method === 'HIRE_TRANSPORTER';
  const transportObligation = job
    ? findObligation('TRANSPORT', null, job.id)
    : null;

  const transport = job
    ? {
        type: 'TRANSPORT',
        label: 'Transport payment',
        required: transportRequired,
        amount: transportObligation?.amount ?? (job.agreedAmount != null ? job.agreedAmount : null),
        paid: !transportRequired ||
          transportObligation?.status === 'PAID' ||
          isPaid(orderPayments, 'TRANSPORT'),
        payerRole: 'BUYER',
        payerId: transportObligation?.payerId || order.buyerId,
        beneficiaryRole: 'TRUCK_OWNER',
        beneficiaryId: transportObligation?.beneficiaryId || job.truckOwnerId || null,
        obligationId: transportObligation?.id || null,
      }
    : null;

  const allInspectionsPaid = inspections.every((o) => o.paid);
  const allInspectionsCompleted =
    currentInspectionRequest == null ||
    (currentInspectionRequest.status === 'COMPLETED' && Boolean(currentInspectionRequest.report));
  const transportPaid = !transport || transport.paid;

  return {
    marketplace,
    inspections,
    transport,
    inspectionRequestsExist: currentInspectionRequests.length > 0,
    inspectionRequests: currentInspectionRequests.map((r) => ({
      id: r.id,
      status: r.status,
      inspectorId: r.inspectorId,
      requestedById: r.requestedById,
      fee: r.fee,
    })),
    allInspectionsPaid,
    allInspectionsCompleted,
    allPaid: marketplace.paid && allInspectionsPaid && transportPaid,
    durableObligations: durable.map((o) => ({
      id: o.id,
      type: o.type,
      amount: o.amount,
      status: o.status,
      payerId: o.payerId,
      beneficiaryId: o.beneficiaryId,
      inspectionRequestId: o.inspectionRequestId,
      transportJobId: o.transportJobId,
      paymentId: o.payment?.id || null,
    })),
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
  const category = order.listing?.category;
  const inspectionRequired = ['AGRICULTURAL', 'PRODUCT'].includes(category);
  const inspection = (order.inspectionRequests || order.listing?.inspectionRequests || [])
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const currentInspection = inspection[inspection.length - 1] || null;
  const reportCompleted = payments.allInspectionsCompleted;
  const inspectionPaid = payments.allInspectionsPaid;
  const buyerDecisionRequired = ['AGRICULTURAL', 'PRODUCT'].includes(category);
  const buyerDecisionMade = !buyerDecisionRequired || Boolean(order.buyerDecision);
  const buyerApproved = !buyerDecisionRequired || order.buyerDecision === 'BUY';
  const goodsPaid = payments.marketplace.paid;
  const transportExists = Boolean(job);
  const transportAccepted = transportExists && !['REQUESTED', 'QUOTED', 'CANCELLED'].includes(job.status);
  const transportPaid = payments.transport ? payments.transport.paid : true;
  const pickupStarted = transportExists && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status);
  const inTransit = transportExists && ['IN_TRANSIT', 'DELIVERED'].includes(job.status);
  const delivered = transportExists && job.status === 'DELIVERED';
  const completed = order.status === 'COMPLETED';

  // Explicit state prevents the frontend from guessing the current step from
  // array position. This matters when a later business gate is already
  // satisfied, or when a stage has been created but is waiting on another
  // party (e.g. an inspection quote or transport provider).
  const state = (completed, current = false) =>
    completed ? 'COMPLETED' : current ? 'CURRENT' : 'PENDING';

  const steps = [];

  steps.push({
    code: 'ORDER_CREATED',
    label: 'Negotiated deal / order created',
    completed: true,
    state: 'COMPLETED',
    at: order.agreedAt || order.createdAt,
    detail: 'Seller and buyer have a provisional negotiated agreement.',
  });

  if (inspectionRequired) {
    const requestCreated = Boolean(currentInspection);
    const inspectionAccepted = currentInspection?.status === 'ACCEPTED' ||
      currentInspection?.status === 'IN_PROGRESS' ||
      currentInspection?.status === 'COMPLETED';
    const inspectionInProgress = currentInspection?.status === 'IN_PROGRESS';

    steps.push({
      code: 'INSPECTION_REQUESTED',
      label: 'Inspection requested',
      completed: requestCreated,
      state: state(requestCreated, !requestCreated),
      at: currentInspection?.createdAt || null,
      detail: requestCreated ? 'An order inspection request exists.' : 'Create the inspection request to continue.',
    });

    steps.push({
      code: 'INSPECTION_ACCEPTED',
      label: 'Inspector selected / accepted',
      completed: inspectionAccepted,
      state: state(inspectionAccepted, requestCreated && !inspectionAccepted),
      at: currentInspection?.updatedAt || null,
      detail: inspectionAccepted ? 'An inspector has accepted the inspection.' : 'Waiting for an inspector to be selected and accepted.',
    });

    steps.push({
      code: 'INSPECTION_PAYMENT',
      label: 'Inspection payment',
      completed: inspectionPaid,
      state: state(inspectionPaid, inspectionAccepted && !inspectionPaid),
      at: null,
      detail: inspectionPaid ? 'Required inspection fee is paid.' : 'Inspection payment is required before the inspection can proceed.',
    });

    steps.push({
      code: 'INSPECTION_REPORT',
      label: 'Inspection report published',
      completed: reportCompleted,
      state: state(reportCompleted, inspectionPaid && !reportCompleted),
      at: currentInspection?.report?.inspectedAt || null,
      detail: reportCompleted ? 'The inspection report is available for review.' : inspectionInProgress ? 'The inspector is completing the report.' : 'Waiting for the inspection to be completed.',
    });

    if (buyerDecisionRequired) {
      steps.push({
        code: 'BUYER_DECISION',
        label: 'Buyer BUY / Cancel decision',
        completed: buyerDecisionMade,
        state: state(buyerDecisionMade, reportCompleted && !buyerDecisionMade),
        at: order.buyerDecisionAt || null,
        detail: order.buyerDecision === 'BUY'
          ? 'BUY recorded; seller payment is unlocked.'
          : order.buyerDecision === 'CANCEL'
            ? 'Buyer cancelled after reviewing the inspection.'
            : 'Buyer must review the report before choosing BUY or Cancel.',
      });
    }
  }

  steps.push({
    code: 'GOODS_PAYMENT',
    label: 'Goods payment',
    completed: goodsPaid,
    state: state(goodsPaid, buyerApproved && (!inspectionRequired || reportCompleted) && !goodsPaid),
    at: null,
    detail: goodsPaid ? 'Commercial payment for the negotiated goods is recorded.' : 'Goods payment is the commercial commitment that unlocks fulfillment.',
  });

  steps.push({
    code: 'TRANSPORT_ARRANGEMENT',
    label: 'Transport arranged',
    completed: transportExists,
    state: state(transportExists, goodsPaid && !transportExists),
    at: job?.createdAt || null,
    detail: transportExists ? 'A transport job has been created.' : 'Transport can be arranged after the goods payment gate.',
  });

  if (job) {
    steps.push({
      code: 'TRANSPORT_ACCEPTED',
      label: 'Transport accepted',
      completed: transportAccepted,
      state: state(transportAccepted, ['REQUESTED', 'QUOTED'].includes(job.status)),
      at: null,
      detail: transportAccepted ? 'The selected transport arrangement is accepted.' : 'Waiting for transport selection / acceptance.',
    });

    if (payments.transport?.required) {
      steps.push({
        code: 'TRANSPORT_PAYMENT',
        label: 'Transport payment',
        completed: transportPaid,
        state: state(transportPaid, transportAccepted && !transportPaid),
        at: null,
        detail: transportPaid ? 'Transport payment is recorded.' : 'Transport payment is required before pickup.',
      });
    }

    steps.push({
      code: 'PICKUP',
      label: 'Pickup confirmed',
      completed: pickupStarted,
      state: state(pickupStarted, transportAccepted && transportPaid && !pickupStarted),
      at: job.pickupConfirmedAt || null,
      detail: pickupStarted ? 'The goods have been picked up.' : 'Waiting for pickup and required evidence.',
    });

    steps.push({
      code: 'IN_TRANSIT',
      label: 'In transit',
      completed: inTransit,
      state: state(inTransit, pickupStarted && !inTransit),
      at: null,
      detail: inTransit ? 'The goods are moving to the buyer.' : 'Transport has not yet entered transit.',
    });

    steps.push({
      code: 'DELIVERED',
      label: 'Delivered',
      completed: delivered,
      state: state(delivered, inTransit && !delivered),
      at: job.deliveredConfirmedAt || null,
      detail: delivered ? 'Delivery has been confirmed.' : 'Waiting for delivery confirmation.',
    });
  }

  steps.push({
    code: 'COMPLETED',
    label: 'Buyer receipt confirmed / order completed',
    completed,
    state: state(completed, delivered && !completed),
    at: null,
    detail: completed ? 'The order lifecycle is complete.' : 'Buyer confirmation of receipt is the final completion gate.',
  });

  const events = (order.events || []).map((event) => ({
    id: event.id,
    type: event.type,
    at: event.createdAt,
    actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    metadata: event.metadata || null,
  }));

  return { steps, events };
}

// ----------------------------------------------------------------------------
// STAGE
// ----------------------------------------------------------------------------

function computeStage(order, payments) {
  // Defensive guard for legacy/direct product orders.
  if (order.listing?.category === 'PRODUCT' && !order.agreedOfferId) {
    return 'NEGOTIATION_REQUIRED';
  }
  if (order.status === 'CANCELLED') return 'CANCELLED';
  if (order.status === 'DISPUTED') return 'DISPUTED';
  if (order.status === 'COMPLETED') return 'COMPLETED';

  const job = order.transportJob || null;
  const agricultural = order.listing?.category === 'AGRICULTURAL';
  const inspectionRequired = ['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category);

  // Agricultural and product orders use the same inspection gate. The
  // completed report must be available before the goods payment becomes a
  // commercial commitment. Agricultural orders additionally require the
  // explicit BUY decision after the report is reviewed.
  if (inspectionRequired) {
    // No active inspection request: inspection must be requested before the
    // buyer can make the commercial decision or pay for the produce.
    if (!payments.inspectionRequestsExist) return 'INSPECTION_REQUEST';

    if (!payments.allInspectionsCompleted) {
      const current = (payments.inspectionRequests || [])[0];
      if (current?.status === 'ACCEPTED' && payments.inspections.some((i) => !i.paid)) {
        return 'INSPECTION_PAYMENT';
      }
      return 'INSPECTION';
    }

    // Both Agricultural and Product orders require an explicit BUY/CANCEL
    // decision after the inspection report is reviewed. BUY unlocks goods
    // payment; CANCEL closes the provisional purchase.
    if (inspectionRequired && !order.buyerDecision) return 'BUYER_DECISION';

    if (!payments.marketplace.paid && !job) {
      return 'GOODS_PAYMENT';
    }
  }

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
  if (order.listing?.category === 'PRODUCT' && !order.agreedOfferId) {
    return [{
      code: 'NEGOTIATION_REQUIRED',
      label: 'Continue bidding & negotiation',
      actorRole: 'BUYER',
      reason: 'This product must be won through seller bidding and negotiation before payment.',
      route: { method: 'GET', path: `/listings/${order.listingId}` },
    }];
  }
  const { isBuyer, isSeller, isTruckOwner, isInspector, isAdmin } = viewer;
  const job = order.transportJob || null;
  const terminal = TERMINAL_ORDER_STATUSES.includes(order.status);
  const actions = [];

  const push = (action) => actions.push({ reason: null, ...action, enabled: action.ready && action.viewerCanPerform });

  // 1. Inspection workflow for agricultural and physical product orders. Inspection actions are executable
  // from the order Action Center so an assigned inspector is never stranded
  // on a generic dashboard link.
  const inspectionRequests = (order.listing?.inspectionRequests || order.inspectionRequests || [])
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const currentInspectionRequest = inspectionRequests[0] || null;

  for (const request of currentInspectionRequest ? [currentInspectionRequest] : []) {
    const assignedToViewer = request.inspectorId === viewer.userId;
    const requesterCanManage = request.requestedById === viewer.userId || isBuyer || isSeller || isAdmin;

    if (request.status === 'REQUESTED' && requesterCanManage) {
      const pendingQuotes = (request.quotes || []).filter((q) =>
        ['PENDING', 'COUNTERED'].includes(q.status)
      );
      push({
        code: 'REVIEW_INSPECTION_QUOTES',
        label: 'Review inspection quotes',
        actorRole: 'BUYER_OR_SELLER',
        inspectionRequestId: request.id,
        viewerCanPerform: true,
        ready: pendingQuotes.length > 0,
        reason: pendingQuotes.length ? null : 'Waiting for an inspector quote',
        pendingQuoteCount: pendingQuotes.length,
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    if (request.status === 'ACCEPTED' && assignedToViewer) {
      push({
        code: 'START_INSPECTION',
        label: 'Start inspection',
        actorRole: 'INSPECTOR',
        inspectionRequestId: request.id,
        viewerCanPerform: isInspector,
        ready: true,
        route: { method: 'POST', path: `/inspections/${request.id}/start` },
      });
    }

    if (request.status === 'IN_PROGRESS' && assignedToViewer) {
      push({
        code: 'SUBMIT_INSPECTION_REPORT',
        label: 'Complete inspection report',
        actorRole: 'INSPECTOR',
        inspectionRequestId: request.id,
        viewerCanPerform: isInspector,
        ready: true,
        route: { method: 'POST', path: `/inspections/${request.id}/report` },
      });
    }
  }

  // 2. If no inspection exists yet, keep the buyer in the inspection-request
  // stage. The detailed inspection form lives in OrderDetail, so this action
  // is a navigation hint rather than a payment mutation.
  if (['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category) && !payments.inspectionRequestsExist && !terminal) {
    push({
      code: 'REQUEST_INSPECTION',
      label: 'Request inspection',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller,
      ready: true,
      route: null,
    });
  }

  // 3. Buyer purchase decision for both marketplaces. This is a real
  // server-side mutation: the buyer must review the completed inspection
  // report and explicitly choose BUY or CANCEL before goods payment.
  if (['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category) && !order.buyerDecision && !terminal) {
    const decisionReady = payments.inspectionRequestsExist && payments.allInspectionsCompleted;
    const decisionReason = !payments.inspectionRequestsExist
      ? 'Complete the inspection before choosing BUY or CANCEL'
      : !payments.allInspectionsCompleted
        ? 'Review the published inspection report before choosing BUY or CANCEL'
        : null;

    push({
      code: 'BUYER_DECISION_BUY',
      label: 'BUY — continue purchase',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready: decisionReady,
      reason: decisionReason,
      route: {
        method: 'PATCH',
        path: `/orders/${order.id}/buyer-decision`,
        body: { decision: 'BUY' },
      },
    });

    push({
      code: 'BUYER_DECISION_CANCEL',
      label: 'Cancel after inspection',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready: decisionReady,
      reason: decisionReason,
      route: {
        method: 'PATCH',
        path: `/orders/${order.id}/buyer-decision`,
        body: { decision: 'CANCEL' },
      },
    });
  }

  // 3. Pay for the goods. Both marketplaces require the explicit BUY
  // decision after a completed inspection report. The same rule is enforced
  // server-side in /payments.
  if (!payments.marketplace.paid) {
    const decisionRequired = ['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category);
    const inspectionRequired = decisionRequired;
    const ready = !terminal && (!decisionRequired || order.buyerDecision === 'BUY') &&
      (!inspectionRequired || payments.allInspectionsCompleted);
    push({
      code: 'PAY_MARKETPLACE',
      label: 'Pay for goods',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready,
      reason: terminal
        ? 'Order is no longer active'
        : inspectionRequired && !payments.allInspectionsCompleted
          ? 'Complete the required inspection before paying for the goods'
          : decisionRequired && order.buyerDecision !== 'BUY'
            ? 'Choose BUY after reviewing the inspection report'
            : null,
      route: {
        method: 'POST',
        path: '/payments',
        body: { type: 'MARKETPLACE', orderId: order.id, amount: payments.marketplace.amount },
      },
    });
  }

  // 4. Pay each fee-bearing inspection.
  for (const obligation of payments.inspections) {
    if (obligation.paid) continue;
    const viewerIsRequester = obligation.requestedById === viewer.userId;
    const inspectionRequest = (order.inspectionRequests || []).find((r) => r.id === obligation.inspectionRequestId);
    const inspectionPayerId = inspectionRequest?.mode === 'SELLER_REQUESTED' ? order.sellerId : order.buyerId;
    push({
      code: 'PAY_INSPECTION',
      label: 'Pay inspection fee',
      actorRole: inspectionRequest?.mode === 'SELLER_REQUESTED' ? 'SELLER' : 'BUYER',
      inspectionRequestId: obligation.inspectionRequestId,
      viewerCanPerform: viewer.userId === inspectionPayerId || (viewerIsRequester && !order.id),
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
    const buyerDecisionReady = !['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category) || order.buyerDecision === 'BUY';
    const ready = !terminal && buyerDecisionReady && payments.marketplace.paid && ['CONFIRMED', 'PENDING_PAYMENT'].includes(order.status);
    push({
      code: 'ARRANGE_TRANSPORT',
      label: 'Arrange transport',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller,
      ready,
      reason: ready ? null : (!buyerDecisionReady ? 'Choose BUY before arranging transport' : !payments.marketplace.paid ? 'Pay the seller for the agreed produce before arranging transport' : `Transport cannot be arranged while order is ${order.status}`),
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

  // 10. Raise a dispute — available to every participant on an active order,
  // including the assigned inspector. The dispute endpoint uses the same
  // participant model, so the inspector cannot be stranded outside the
  // dispute workflow.
  if (!terminal) {
    push({
      code: 'RAISE_DISPUTE',
      label: 'Raise a dispute',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller || isTruckOwner || isInspector,
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
  const isInspector = Boolean(
    order.listing?.inspectionRequests?.some((request) => request.inspectorId === viewerUserId)
  );
  const isAdmin = (viewerRoles || []).includes('ADMIN');

  const viewer = { userId: viewerUserId, isBuyer, isSeller, isTruckOwner, isInspector, isAdmin };

  const payments = buildPaymentSnapshot(order);
  const currentStage = computeStage(order, payments);
  const timeline = buildTimeline(order, payments);
  const actions = buildActions(order, payments, viewer);

  const nextReadyAction = actions.find((a) => a.ready) || null;

  return {
    orderId: order.id,
    orderStatus: order.status,
    buyerDecision: order.buyerDecision || null,
    buyerDecisionAt: order.buyerDecisionAt || null,
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
      : isInspector
      ? 'INSPECTOR'
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
