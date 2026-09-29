import React from 'react';
import './OrderTimeline.css';

// ============================================================================
// ORDER TIMELINE
// ============================================================================
// Shows chronological transaction progress from the `timeline` array
// returned by GET /orders/:id/workflow. Steps that don't apply to this
// order (e.g. no inspection was requested) are simply absent from the
// array rather than shown as permanently pending.
//
// Phase 3 visual: each dot is an inline SVG — checkmark for completed,
// pulsing circle for current, empty ring for pending — so the state is
// communicated without color alone (WCAG 1.4.1). SVGs use currentColor
// so the stylesheet owns every color decision.
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

// Inline SVG indicators — no external icon font needed (CSP-safe).
// All strokes/fills use currentColor so `.order-timeline-step.is-*`
// can drive the color from CSS.
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
      <circle
        cx="13"
        cy="13"
        r="12"
        stroke="currentColor"
        strokeWidth="2"
        fill="var(--ot-dot-bg, #fff)"
      />
      <circle cx="13" cy="13" r="5" fill="currentColor" />
    </svg>
  );
}

function DotPending() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle
        cx="13"
        cy="13"
        r="12"
        stroke="currentColor"
        strokeWidth="2"
        fill="var(--ot-dot-bg, #fff)"
      />
    </svg>
  );
}

function DotRecorded() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle
        cx="13"
        cy="13"
        r="12"
        stroke="currentColor"
        strokeWidth="2"
        fill="var(--ot-dot-bg, #fff)"
      />
      <circle cx="13" cy="13" r="4" fill="currentColor" />
    </svg>
  );
}

export default function OrderTimeline({ steps, events = [] }) {
  const milestoneSteps = Array.isArray(steps) ? steps : [];
  const durableEvents = Array.isArray(events) ? events : [];

  if (milestoneSteps.length === 0 && durableEvents.length === 0) return null;

  const lastCompletedIndex = milestoneSteps.reduce(
    (acc, step, index) => (step.completed ? index : acc),
    -1
  );

  return (
    <ol className="order-timeline" aria-label="Order milestone progress">
      {milestoneSteps.map((step, index) => {
        const explicitState = String(step.state || '').toUpperCase();
        const isComplete =
          explicitState === 'COMPLETED' || Boolean(step.completed);
        const isCurrent =
          explicitState === 'CURRENT' ||
          (!step.completed && index === lastCompletedIndex + 1);
        const stateClass = isComplete
          ? 'is-complete'
          : isCurrent
            ? 'is-current'
            : 'is-pending';

        const at = formatDate(step.at);
        const label = isComplete
          ? 'Completed milestone'
          : isCurrent
            ? 'Current milestone'
            : 'Upcoming milestone';

        return (
          <li key={step.code} className={`order-timeline-step ${stateClass}`}>
            <span className="order-timeline-dot" role="img" aria-label={label}>
              {step.completed ? (
                <DotComplete />
              ) : isCurrent ? (
                <DotCurrent />
              ) : (
                <DotPending />
              )}
            </span>

            <div className="order-timeline-content">
              <div className="order-timeline-label">{step.label}</div>
              {at && <div className="order-timeline-date">{at}</div>}
              {step.detail && (
                <div className="order-timeline-detail">{step.detail}</div>
              )}
            </div>
          </li>
        );
      })}

      {durableEvents.length > 0 && (
        <li className="order-timeline-step is-recorded">
          <span className="order-timeline-dot" aria-hidden="true">
            <DotRecorded />
          </span>

          <div className="order-timeline-content order-timeline-content--wide">
            <details className="order-timeline-events">
              <summary className="order-timeline-events-summary">
                <span className="order-timeline-events-label">
                  Activity history
                </span>
                <span className="order-timeline-events-count">
                  {durableEvents.length}
                </span>
                <span className="order-timeline-events-chevron" aria-hidden="true">
                  ▾
                </span>
              </summary>

              <ul className="order-timeline-events-list">
                {durableEvents.map((event) => (
                  <li key={event.id} className="order-timeline-event">
                    <span className="order-timeline-event-type">
                      {String(event.type || '').replace(/_/g, ' ')}
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
