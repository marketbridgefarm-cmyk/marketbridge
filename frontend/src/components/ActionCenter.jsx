import React, { useMemo, useState } from 'react';
import api from '../api/client';

// ============================================================================
// ACTION CENTER — the lead card ("what do I do now?")
// ============================================================================
// Used by every role. Server-driven: the backend's workflow.actions decides
// what is ready. Buyers additionally get `buyerGuide` (gate flags from
// OrderDetail) so they follow the guided steps and see an "All steps" list.
//
// Priority of what the card says:
//   1. CANCELLED / DISPUTED / COMPLETED  (terminal states always win)
//   2. buyer guide step                  (buyers only)
//   3. first ready workflow action       (everyone else)
//   4. fallback text
//
// Styles live in OrderDetail.css, section 18 (.od-next-*), on the same card
// shell as the order overview card.
// ============================================================================

const ACTION_LABELS = {
  BUYER_DECISION_BUY: 'BUY – continue purchase',
  BUYER_DECISION_CANCEL: 'Cancel after inspection',
  REQUEST_INSPECTION: 'Request inspection',
  PAY_MARKETPLACE: 'Pay for goods',
  PAY_INSPECTION: 'Pay inspection fee',
  ARRANGE_TRANSPORT: 'Arrange transport',
  REVIEW_INSPECTION_QUOTES: 'Review inspection quotes',
  REVIEW_TRANSPORT_QUOTES: 'Review transport quotes',
  PAY_TRANSPORT: 'Pay transport',
  CONFIRM_LOADING: 'Approve loading report',
  START_PICKUP: 'Start loading / pickup',
  MARK_IN_TRANSIT: 'Mark in transit',
  MARK_DELIVERED: 'Mark delivered',
  CONFIRM_RECEIPT: 'Confirm receipt',
  CANCEL_ORDER: 'Cancel after inspection',
  START_INSPECTION: 'Start inspection',
  SUBMIT_INSPECTION_REPORT: 'Complete inspection report',
  RAISE_DISPUTE: 'Raise a dispute',
};

const ACTION_HELP = {
  BUYER_DECISION_BUY: 'Review the completed inspection, then choose BUY to unlock the seller payment.',
  BUYER_DECISION_CANCEL: 'Cancel the purchase after reviewing the inspection report.',
  REQUEST_INSPECTION: 'An independent inspector checks the quality before you commit.',
  PAY_MARKETPLACE: 'BUY is recorded. Choose a payment method and start the seller payment checkout.',
  PAY_INSPECTION: 'Pay the inspector’s fee. It is separate from the goods payment.',
  ARRANGE_TRANSPORT: 'Set up how the goods will travel: your own truck or a hired transporter.',
  REVIEW_INSPECTION_QUOTES: 'Compare inspector bids and pick one to negotiate with.',
  REVIEW_TRANSPORT_QUOTES: 'Compare transport bids, select one and agree on the price.',
  PAY_TRANSPORT: 'The trip can only start once the transport fee is confirmed.',
  CONFIRM_LOADING: 'Review the transporter’s pre-loading report before the goods are physically loaded.',
  START_PICKUP: 'Begin loading and record pickup evidence.',
  MARK_IN_TRANSIT: 'Upload pickup evidence, then mark the trip as in transit.',
  MARK_DELIVERED: 'Upload delivery evidence, then mark the trip as delivered.',
  CONFIRM_RECEIPT: 'Confirm only after you have physically received the goods. This completes the order.',
  CANCEL_ORDER: 'Cancel this order. This cannot be undone.',
  START_INSPECTION: 'Start the accepted inspection.',
  SUBMIT_INSPECTION_REPORT: 'Complete the inspection and publish the evidence report.',
  RAISE_DISPUTE: 'Something went wrong? Open a dispute and an admin will review the order.',
};

const scrollTarget = (code) => {
  if (code === 'PAY_MARKETPLACE' || code === 'PAY_INSPECTION' || code === 'PAY_TRANSPORT') return 'payment-center';
  if (code === 'ARRANGE_TRANSPORT' || code === 'REVIEW_TRANSPORT_QUOTES' || code === 'CONFIRM_LOADING' || code === 'START_PICKUP' || code === 'MARK_IN_TRANSIT' || code === 'MARK_DELIVERED') return 'transport-section';
  if (code === 'REQUEST_INSPECTION' || code === 'REVIEW_INSPECTION_QUOTES' || code === 'START_INSPECTION' || code === 'SUBMIT_INSPECTION_REPORT') return 'inspection-section';
  if (code === 'CONFIRM_RECEIPT') return 'confirm-receipt';
  if (code === 'RAISE_DISPUTE') return 'raise-dispute';
  return 'next-action';
};

/* ── Buyer guide: ordered steps derived from OrderDetail's own gate flags ── */
function buildBuyerSteps({ order, flags: f }) {
  const steps = [];

  if (f.isProduct) {
    steps.push({
      key: 'offer', label: 'Win the deal', done: Boolean(order.agreedOfferId),
      target: 'make-offer', title: 'Make your offer',
      text: 'Send an offer to the seller. The seller picks the winning offer and opens negotiation.',
      cta: 'Make an offer',
    });
  }

  if (f.inspectionApplies) {
    steps.push({
      key: 'inspect', label: 'Inspection', done: f.inspectionGateMet,
      target: 'inspection-section', title: 'Get the goods inspected',
      text: 'An independent inspector checks the quality before you commit. Open a request or review the bids.',
      cta: 'Open inspection',
    });
    steps.push({
      key: 'decide', label: 'Decision', done: f.decisionGateMet,
      target: 'inspection-section', title: 'Review the report and arrange transport',
      text: 'Read the findings. You can cancel after inspection, or proceed to transport arrangement. Final BUY and seller payment happen after the seller confirms transporter preparation.',
      cta: 'Review report',
    });
  }

  const transportArranged =
    Boolean(f.transportJob) && (!f.hiredTransport || Boolean(f.acceptedQuote) || f.transportPaid);
  steps.push({
    key: 'transport', label: 'Transport', done: transportArranged,
    target: 'transport-section',
    title: f.transportJob ? 'Choose a transporter' : 'Arrange transport',
    text: f.transportJob
      ? 'Select a bid, agree on the price, and wait for the seller to confirm transporter preparation.'
      : 'Set up how the goods will travel: the transporter is arranged before the final BUY and seller payment.',
    cta: f.transportJob ? 'See transport bids' : 'Arrange transport',
  });

  steps.push({
    key: 'pay', label: 'Final BUY & pay seller', done: f.marketplacePaid,
    target: 'payment-center', title: 'Final BUY and pay the seller',
    text: 'After the seller confirms transporter preparation, make the final BUY decision and pay the seller.',
    cta: 'Go to seller payment',
  });

  if (f.hiredTransport) {
    steps.push({
      key: 'pay-transport', label: 'Pay transport', done: f.transportPaid,
      target: 'payment-center', title: 'Pay the transporter',
      text: 'Pay the transporter after the seller has been paid and before loading begins.',
      cta: 'Go to transport payment',
    });
  }

  const delivered = order.status === 'DELIVERED';
  steps.push({
    key: 'receive', label: 'Receive goods', done: order.status === 'COMPLETED',
    target: delivered ? 'confirm-receipt' : 'transport-section',
    title: delivered ? 'Confirm you received the goods' : 'Track your delivery',
    text: delivered
      ? 'Confirm only after you have physically received the goods. This completes the order.'
      : 'The transporter will pick up and deliver. You confirm receipt once the goods arrive.',
    cta: delivered ? 'Confirm receipt' : 'Track delivery',
  });

  return steps;
}

export default function ActionCenter({
  workflow,
  onScroll,
  onActionComplete,
  buyerGuide = null,
  orderStatus: orderStatusProp,
  marketplacePaid = false,
  transportDelivered = false,
}) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  const actions = Array.isArray(workflow?.actions) ? workflow.actions : [];
  const readyActions = useMemo(() => actions.filter((action) => action?.ready), [actions]);
  const next = readyActions[0] || null;

  const steps = useMemo(() => (buyerGuide ? buildBuyerSteps(buyerGuide) : []), [buyerGuide]);
  const currentIndex = steps.findIndex((s) => !s.done);
  const guideCurrent = currentIndex >= 0 ? steps[currentIndex] : null;

  if (!workflow && !buyerGuide) return null;

  /* Real order status first; workflow stage can lag behind it. */
  const status = String(orderStatusProp || buyerGuide?.order?.status || workflow?.currentStage || '').toUpperCase();
  const terminal = ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(status);

  /* Order progress shown to every role: Ordered → Paid → Delivered → Completed */
  const delivered = ['DELIVERED', 'COMPLETED'].includes(status) || Boolean(transportDelivered);
  const stages = [
    { label: 'Ordered', done: true },
    { label: 'Paid', done: Boolean(marketplacePaid) },
    { label: 'Delivered', done: delivered },
    { label: 'Completed', done: status === 'COMPLETED' },
  ];
  const stageCurrent = stages.findIndex((s) => !s.done);

  const doScroll = (target) => {
    if (onScroll) onScroll(target);
    else document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const run = async (action) => {
    if (!action || working) return;
    setError('');

    // Payment controls have their own provider/session handling in OrderDetail.
    if (['PAY_INSPECTION', 'PAY_TRANSPORT'].includes(action.code)) {
      doScroll(scrollTarget(action.code));
      return;
    }

    // Review/operational actions are routed to the relevant section. The
    // dedicated section owns the detailed controls and evidence.
    if (
      !action.route ||
      action.code === 'REQUEST_INSPECTION' ||
      action.code === 'ARRANGE_TRANSPORT' ||
      action.code === 'REVIEW_INSPECTION_QUOTES' ||
      action.code === 'REVIEW_TRANSPORT_QUOTES' ||
      action.code === 'RAISE_DISPUTE'
    ) {
      doScroll(scrollTarget(action.code));
      return;
    }

    if (action.code === 'CANCEL_ORDER') {
      const confirmed = window.confirm('Cancel this order? This cannot be undone.');
      if (!confirmed) return;
      setWorking(action.code);
      try {
        await api.patch(action.route.path, {});
        await onActionComplete?.();
      } catch (err) {
        setError(err?.response?.data?.error || err?.message || 'Could not cancel the order');
      } finally {
        setWorking('');
      }
      return;
    }

    // Movement/inspection state transitions can be executed from the workflow
    // when the backend exposes a concrete route and body.
    setWorking(action.code);
    try {
      const method = String(action.route.method || 'GET').toUpperCase();
      const path = action.route.path;
      const body = action.route.body;
      if (method === 'POST') await api.post(path, body);
      else if (method === 'PATCH') await api.patch(path, body);
      else if (method === 'PUT') await api.put(path, body);
      else await api.get(path);
      await onActionComplete?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || `Could not complete ${action.label || 'action'}`);
    } finally {
      setWorking('');
    }
  };

  /* ---- What does the card say? ----------------------------------------- */
  const stageLabel = workflow?.currentStage ? String(workflow.currentStage).replaceAll('_', ' ') : null;

  let mode = 'active';
  let title;
  let text;
  let primary = null;

  if (status === 'CANCELLED') {
    mode = 'closed';
    title = 'This order was cancelled';
    text = 'Nothing more to do here. Any payment already made is refunded. Check the payment status below.';
    primary = { label: 'View payments', onClick: () => doScroll('payment-center') };
  } else if (status === 'DISPUTED') {
    mode = 'paused';
    title = 'Dispute under review';
    text = 'An admin is reviewing this order. Payments, transport and payouts are paused until it is resolved.';
    primary = { label: 'View dispute', onClick: () => doScroll('raise-dispute') };
  } else if (status === 'COMPLETED' || (buyerGuide && !guideCurrent)) {
    mode = 'done';
    title = 'Order complete';
    text = buyerGuide
      ? 'You confirmed receipt. Thank you. You can rate the seller below.'
      : 'This order is complete. No further action is needed.';
  } else if (buyerGuide && guideCurrent) {
    title = guideCurrent.title;
    text = guideCurrent.text;
    primary = { label: guideCurrent.cta, onClick: () => doScroll(guideCurrent.target) };
  } else if (next) {
    title = ACTION_LABELS[next.code] || next.label || 'Continue';
    text = ACTION_HELP[next.code] || '';
    primary = {
      label: working === next.code ? 'Working…' : title,
      onClick: () => run(next),
    };
  } else {
    title = 'Nothing to do right now';
    text = 'The next step will appear here as soon as something needs you.';
  }

  const stepNumber = guideCurrent ? currentIndex + 1 : steps.length;
  const showCount = buyerGuide && mode === 'active';
  const others = terminal || buyerGuide ? [] : readyActions.slice(1);

  const sideLabel = showCount ? 'Progress' : 'Stage';
  const sideValue = showCount ? `Step ${stepNumber} of ${steps.length}` : stageLabel;

  /* Latest order status, shown at the right of the "Order status" header */
  const stageNow = stages[stageCurrent];
  let statusText = stageNow ? stageNow.label : 'Completed';
  let statusToneName = stageNow ? 'wait' : 'good';
  if (status === 'CANCELLED') { statusText = 'Cancelled'; statusToneName = 'bad'; }
  else if (status === 'DISPUTED') { statusText = 'Disputed'; statusToneName = 'bad'; }

  const doneSteps = steps.filter((s) => s.done).length;
  const hasBody = Boolean(text || next?.deadlineAt || error || primary);

  return (
    <section className={`card od-next od-next--${mode} next-action-card`} id="next-action" aria-labelledby="od-next-title">
      <header className="od-card-head">
        <div className="od-card-head-main">
          <span className="od-eyebrow">{buyerGuide ? 'Your next step' : 'Next step'}</span>
          <h2 className="od-card-title" id="od-next-title">{title}</h2>
        </div>
        {sideValue && (
          <div className="od-card-head-side">
            <span className="od-card-side-label">{sideLabel}</span>
            <span className="od-card-side-value">{sideValue}</span>
          </div>
        )}
      </header>

      {hasBody && (
        <div className="od-card-section">
          <div className="od-card-section-head">
            <h3 className="od-card-section-title">{mode === 'active' ? 'What to do' : 'Summary'}</h3>
          </div>
          {text && <p className="od-next-text">{text}</p>}
          {next?.deadlineAt && (
            <p className="od-next-text" role="status">Deadline: {new Date(next.deadlineAt).toLocaleString()}</p>
          )}
          {error && <div className="od-next-error" role="alert">{error}</div>}
          {primary && (
            <button type="button" className="od-next-cta" disabled={Boolean(working)} onClick={primary.onClick}>
              {primary.label}
              <span aria-hidden="true" className="od-next-cta-arrow">↓</span>
            </button>
          )}
        </div>
      )}

      {/* Order progress (all roles) */}
      <div className="od-card-section">
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">Order status</h3>
          <div className="od-card-section-meta is-bare">
            <span className={`od-section-status od-text-${statusToneName}`}>{statusText}</span>
          </div>
        </div>
        <ol className="order-progress" aria-label="Order progress">
          {stages.map((s, i) => {
            const state = s.done ? 'done' : i === stageCurrent ? 'current' : 'todo';
            return (
              <li key={s.label} className={`order-progress-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="order-progress-dot" aria-hidden="true" />
                <span className="order-progress-label">{s.label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Detailed purchase steps (buyers) */}
      {steps.length > 0 && (
        <details className="od-card-section od-next-all">
          <summary className="od-card-section-head">
            <span className="od-card-section-title">All steps</span>
            <span className="od-card-section-meta is-bare">{doneSteps} of {steps.length} done</span>
          </summary>
          <ol className="od-next-list">
            {steps.map((step, i) => {
              const state = step.done ? 'done' : i === currentIndex ? 'current' : 'todo';
              return (
                <li key={step.key} className={`od-next-item is-${state}`}>
                  <span className="od-next-item-icon" aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
                  <span className="od-next-item-body">
                    <strong>{step.label}</strong>
                    <span>{state === 'done' ? 'Done' : state === 'current' ? 'Do this now' : 'Coming up'}</span>
                  </span>
                  {state !== 'done' && (
                    <button type="button" className="od-next-item-go" onClick={() => doScroll(step.target)}>
                      Go
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}

      {/* Other ready actions from the workflow (not for buyers / closed orders) */}
      {others.length > 0 && (
        <details className="od-card-section od-next-all">
          <summary className="od-card-section-head">
            <span className="od-card-section-title">Other available actions</span>
            <span className="od-card-section-meta is-bare">{others.length}</span>
          </summary>
          <div className="od-next-others">
            {others.map((action) => (
              <button
                key={`${action.code}-${action.inspectionRequestId || ''}`}
                type="button"
                className="od-next-item-go od-next-other"
                disabled={Boolean(working)}
                onClick={() => run(action)}
              >
                {ACTION_LABELS[action.code] || action.label || action.code}
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
