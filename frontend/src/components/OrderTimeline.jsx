import React from 'react';
import './OrderTimeline.css';

// ============================================================================
// ORDER TIMELINE — centered rail, stages alternate left / right
// ============================================================================
// Data comes from the `timeline` array returned by GET /orders/:id/workflow.
// Steps that don't apply to an order are absent from the array.
// Dots are inline SVG (checkmark / pulsing circle / empty ring) so state is
// not conveyed by color alone (WCAG 1.4.1). SVGs use currentColor.
//
// The extended milestone flow now includes:
//   ORDERED → INSPECTED → DECIDED → TRANSPORT → LOADED → PAID → DELIVERED
//   → COMPLETED
// The backend sends both `code` and `label`, but friendly fallbacks are
// provided here so a bare code still renders a human label.
// ============================================================================

const formatDate = (value) => {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

// FIXED: Friendly fallback labels for known milestone codes. Used only when
// the backend does not supply a label. Keeps new milestones readable even
// if the workflow service ships codes before labels.
const FRIENDLY_STEP_LABELS = {
  ORDERED: 'Order placed',
  PLACED: 'Order placed',
  INSPECTED: 'Inspected',
  INSPECTION_COMPLETED: 'Inspected',
  DECIDED: 'Purchase decided',
  BUYER_DECIDED: 'Purchase decided',
  TRANSPORT: 'Transport arranged',
  TRANSPORT_ARRANGED: 'Transport arranged',
  LOADED: 'Goods loaded',
  LOADING_CONFIRMED: 'Goods loaded',
  PAID: 'Paid',
  MARKETPLACE_PAID: 'Paid',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
};

const friendlyLabel = (step) => {
  if (step.label) return step.label;
  const code = String(step.code || '').toUpperCase();
  return FRIENDLY_STEP_LABELS[code] || code.replace(/_/g, ' ').toLowerCase();
};

function DotComplete() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="13" fill="currentColor" />
      <path
        d="M7.5 13.5l4 4 7-8"
        stroke="var(--ot-dot-mark, #fff)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotCurrent() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="currentColor" strokeWidth="2" fill="var(--ot-dot-bg, #fff)" />
      <circle cx="13" cy="13" r="5" fill="currentColor" />
    </svg>
  );
}

function DotPending() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="currentColor" strokeWidth="2" fill="var(--ot-dot-bg, #fff)" />
    </svg>
  );
}

function DotRecorded() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="currentColor" strokeWidth="2" fill="var(--ot-dot-bg, #fff)" />
      <circle cx="13" cy="13" r="4" fill="currentColor" />
    </svg>
  );
}

// Even index → left of the line, odd → right.
const sideClass = (index) => (index % 2 === 0 ? 'is-left' : 'is-right');

// FIXED: Accept both `completed` and `done` on a milestone step. Different
// parts of the codebase use one or the other; treating them as synonyms
// prevents a milestone from appearing "pending" simply because the workflow
// service used the other key name.
const isStepDone = (step) =>
  Boolean(step.completed) || Boolean(step.done);

export default function OrderTimeline({ steps, events = [] }) {
  const milestoneSteps = Array.isArray(steps)
    ? steps.filter((step) => step && typeof step === 'object')
    : [];
  const durableEvents = Array.isArray(events)
    ? events.filter((event) => event && typeof event === 'object')
    : [];

  if (milestoneSteps.length === 0 && durableEvents.length === 0) return null;

  const lastCompletedIndex = milestoneSteps.reduce(
    (acc, step, index) => (isStepDone(step) ? index : acc),
    -1
  );

  // FIXED: If the backend explicitly marks a step as CURRENT, honor it.
  // Otherwise, the first not-done step after the last completed one is the
  // current step. This preserves the existing behavior while supporting
  // the extended milestone set.
  const explicitCurrentIndex = milestoneSteps.findIndex(
    (step) => String(step.state || '').toUpperCase() === 'CURRENT'
  );
  const currentIndex =
    explicitCurrentIndex >= 0 ? explicitCurrentIndex : lastCompletedIndex + 1;

  return (
    <ol className="order-timeline" aria-label="Order milestone progress">
      {milestoneSteps.map((step, index) => {
        const explicitState = String(step.state || '').toUpperCase();
        const isComplete = explicitState === 'COMPLETED' || isStepDone(step);
        const isCurrent = !isComplete && index === currentIndex;
        const stateClass = isComplete
          ? 'is-complete'
          : isCurrent
            ? 'is-current'
            : 'is-pending';

        const at = formatDate(step.at || step.at_time || step.occurredAt);
        const label = isComplete
          ? 'Completed milestone'
          : isCurrent
            ? 'Current milestone'
            : 'Upcoming milestone';

        return (
          <li
            key={step.code || `milestone-${index}`}
            className={`order-timeline-step ${stateClass} ${sideClass(index)}`}
          >
            <span className="order-timeline-dot" role="img" aria-label={label}>
              {isComplete ? <DotComplete /> : isCurrent ? <DotCurrent /> : <DotPending />}
            </span>

            <div className="order-timeline-content">
              <div className="order-timeline-label">{friendlyLabel(step)}</div>
              {at && <div className="order-timeline-date">{at}</div>}
              {step.detail && (
                <div className="order-timeline-detail">{step.detail}</div>
              )}
            </div>
          </li>
        );
      })}

      {durableEvents.length > 0 && (
        <li
          className={`order-timeline-step is-recorded ${sideClass(milestoneSteps.length)}`}
        >
          <span className="order-timeline-dot" aria-hidden="true">
            <DotRecorded />
          </span>

          <div className="order-timeline-content">
            <details className="order-timeline-events">
              <summary className="order-timeline-events-summary">
                <span className="order-timeline-events-label">Activity history</span>
                <span className="order-timeline-events-count">{durableEvents.length}</span>
                <span className="order-timeline-events-chevron" aria-hidden="true">▾</span>
              </summary>

              <ul className="order-timeline-events-list">
                {durableEvents.map((event) => (
                  <li
                    key={event.id || `${event.type || 'event'}-${event.at || ''}`}
                    className="order-timeline-event"
                  >
                    <span className="order-timeline-event-type">
                      {String(event.type || '').replace(/_/g, ' ').toLowerCase()}
                    </span>
                    {event.actor?.name && (
                      <span className="order-timeline-event-actor">
                        {event.actor.name}
                      </span>
                    )}
                    {formatDate(event.at) && (
                      <span className="order-timeline-event-time">
                        {formatDate(event.at)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </li>
      )}
    </ol>
  );
}
