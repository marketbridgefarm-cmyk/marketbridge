import React from 'react';

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
// communicated without color alone (WCAG 1.4.1).
// ============================================================================

const formatDate = (value) => {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return null;
  }
};

// Inline SVG indicators — no external icon font needed (CSP-safe).
function DotComplete() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="13" fill="var(--mb-primary)" />
      <path d="M7.5 13.5l4 4 7-8" stroke="#fff" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DotCurrent() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="var(--mb-primary)" strokeWidth="2"
        fill="var(--mb-card)" />
      <circle cx="13" cy="13" r="5" fill="var(--mb-primary)" />
    </svg>
  );
}

function DotPending() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="var(--mb-border)" strokeWidth="2"
        fill="var(--mb-bg)" />
    </svg>
  );
}

function DotRecorded() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="12" stroke="var(--mb-info-border, #b9e6fe)"
        strokeWidth="2" fill="var(--mb-info-light, #f0f9ff)" />
      <circle cx="13" cy="13" r="4" fill="var(--mb-info, #026aa2)" />
    </svg>
  );
}

export default function OrderTimeline({ steps, events = [] }) {
  const milestoneSteps = Array.isArray(steps) ? steps : [];
  const durableEvents  = Array.isArray(events) ? events : [];
  if (milestoneSteps.length === 0 && durableEvents.length === 0) return null;

  const lastCompletedIndex = milestoneSteps.reduce(
    (acc, step, index) => (step.completed ? index : acc),
    -1,
  );

  return (
    <ol className="order-timeline" aria-label="Order milestone progress">
      {milestoneSteps.map((step, index) => {
        const isCurrent   = !step.completed && index === lastCompletedIndex + 1;
        const stateClass  = step.completed ? 'is-complete' : isCurrent ? 'is-current' : 'is-pending';
        const at          = formatDate(step.at);
        const label       = step.completed
          ? 'Completed milestone'
          : isCurrent ? 'Current milestone' : 'Upcoming milestone';

        return (
          <li key={step.code} className={`order-timeline-step ${stateClass}`}>
            <span className="order-timeline-dot" role="img" aria-label={label}>
              {step.completed
                ? <DotComplete />
                : isCurrent
                  ? <DotCurrent />
                  : <DotPending />}
            </span>
            <div>
              <div className="order-timeline-label">{step.label}</div>
              {at && <div className="order-timeline-date muted">{at}</div>}
            </div>
          </li>
        );
      })}

      {durableEvents.length > 0 && (
        <li className="order-timeline-step is-recorded">
          <span className="order-timeline-dot" aria-hidden="true">
            <DotRecorded />
          </span>
          <div style={{ width: '100%' }}>
            {/* Collapsed: this list only grows and is rarely what someone
                opens the timeline to see first. */}
            <details>
              <summary className="order-timeline-label" style={{ cursor: 'pointer' }}>
                Activity history ({durableEvents.length})
              </summary>
              <div style={{ marginTop: 6 }}>
                {durableEvents.map((event) => (
                  <div key={event.id} className="muted" style={{ fontSize: 12, marginBottom: 5 }}>
                    <strong>{String(event.type || '').replace(/_/g, ' ')}</strong>
                    {event.actor?.name ? ` — ${event.actor.name}` : ''}
                    {formatDate(event.at)  ? ` · ${formatDate(event.at)}`  : ''}
                  </div>
                ))}
              </div>
            </details>
          </div>
        </li>
      )}
    </ol>
  );
}
