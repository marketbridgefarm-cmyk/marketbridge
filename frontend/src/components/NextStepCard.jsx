import React from 'react';

// ============================================================================
// NEXT STEP CARD  — the standard "lead the buyer" place
// ============================================================================
// Always the first card under the order summary for the buyer. It answers
// three questions at a glance:
//   1. Where am I?        → progress dots + "Step 3 of 7"
//   2. What do I do now?  → one title, one sentence, one big button
//   3. What's left?       → "All steps" list (collapsible)
//
// Presentational only. Every flag comes from OrderDetail.jsx (the same
// values that already gate payments / transport / receipt), and the button
// just scrolls to the card where the real action lives (onGo(id)).
// ============================================================================

function buildSteps({ order, f }) {
  const steps = [];

  if (f.isProduct) {
    steps.push({
      key: 'offer',
      label: 'Win the deal',
      done: Boolean(order.agreedOfferId),
      target: 'make-offer',
      title: 'Make your offer',
      text: 'Send an offer to the seller. The seller picks the winning offer and opens negotiation.',
      cta: 'Make an offer',
    });
  }

  if (f.inspectionApplies) {
    steps.push({
      key: 'inspect',
      label: 'Inspection',
      done: f.inspectionGateMet,
      target: 'inspection-section',
      title: 'Get the goods inspected',
      text: 'An independent inspector checks the quality before you commit. Open a request or review the bids.',
      cta: 'Open inspection',
    });
    steps.push({
      key: 'decide',
      label: 'Decision',
      done: f.decisionGateMet,
      target: 'inspection-section',
      title: 'Review the report and choose Buy',
      text: 'Read the findings. Choosing Buy unlocks payment; you can also cancel the purchase here.',
      cta: 'Review report',
    });
  }

  steps.push({
    key: 'pay',
    label: 'Pay seller',
    done: f.marketplacePaid,
    target: 'payment-center',
    title: 'Pay the seller',
    text: 'Pay the order amount. The seller, any inspector and a hired transporter are each paid separately.',
    cta: 'Go to seller payment',
  });

  const transportArranged =
    Boolean(f.transportJob) && (!f.hiredTransport || Boolean(f.acceptedQuote) || f.transportPaid);
  steps.push({
    key: 'transport',
    label: 'Transport',
    done: transportArranged,
    target: 'transport-section',
    title: f.transportJob ? 'Choose a transporter' : 'Arrange transport',
    text: f.transportJob
      ? 'Select a bid, agree on the price and accept the quote.'
      : 'Set up how the goods will travel: your own truck or a hired transporter.',
    cta: f.transportJob ? 'See transport bids' : 'Arrange transport',
  });

  if (f.hiredTransport) {
    steps.push({
      key: 'pay-transport',
      label: 'Pay transport',
      done: f.transportPaid,
      target: 'payment-center',
      title: 'Pay the transporter',
      text: 'The trip can only start once the transport fee is confirmed.',
      cta: 'Go to transport payment',
    });
  }

  const delivered = order.status === 'DELIVERED';
  steps.push({
    key: 'receive',
    label: 'Receive goods',
    done: order.status === 'COMPLETED',
    target: delivered ? 'confirm-receipt' : 'transport-section',
    title: delivered ? 'Confirm you received the goods' : 'Track your delivery',
    text: delivered
      ? 'Confirm only after you have physically received the goods. This completes the order.'
      : 'The transporter will pick up and deliver. You confirm receipt once the goods arrive.',
    cta: delivered ? 'Confirm receipt' : 'Track delivery',
  });

  return steps;
}

export default function NextStepCard({ order, flags, onGo }) {
  const steps = buildSteps({ order, f: flags });
  const currentIndex = steps.findIndex((s) => !s.done);
  const allDone = currentIndex === -1;
  const current = allDone ? null : steps[currentIndex];

  let mode = 'active';
  let title = current?.title;
  let text = current?.text;
  let cta = current ? { label: current.cta, target: current.target } : null;

  if (order.status === 'CANCELLED') {
    mode = 'closed';
    title = 'This order was cancelled';
    text = 'Nothing more to do here. Any payment you already made is refunded — check the payment status below.';
    cta = { label: 'View payments', target: 'payment-center' };
  } else if (order.status === 'DISPUTED') {
    mode = 'paused';
    title = 'Dispute under review';
    text = 'An admin is reviewing this order. Payments, transport and payouts are paused until it is resolved.';
    cta = { label: 'View dispute', target: 'raise-dispute' };
  } else if (allDone || order.status === 'COMPLETED') {
    mode = 'done';
    title = 'Order complete';
    text = 'You confirmed receipt. Thank you — you can rate the seller below.';
    cta = null;
  }

  const stepNumber = allDone ? steps.length : currentIndex + 1;

  return (
    <section className={`card od-next od-next--${mode}`} id="next-action" aria-labelledby="od-next-title">
      <div className="od-next-top">
        <span className="od-eyebrow">Your next step</span>
        {mode === 'active' && (
          <span className="od-next-count">
            Step {stepNumber} of {steps.length}
          </span>
        )}
      </div>

      <h2 className="od-next-title" id="od-next-title">{title}</h2>
      <p className="od-next-text">{text}</p>

      {cta && (
        <button type="button" className="od-next-cta" onClick={() => onGo(cta.target)}>
          {cta.label}
          <span aria-hidden="true" className="od-next-cta-arrow">↓</span>
        </button>
      )}

      {/* Progress */}
      <ol className="od-next-track" aria-label="Purchase progress">
        {steps.map((step, i) => {
          const state = step.done ? 'done' : i === currentIndex ? 'current' : 'todo';
          return (
            <li key={step.key} className={`od-next-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="od-next-dot" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
              <span className="od-next-step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>

      {/* Full list */}
      <details className="od-next-all">
        <summary>All steps</summary>
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
                  <button type="button" className="od-next-item-go" onClick={() => onGo(step.target)}>
                    Go
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
