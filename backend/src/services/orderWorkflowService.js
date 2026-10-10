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
//
// IMPORTANT: The caller (routes/orders.js GET /:id/workflow) must include
// `recoveryRequests` (status: PENDING) in the orderDetailInclude projection
// so the recovery actions can be suppressed when one is already awaiting
// admin review.
// ============================================================================

const chapaConfig = require('../config/chapa');

// Once an order reaches one of these, the transaction lifecycle is over.
const TERMINAL_ORDER_STATUSES = ['COMPLETED', 'CANCELLED', 'DISPUTED'];

// Mirrors the cancellation rules in routes/orders.js PATCH /:id/cancel.
const NON_CANCELLABLE_STATUSES = ['COMPLETED', 'CANCELLED'];
const TRANSPORT_IN_MOTION_STATUSES = ['PICKUP', 'IN_TRANSIT', 'DELIVERED'];

// ============================================================================
// RELEASE WINDOWS (mirror the backend services that enforce them)
// ============================================================================

const RELEASE_AFTER_ACCEPT_HOURS = (() => {
  const configured = Number(process.env.RELEASE_AFTER_ACCEPT_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

const SILENT_RELEASE_AFTER_HOURS = Object.freeze({
  INSPECTION: (() => {
    const configured = Number(process.env.INSPECTION_RELEASE_AFTER_HOURS);
    return Number.isFinite(configured) && configured >= 0 ? configured : 72;
  })(),
  TRANSPORT: (() => {
    const configured = Number(process.env.TRANSPORT_RELEASE_AFTER_HOURS);
    return Number.isFinite(configured) && configured >= 0 ? configured : 72;
  })(),
});

// ============================================================================
// NEGOTIATION HELPERS
// ============================================================================

// Immutable counter chains leave exactly one leaf per negotiation thread.
// Parent rows are history; the read model only reasons about leaves.
function leafQuotes(quotes) {
  return (quotes || []).filter((q) => (q._count?.childQuotes ?? 0) === 0);
}

// Whose turn is it on this quote? SELECTED means the requester has not yet
// accepted or countered the original bid. COUNTERED means the party named in
// `counteredBy` just acted, so the *other* party responds next.
function quoteTurn(quote) {
  if (!quote) return null;
  if (quote.status === 'SELECTED') return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function acceptedReleaseAvailableAt(quote) {
  if (!quote) return null;
  const since = new Date(quote.updatedAt || quote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + RELEASE_AFTER_ACCEPT_HOURS * 60 * 60 * 1000);
}

function silentReleaseAvailableAt(quote, hours) {
  if (!quote) return null;
  const since = new Date(quote.updatedAt || quote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + hours * 60 * 60 * 1000);
}

function isPast(date) {
  return Boolean(date) && date.getTime() <= Date.now();
}

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
    // Explicit record that the buyer reviewed the inspection report. Set at
    // the same moment as BUY; kept as a separate field so the buyer's
    // review is a first-class auditable event distinct from BUY/CANCEL.
    buyerReviewedReportAt: order.buyerReviewedReportAt || null,
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
      const obligations = durable.filter((o) => o.type === 'INSPECTOR' && o.inspectionRequestId === r.id);
      const fallbackPayerId = r.feePayer === 'SELLER' || r.mode === 'SELLER_REQUESTED' ? order.sellerId : order.buyerId;
      const totalAmount = Number(r.fee);
      const fallbackAmount = r.feePayer === 'SPLIT'
        ? null
        : totalAmount;
      const paid = obligations.length
        ? obligations.every((o) => o.status === 'PAID' || o.payment?.status === 'PAID')
        : (fallbackAmount != null && isPaid(r.payments, 'INSPECTOR'));
      return {
        type: 'INSPECTOR',
        label: 'Inspection fee',
        inspectionRequestId: r.id,
        requestedById: r.requestedById,
        mode: r.mode,
        feePayer: r.feePayer || (r.mode === 'SELLER_REQUESTED' ? 'SELLER' : 'BUYER'),
        required: true,
        amount: totalAmount,
        paid,
        payerRole: r.feePayer === 'SELLER' ? 'SELLER' : r.feePayer === 'SPLIT' ? 'BUYER_AND_SELLER' : 'BUYER',
        payerId: obligations.length === 1 ? obligations[0].payerId : fallbackPayerId,
        beneficiaryRole: 'INSPECTOR',
        beneficiaryId: r.inspectorId || null,
        inspectionStatus: r.status,
        obligationId: obligations.length === 1 ? obligations[0].id : null,
        termsLockedAt: r.feeTermsLockedAt || null,
        lockedFee: r.lockedFee != null ? Number(r.lockedFee) : null,
        lockedFeePayer: r.lockedFeePayer || null,
        sellerConfirmedAt: r.sellerConfirmedAt || null,
        inspectorOnSiteConfirmedAt: r.inspectorOnSiteConfirmedAt || null,
        obligations: obligations.map((o) => ({ id: o.id, payerId: o.payerId, amount: o.amount, status: o.status, paymentId: o.payment?.id || null })),
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
        sellerPickupConfirmedAt: job.sellerPickupConfirmedAt || null,
        truckArrivedAt: job.truckArrivedAt || null,
        acceptedReleaseCount: job.acceptedReleaseCount || 0,
      }
    : null;

  const allInspectionsPaid = inspections.every((o) => o.paid);
  const allInspectionsCompleted =
    currentInspectionRequest == null ||
    (currentInspectionRequest.status === 'COMPLETED' && Boolean(currentInspectionRequest.report));
  const transportPaid = !transport || transport.paid;

  // ---------------------------------------------------------------------------
  // BUYER-SAFE COORDINATION SUMMARY
  // ---------------------------------------------------------------------------
  // Seller <-> inspector site coordination is NOT buyer-visible. This object
  // only tells the buyer *whether* the operational handoff has started.
  // Never add sellerPhone, inspectorPhone, emails, sites, meeting points,
  // or availability slots here.
  const coordination = currentInspectionRequest
    ? {
        opened: ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(currentInspectionRequest.status),
        sellerSubmitted: Boolean(currentInspectionRequest.coordination?.sellerSubmittedAt),
        inspectorSubmitted: Boolean(currentInspectionRequest.coordination?.inspectorSubmittedAt),
        supersededAt: currentInspectionRequest.coordination?.supersededAt || null,
      }
    : null;

  return {
    authority: 'SERVER_WORKFLOW',
    workflowVersion: 2,
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
      sellerConfirmedAt: r.sellerConfirmedAt || null,
      inspectorOnSiteConfirmedAt: r.inspectorOnSiteConfirmedAt || null,
      workflowDueAt: r.workflowDueAt || null,
      acceptedReleaseCount: r.acceptedReleaseCount || 0,
    })),
    coordination,
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

function buildTimeline(order, payments) {
  const job = order.transportJob || null;
  const inspection = (order.inspectionRequests || order.listing?.inspectionRequests || [])
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const currentInspection = inspection[inspection.length - 1] || null;
  const inspectionRequired = Boolean(order.listing?.inspectionRequired || currentInspection);
  const reportCompleted = payments.allInspectionsCompleted;
  const inspectionPaid = payments.allInspectionsPaid;
  const buyerDecisionRequired = inspectionRequired;
  const buyerDecisionMade = !buyerDecisionRequired || Boolean(order.buyerDecision);
  const goodsPaid = payments.marketplace.paid;
  const transportExists = Boolean(job);
  const transportAccepted = transportExists && !['REQUESTED', 'QUOTED', 'CANCELLED'].includes(job.status);
  const transportPaid = payments.transport ? payments.transport.paid : true;
  const pickupStarted = transportExists && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status);
  const inTransit = transportExists && ['IN_TRANSIT', 'DELIVERED'].includes(job.status);
  const delivered = transportExists && job.status === 'DELIVERED';
  const completed = order.status === 'COMPLETED';

  const state = (done, current = false) =>
    done ? 'COMPLETED' : current ? 'CURRENT' : 'PENDING';

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
  }

  if (buyerDecisionRequired && job) {
    const sellerPrepared = Boolean(job.sellerPickupConfirmedAt);
    steps.push({
      code: 'TRANSPORT_PREPARATION_CONFIRMATION',
      label: 'Seller confirms transporter preparation',
      completed: sellerPrepared,
      state: state(sellerPrepared, transportAccepted && !sellerPrepared),
      at: job.sellerPickupConfirmedAt || null,
      detail: sellerPrepared ? 'The seller confirmed that the selected transporter is prepared.' : 'Waiting for the seller to confirm transporter preparation.',
    });
    steps.push({
      code: 'BUYER_DECISION',
      label: 'Final BUY / Cancel decision',
      completed: buyerDecisionMade,
      state: state(buyerDecisionMade, sellerPrepared && !buyerDecisionMade),
      at: order.buyerDecisionAt || null,
      detail: order.buyerDecision === 'BUY'
        ? 'Final BUY recorded; seller payment is unlocked.'
        : order.buyerDecision === 'CANCEL'
          ? 'Buyer cancelled the transaction.'
          : sellerPrepared ? 'Review the agreed transporter preparation, then choose BUY or Cancel.' : 'Seller confirmation is required before the final BUY decision.',
    });
  }

  steps.push({
    code: 'GOODS_PAYMENT',
    label: 'Goods payment',
    completed: goodsPaid,
    state: state(goodsPaid, order.buyerDecision === 'BUY' && !goodsPaid),
    at: null,
    detail: goodsPaid ? 'Commercial payment for the negotiated goods is recorded.' : 'Goods payment is the commercial commitment that unlocks fulfillment.',
  });

  steps.push({
    code: 'TRANSPORT_ARRANGEMENT',
    label: 'Transport arranged',
    completed: transportExists,
    state: state(transportExists, reportCompleted && !transportExists),
    at: job?.createdAt || null,
    detail: transportExists ? 'A transport job has been created.' : 'Transport can be arranged after the inspection report and inspection payment are complete.',
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
  if (order.listing?.category === 'PRODUCT' && !order.agreedOfferId) {
    return 'NEGOTIATION_REQUIRED';
  }
  if (order.status === 'CANCELLED') return 'CANCELLED';
  if (order.status === 'DISPUTED') return 'DISPUTED';
  if (order.status === 'COMPLETED') return 'COMPLETED';

  const job = order.transportJob || null;
  const agricultural = order.listing?.category === 'AGRICULTURAL';
  const inspectionRequired = agricultural || Boolean(order.listing?.inspectionRequired || payments.inspectionRequestsExist);

  if (inspectionRequired) {
    if (!payments.inspectionRequestsExist) return 'INSPECTION_REQUEST';

    if (!payments.allInspectionsCompleted) {
      const current = (payments.inspectionRequests || [])[0];

      if (current?.status === 'ACCEPTED' && !current.sellerConfirmedAt) {
        return 'INSPECTION_SELLER_CONFIRMATION';
      }
      if (current?.status === 'ACCEPTED' && current.sellerConfirmedAt && !current.inspectorOnSiteConfirmedAt) {
        return 'INSPECTOR_ARRIVAL_CONFIRMATION';
      }
      if (current?.status === 'ACCEPTED' && current.sellerConfirmedAt && current.inspectorOnSiteConfirmedAt && payments.inspections.some((i) => !i.paid)) {
        return 'INSPECTION_PAYMENT';
      }
      return 'INSPECTION';
    }

    if (!job) return 'ARRANGING_TRANSPORT';
    if (job.status === 'REQUESTED' || job.status === 'QUOTED') return 'ARRANGING_TRANSPORT';
    if (!job.sellerPickupConfirmedAt) return 'TRANSPORT_PREPARATION_CONFIRMATION';
    if (!order.buyerDecision) return 'BUYER_DECISION';
    if (!payments.marketplace.paid) return 'GOODS_PAYMENT';
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
  const reportCompleted = Boolean(payments.allInspectionsCompleted);
  const actions = [];

  const push = (action) => actions.push({ reason: null, ...action, enabled: action.ready && action.viewerCanPerform });

  // ---------------------------------------------------------------------------
  // 1. INSPECTION WORKFLOW
  // ---------------------------------------------------------------------------
  const inspectionRequests = (order.listing?.inspectionRequests || order.inspectionRequests || [])
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const currentInspectionRequest = inspectionRequests[0] || null;

  for (const request of currentInspectionRequest ? [currentInspectionRequest] : []) {
    const assignedToViewer = request.inspectorId === viewer.userId;
    const viewerIsRequester = request.requestedById === viewer.userId || isAdmin;
    const viewerIsAssignedInspector = request.inspectorId === viewer.userId;

    const leafList = leafQuotes(request.quotes);
    const pendingLeaves = leafList.filter((q) => q.status === 'PENDING');
    const liveLeaf = leafList.find((q) => ['SELECTED', 'COUNTERED'].includes(q.status));
    const acceptedLeaf = leafList.find((q) => q.status === 'ACCEPTED');

    // Selection: pending leaves exist, no live negotiation.
    if (request.status === 'REQUESTED' && !liveLeaf && pendingLeaves.length > 0) {
      push({
        code: 'SELECT_INSPECTION_QUOTE',
        label: `Select from ${pendingLeaves.length} inspector quote${pendingLeaves.length === 1 ? '' : 's'}`,
        actorRole: 'BUYER_OR_SELLER',
        inspectionRequestId: request.id,
        pendingQuoteCount: pendingLeaves.length,
        viewerCanPerform: viewerIsRequester,
        ready: viewerIsRequester,
        reason: viewerIsRequester ? null : 'Only the inspection requester can select a quote',
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    // Live negotiation: exactly one turn-aware action.
    if (liveLeaf) {
      const turn = quoteTurn(liveLeaf);
      const viewerMatchesTurn =
        (turn === 'REQUESTER' && viewerIsRequester) ||
        (turn === 'PROVIDER' && viewerIsAssignedInspector);
      const turnAmount = liveLeaf.counterAmount ?? liveLeaf.amount;
      push({
        code: 'RESPOND_INSPECTION_NEGOTIATION',
        label: turn === 'PROVIDER'
          ? 'Respond to requester counter'
          : 'Respond to inspector bid',
        actorRole: turn,
        inspectionRequestId: request.id,
        quoteId: liveLeaf.id,
        turn,
        amount: turnAmount,
        viewerCanPerform: viewerMatchesTurn,
        ready: viewerMatchesTurn,
        reason: viewerMatchesTurn
          ? null
          : `Waiting on ${turn === 'REQUESTER' ? 'the requester' : 'the inspector'} to respond`,
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    // Provisional agreement: release by requester (window-gated).
    if (acceptedLeaf && viewerIsRequester) {
      const releaseAt = acceptedReleaseAvailableAt(acceptedLeaf);
      const canRelease = isPast(releaseAt);
      push({
        code: 'RELEASE_INSPECTION_AGREEMENT',
        label: 'Release inspector agreement',
        actorRole: 'BUYER_OR_SELLER',
        inspectionRequestId: request.id,
        quoteId: acceptedLeaf.id,
        releaseAvailableAt: releaseAt ? releaseAt.toISOString() : null,
        viewerCanPerform: true,
        ready: canRelease,
        reason: canRelease
          ? null
          : `Available from ${releaseAt.toISOString()} (${RELEASE_AFTER_ACCEPT_HOURS}h after acceptance)`,
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    // Silent inspector release (waiting window).
    if (
      viewerIsRequester &&
      liveLeaf &&
      (liveLeaf.status === 'SELECTED' ||
        (liveLeaf.status === 'COUNTERED' && liveLeaf.counteredBy === 'REQUESTER'))
    ) {
      const releaseAt = silentReleaseAvailableAt(liveLeaf, SILENT_RELEASE_AFTER_HOURS.INSPECTION);
      const canRelease = isPast(releaseAt);
      push({
        code: 'RELEASE_SILENT_INSPECTOR',
        label: 'Release silent inspector',
        actorRole: 'BUYER_OR_SELLER',
        inspectionRequestId: request.id,
        quoteId: liveLeaf.id,
        releaseAvailableAt: releaseAt ? releaseAt.toISOString() : null,
        viewerCanPerform: true,
        ready: canRelease,
        reason: canRelease
          ? null
          : `Available from ${releaseAt.toISOString()} (${SILENT_RELEASE_AFTER_HOURS.INSPECTION}h of silence)`,
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    // Provider cancels own provisional agreement.
    if (acceptedLeaf && acceptedLeaf.inspectorId === viewer.userId) {
      push({
        code: 'PROVIDER_CANCEL_INSPECTION',
        label: 'Cancel provisional agreement',
        actorRole: 'INSPECTOR',
        inspectionRequestId: request.id,
        quoteId: acceptedLeaf.id,
        viewerCanPerform: true,
        ready: true,
        route: { method: 'GET', path: `/inspections/${request.id}/quotes` },
      });
    }

    // Seller confirmations
    if (request.status === 'ACCEPTED' && request.inspectorId && !request.sellerConfirmedAt) {
      push({
        code: 'CONFIRM_INSPECTION',
        label: 'Confirm inspector and fee',
        actorRole: 'SELLER',
        inspectionRequestId: request.id,
        viewerCanPerform: isSeller,
        ready: isSeller,
        reason: isSeller ? null : 'Waiting for the seller to confirm the selected inspector and agreed fee',
        route: { method: 'POST', path: `/inspections/${request.id}/seller-confirm` },
      });
      push({
        code: 'DECLINE_INSPECTION',
        label: 'Decline inspector and fee',
        actorRole: 'SELLER',
        inspectionRequestId: request.id,
        viewerCanPerform: isSeller,
        ready: isSeller,
        reason: isSeller ? null : 'Only the seller can decline the provisional inspection',
        route: { method: 'POST', path: `/inspections/${request.id}/seller-decline` },
      });
    }

    if (request.status === 'ACCEPTED' && request.sellerConfirmedAt && !request.inspectorOnSiteConfirmedAt) {
      push({
        code: 'CONFIRM_INSPECTOR_ARRIVAL',
        label: 'Confirm inspector on site',
        actorRole: 'SELLER',
        inspectionRequestId: request.id,
        viewerCanPerform: isSeller,
        ready: isSeller,
        reason: isSeller ? null : 'Waiting for the seller to confirm the inspector has arrived on site',
        route: { method: 'POST', path: `/inspections/${request.id}/inspector-arrived` },
      });
    }

    // Inspector work
    if (request.status === 'ACCEPTED' && assignedToViewer) {
      const canStart = Boolean(request.sellerConfirmedAt && request.inspectorOnSiteConfirmedAt);
      push({
        code: 'START_INSPECTION',
        label: 'Start inspection',
        actorRole: 'INSPECTOR',
        inspectionRequestId: request.id,
        viewerCanPerform: isInspector,
        ready: canStart,
        reason: !request.sellerConfirmedAt
          ? 'Seller must confirm the selected inspector and fee first'
          : !request.inspectorOnSiteConfirmedAt
            ? 'Seller must confirm inspector arrival on site first'
            : null,
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

// Request inspection if none exists yet AND the listing actually requires
// one. AGRICULTURAL always requires it; PRODUCT only if the seller set
// inspectionRequired on the listing.
const listingCategory = order.listing?.category;
const inspectionRequiredByPolicy =
  listingCategory === 'AGRICULTURAL' ||
  order.listing?.inspectionRequired === true;

if (inspectionRequiredByPolicy && !payments.inspectionRequestsExist && !terminal) {
  push({
    code: 'REQUEST_INSPECTION',
    label: 'Request inspection',
    actorRole: 'BUYER_OR_SELLER',
    viewerCanPerform: isBuyer || isSeller,
    ready: true,
    route: null,
  });
}

  // ---------------------------------------------------------------------------
  // 2. BUYER DECISION (BUY / CANCEL after inspection)
  // ---------------------------------------------------------------------------
  if ((order.listing?.category === 'AGRICULTURAL' || Boolean(order.listing?.inspectionRequired || payments.inspectionRequestsExist)) && !order.buyerDecision && !terminal) {
    const jobReady = Boolean(job && job.status === 'ACCEPTED' && job.sellerPickupConfirmedAt);
    const decisionDeadlineValid = !order.buyerDecisionDueAt || new Date(order.buyerDecisionDueAt) > new Date();
    const decisionReady = payments.inspectionRequestsExist && payments.allInspectionsCompleted && jobReady && decisionDeadlineValid;
    const decisionReason = !payments.inspectionRequestsExist
      ? 'Complete the inspection before proceeding'
      : !payments.allInspectionsCompleted
        ? 'Review the published inspection report before proceeding'
        : !job
          ? 'Select and agree a transporter first'
          : job.status !== 'ACCEPTED'
            ? 'Wait for the transporter quote to be agreed'
            : !job.sellerPickupConfirmedAt
              ? 'Wait for the seller to confirm transporter preparation'
              : null;

    push({
      code: 'BUYER_DECISION_BUY',
      label: 'BUY — final purchase commitment',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready: decisionReady,
      deadlineAt: order.buyerDecisionDueAt || null,
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
      ready: payments.inspectionRequestsExist && payments.allInspectionsCompleted && decisionDeadlineValid,
      deadlineAt: order.buyerDecisionDueAt || null,
      reason: !payments.inspectionRequestsExist ? 'Complete the inspection before cancelling' : !payments.allInspectionsCompleted ? 'Review the published inspection report first' : !decisionDeadlineValid ? 'The BUY/CANCEL decision deadline has expired' : null,
      route: {
        method: 'PATCH',
        path: `/orders/${order.id}/buyer-decision`,
        body: { decision: 'CANCEL' },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 3. PAY MARKETPLACE
  // ---------------------------------------------------------------------------
  if (!payments.marketplace.paid) {
    const decisionRequired = (order.listing?.category === 'AGRICULTURAL' || Boolean(order.listing?.inspectionRequired || payments.inspectionRequestsExist));
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

  // ---------------------------------------------------------------------------
  // 4. PAY INSPECTION
  // ---------------------------------------------------------------------------
  for (const inspection of payments.inspections) {
    const inspectionRequest = (order.inspectionRequests || []).find((r) => r.id === inspection.inspectionRequestId);
    const obligations = inspection.obligations || [];
    const arrivalConfirmed = Boolean(inspection.inspectorOnSiteConfirmedAt);

    if (!obligations.length) {
      push({
        code: 'PAY_INSPECTION',
        label: 'Pay inspection fee',
        actorRole: inspection.feePayer === 'SELLER' ? 'SELLER' : 'BUYER',
        inspectionRequestId: inspection.inspectionRequestId,
        viewerCanPerform: false,
        ready: false,
        reason: !inspection.sellerConfirmedAt
          ? 'Seller must confirm the selected inspector before inspection payment can begin'
          : !arrivalConfirmed
            ? 'Seller must confirm inspector arrival on site before inspection payment can begin'
            : 'Inspection payment obligation has not been created yet',
        route: null,
      });
      continue;
    }

    for (const obligation of obligations) {
      if (obligation.status === 'PAID' || (obligation.paymentId && inspection.paid)) continue;
      const inspectionPayerId = obligation.payerId;
      const viewerCanPay = viewer.userId === inspectionPayerId;
      push({
        code: 'PAY_INSPECTION',
        label: 'Pay inspection fee',
        actorRole: inspectionPayerId === order.sellerId ? 'SELLER' : 'BUYER',
        inspectionRequestId: inspection.inspectionRequestId,
        obligationId: obligation.id,
        viewerCanPerform: viewerCanPay,
        ready: !terminal && Boolean(inspection.sellerConfirmedAt) && arrivalConfirmed && viewerCanPay,
        reason: terminal
          ? 'Order is no longer active'
          : !inspection.sellerConfirmedAt
            ? 'Seller must confirm the selected inspector before inspection payment can begin'
            : !arrivalConfirmed
              ? 'Seller must confirm inspector arrival on site before inspection payment can begin'
              : !viewerCanPay
                ? 'Only the designated payer can pay this inspection obligation'
                : null,
        route: {
          method: 'POST',
          path: '/payments',
          body: { type: 'INSPECTOR', inspectionRequestId: inspection.inspectionRequestId, amount: Number(obligation.amount) },
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. ARRANGE TRANSPORT
  // ---------------------------------------------------------------------------
  if (!job) {
    const ready = !terminal && reportCompleted && ['CONFIRMED', 'PENDING_PAYMENT', 'TRANSPORT_ARRANGED'].includes(order.status);
    push({
      code: 'ARRANGE_TRANSPORT',
      label: 'Arrange transport',
      actorRole: 'BUYER_OR_SELLER',
      viewerCanPerform: isBuyer || isSeller,
      ready,
      reason: ready ? null : (!reportCompleted ? 'Complete the inspection report before arranging transport' : `Transport cannot be arranged while order is ${order.status}`),
      route: { method: 'POST', path: '/transport', body: { orderId: order.id } },
    });
  }

  // ---------------------------------------------------------------------------
  // 6. TRANSPORT NEGOTIATION
  // ---------------------------------------------------------------------------
  if (job && job.method === 'HIRE_TRANSPORTER') {
    const arrangerIsViewer =
      (job.arrangingParty === 'SELLER' && isSeller) ||
      (job.arrangingParty === 'BUYER' && isBuyer) ||
      (job.arrangingParty === 'JOINT' && (isBuyer || isSeller)) ||
      isAdmin;

    const jobLeafQuotes = leafQuotes(job.quotes);
    const jobPendingLeaves = jobLeafQuotes.filter((q) => q.status === 'PENDING');
    const jobLiveLeaf = jobLeafQuotes.find((q) => ['SELECTED', 'COUNTERED'].includes(q.status));
    const jobAcceptedLeaf = jobLeafQuotes.find((q) => q.status === 'ACCEPTED');

    const isJobOpen = ['REQUESTED', 'QUOTED'].includes(job.status);

    // Selection
    if (isJobOpen && !jobLiveLeaf && !jobAcceptedLeaf && jobPendingLeaves.length > 0) {
      push({
        code: 'SELECT_TRANSPORT_QUOTE',
        label: `Select from ${jobPendingLeaves.length} transport bid${jobPendingLeaves.length === 1 ? '' : 's'}`,
        actorRole: job.arrangingParty,
        transportJobId: job.id,
        pendingQuoteCount: jobPendingLeaves.length,
        viewerCanPerform: arrangerIsViewer,
        ready: arrangerIsViewer,
        reason: arrangerIsViewer ? null : 'Only the arranging party can select a transport bid',
        route: { method: 'GET', path: `/transport/${job.id}/quotes` },
      });
    }

    // Live negotiation
    if (jobLiveLeaf) {
      const turn = quoteTurn(jobLiveLeaf);
      const viewerMatchesTurn =
        (turn === 'REQUESTER' && arrangerIsViewer) ||
        (turn === 'PROVIDER' && jobLiveLeaf.truckOwnerId === viewer.userId);
      const turnAmount = jobLiveLeaf.counterAmount ?? jobLiveLeaf.amount;
      push({
        code: 'RESPOND_TRANSPORT_NEGOTIATION',
        label: turn === 'PROVIDER'
          ? 'Respond to arranger counter'
          : 'Respond to transporter bid',
        actorRole: turn,
        transportJobId: job.id,
        quoteId: jobLiveLeaf.id,
        turn,
        amount: turnAmount,
        viewerCanPerform: viewerMatchesTurn,
        ready: viewerMatchesTurn,
        reason: viewerMatchesTurn
          ? null
          : `Waiting on ${turn === 'REQUESTER' ? 'the arranging party' : 'the transporter'} to respond`,
        route: { method: 'GET', path: `/transport/${job.id}/quotes` },
      });
    }

    // Provisional release by arranger
    if (jobAcceptedLeaf && arrangerIsViewer) {
      const releaseAt = acceptedReleaseAvailableAt(jobAcceptedLeaf);
      const canRelease = isPast(releaseAt);
      push({
        code: 'RELEASE_TRANSPORT_AGREEMENT',
        label: 'Release transporter agreement',
        actorRole: job.arrangingParty,
        transportJobId: job.id,
        quoteId: jobAcceptedLeaf.id,
        releaseAvailableAt: releaseAt ? releaseAt.toISOString() : null,
        viewerCanPerform: true,
        ready: canRelease,
        reason: canRelease
          ? null
          : `Available from ${releaseAt.toISOString()} (${RELEASE_AFTER_ACCEPT_HOURS}h after acceptance)`,
        route: { method: 'GET', path: `/transport/${job.id}/quotes` },
      });
    }

    // Silent truck owner release
    if (
      arrangerIsViewer &&
      jobLiveLeaf &&
      (jobLiveLeaf.status === 'SELECTED' ||
        (jobLiveLeaf.status === 'COUNTERED' && jobLiveLeaf.counteredBy === 'REQUESTER'))
    ) {
      const releaseAt = silentReleaseAvailableAt(jobLiveLeaf, SILENT_RELEASE_AFTER_HOURS.TRANSPORT);
      const canRelease = isPast(releaseAt);
      push({
        code: 'RELEASE_SILENT_TRUCK_OWNER',
        label: 'Release silent truck owner',
        actorRole: job.arrangingParty,
        transportJobId: job.id,
        quoteId: jobLiveLeaf.id,
        releaseAvailableAt: releaseAt ? releaseAt.toISOString() : null,
        viewerCanPerform: true,
        ready: canRelease,
        reason: canRelease
          ? null
          : `Available from ${releaseAt.toISOString()} (${SILENT_RELEASE_AFTER_HOURS.TRANSPORT}h of silence)`,
        route: { method: 'GET', path: `/transport/${job.id}/quotes` },
      });
    }

    // Provider cancels own provisional agreement
    if (jobAcceptedLeaf && jobAcceptedLeaf.truckOwnerId === viewer.userId) {
      push({
        code: 'PROVIDER_CANCEL_TRANSPORT',
        label: 'Cancel provisional agreement',
        actorRole: 'TRUCK_OWNER',
        transportJobId: job.id,
        quoteId: jobAcceptedLeaf.id,
        viewerCanPerform: true,
        ready: true,
        route: { method: 'GET', path: `/transport/${job.id}/quotes` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 7. TRANSPORT PREPARATION + ARRIVAL
  // ---------------------------------------------------------------------------
  if (job && job.status === 'ACCEPTED' && !job.sellerPickupConfirmedAt && isSeller) {
    push({
      code: 'CONFIRM_TRANSPORT_PREPARATION',
      label: 'Confirm transporter preparation',
      actorRole: 'SELLER',
      viewerCanPerform: true,
      ready: !job.sellerPreparationDueAt || new Date(job.sellerPreparationDueAt) > new Date(),
      deadlineAt: job.sellerPreparationDueAt || job.workflowDueAt || null,
      reason: job.sellerPreparationDueAt && new Date(job.sellerPreparationDueAt) <= new Date() ? 'The seller preparation deadline has expired' : null,
      route: { method: 'POST', path: `/transport/${job.id}/seller-confirm-pickup` },
    });
  }

  if (job && job.status === 'ACCEPTED' && job.sellerPickupConfirmedAt && !job.truckArrivedAt) {
    push({
      code: 'CONFIRM_TRUCK_ARRIVAL',
      label: 'Confirm truck on site',
      actorRole: 'SELLER_OR_TRUCK_OWNER',
      viewerCanPerform: isSeller || isTruckOwner,
      ready: isSeller || isTruckOwner,
      reason: (isSeller || isTruckOwner) ? null : 'Waiting for the seller or transporter to confirm the truck has arrived',
      route: { method: 'POST', path: `/transport/${job.id}/truck-arrived` },
    });
  }

  // ---------------------------------------------------------------------------
  // 8. PAY TRANSPORT
  // ---------------------------------------------------------------------------
  if (job && payments.transport?.required && !payments.transport.paid) {
    const ready = job.status === 'ACCEPTED'
      && job.agreedAmount != null
      && payments.marketplace.paid
      && order.buyerDecision === 'BUY'
      && Boolean(job.sellerPickupConfirmedAt)
      && Boolean(job.truckArrivedAt);
    push({
      code: 'PAY_TRANSPORT',
      label: 'Pay transport',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready,
      reason: ready ? null
        : !payments.marketplace.paid ? 'Pay the seller before paying the transporter'
        : order.buyerDecision !== 'BUY' ? 'Final BUY decision is required before transport payment'
        : !job.sellerPickupConfirmedAt ? 'Seller must confirm loading preparation first'
        : !job.truckArrivedAt ? 'Truck must be on site before transport payment'
        : 'Transport must be agreed with an agreed amount before it can be paid',
      route: {
        method: 'POST',
        path: '/payments',
        body: { type: 'TRANSPORT', orderId: order.id, amount: payments.transport.amount },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 9. CONFIRM LOADING (buyer approves transporter's loading plan)
  // ---------------------------------------------------------------------------
  if (
    job &&
    job.status === 'ACCEPTED' &&
    payments.marketplace.paid &&
    order.buyerDecision === 'BUY' &&
    payments.transport?.paid
  ) {
    const reportExists = Boolean(job.loadingReport);
    const canConfirmLoading = reportExists && !job.buyerLoadingConfirmedAt;
    push({
      code: 'CONFIRM_LOADING',
      label: 'Approve loading report',
      actorRole: 'BUYER',
      viewerCanPerform: isBuyer,
      ready: isBuyer && canConfirmLoading,
      reason: !reportExists ? 'Waiting for the transporter to submit the loading report' : job.buyerLoadingConfirmedAt ? 'Loading report already approved' : null,
      route: { method: 'POST', path: `/transport/${job.id}/confirm-loading` },
    });
  }

  // ---------------------------------------------------------------------------
  // 10. MOVEMENT (transporter-owned)
  // ---------------------------------------------------------------------------
  if (job) {
    const movementReady = {
      START_PICKUP: job.status === 'ACCEPTED' && payments.allPaid && Boolean(job.buyerLoadingConfirmedAt) && Boolean(job.truckArrivedAt),
      MARK_IN_TRANSIT: job.status === 'PICKUP',
      MARK_DELIVERED: job.status === 'IN_TRANSIT',
    };

    if (job.status === 'ACCEPTED' || movementReady.START_PICKUP) {
      push({
        code: 'START_PICKUP',
        label: 'Start loading / pickup',
        actorRole: 'TRUCK_OWNER',
        viewerCanPerform: isTruckOwner,
        ready: movementReady.START_PICKUP,
        reason: movementReady.START_PICKUP ? null : 'All required payments and loading approval must be complete before pickup',
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

  // ---------------------------------------------------------------------------
  // 11. CONFIRM RECEIPT
  // ---------------------------------------------------------------------------
  if (!terminal) {
    const ready = Boolean(job && job.status === 'DELIVERED' && payments.allPaid);
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

  // ---------------------------------------------------------------------------
  // 12. RAISE DISPUTE
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 13. CANCEL ORDER
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 14. RECOVERY (only when a service competition is genuinely dead)
  // ---------------------------------------------------------------------------
  if (!terminal) {
    const pendingRecoveryTypes = new Set(
      (order.recoveryRequests || []).map((r) => r.type)
    );

    // Inspection recovery
    if (currentInspectionRequest && !pendingRecoveryTypes.has('INSPECTION')) {
      const recLeafQuotes = leafQuotes(currentInspectionRequest.quotes);
      const hasLiveBid = recLeafQuotes.some((q) =>
        ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
      );
      const requestDead =
        ['CANCELLED', 'STALLED'].includes(currentInspectionRequest.status) ||
        (!hasLiveBid && currentInspectionRequest.status === 'REQUESTED');
      const hasActiveInspectorPayment = (currentInspectionRequest.payments || []).some(
        (p) => p.type === 'INSPECTOR' && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
      );
      if (requestDead && !hasActiveInspectorPayment && (isBuyer || isSeller)) {
        push({
          code: 'REQUEST_INSPECTION_RECOVERY',
          label: 'Request fresh inspection form',
          actorRole: 'BUYER_OR_SELLER',
          inspectionRequestId: currentInspectionRequest.id,
          viewerCanPerform: isBuyer || isSeller,
          ready: true,
          route: {
            method: 'POST',
            path: '/recovery-requests',
            body: {
              orderId: order.id,
              type: 'INSPECTION',
              targetParties: isBuyer ? ['BUYER'] : ['SELLER'],
              reason: 'Inspection competition has no live bid',
            },
          },
        });
      }
    }

    // Transport recovery
    if (job && !pendingRecoveryTypes.has('TRANSPORT')) {
      const tLeafQuotes = leafQuotes(job.quotes);
      const tHasLiveBid = tLeafQuotes.some((q) =>
        ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
      );
      const jobDead =
        job.status === 'CANCELLED' ||
        (['REQUESTED', 'QUOTED'].includes(job.status) && !tHasLiveBid);
      const hasActiveTransportPayment = (order.payments || []).some(
        (p) => p.type === 'TRANSPORT' && p.transportJobId === job.id && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
      );
      if (jobDead && !hasActiveTransportPayment && (isBuyer || isSeller)) {
        push({
          code: 'REQUEST_TRANSPORT_RECOVERY',
          label: 'Request fresh transport form',
          actorRole: 'BUYER_OR_SELLER',
          transportJobId: job.id,
          viewerCanPerform: isBuyer || isSeller,
          ready: true,
          route: {
            method: 'POST',
            path: '/recovery-requests',
            body: {
              orderId: order.id,
              type: 'TRANSPORT',
              targetParties: isBuyer ? ['BUYER'] : ['SELLER'],
              reason: 'Transport competition has no live bid',
            },
          },
        });
      }
    }

    // Offer recovery — PRODUCT listings with no agreed offer yet.
    if (
      order.listing?.category === 'PRODUCT' &&
      !order.agreedOfferId &&
      !pendingRecoveryTypes.has('OFFER') &&
      (isBuyer || isSeller)
    ) {
      push({
        code: 'REQUEST_OFFER_RECOVERY',
        label: 'Request fresh offer competition',
        actorRole: 'BUYER_OR_SELLER',
        viewerCanPerform: isBuyer || isSeller,
        ready: true,
        reason: 'This product has no agreed offer. A fresh competition releases the seller to invite new bids.',
        route: {
          method: 'POST',
          path: '/recovery-requests',
          body: {
            orderId: order.id,
            type: 'OFFER',
            targetParties: isBuyer ? ['BUYER'] : ['SELLER'],
            reason: 'Offer competition has no live bid',
          },
        },
      });
    }
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
    order.listing?.inspectionRequests?.some((request) => request.inspectorId === viewerUserId) ||
    order.inspectionRequests?.some((request) => request.inspectorId === viewerUserId)
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
    buyerReviewedReportAt: order.buyerReviewedReportAt || null,
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
          sellerPickupConfirmedAt: order.transportJob.sellerPickupConfirmedAt || null,
          truckArrivedAt: order.transportJob.truckArrivedAt || null,
          acceptedReleaseCount: order.transportJob.acceptedReleaseCount || 0,
        }
      : null,
    timeline,
    actions,
  };
}

module.exports = { computeOrderWorkflow };
