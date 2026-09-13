import React from 'react';

// ============================================================================
// ORDER TIMELINE
// ============================================================================
// Shows chronological transaction progress from the `timeline` array
// returned by GET /orders/:id/workflow. Steps that don't apply to this
// order (e.g. no inspection was requested) are simply absent from the
// array rather than shown as permanently pending.
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

export default function OrderTimeline({ steps, events = [] }) {
  const milestoneSteps = Array.isArray(steps) ? steps : [];
  const durableEvents = Array.isArray(events) ? events : [];
  if (milestoneSteps.length === 0 && durableEvents.length === 0) return null;

  const lastCompletedIndex = milestoneSteps.reduce(
    (acc, step, index) => (step.completed ? index : acc),
    -1
  );

  return (
    <ol className="order-timeline">
      {milestoneSteps.map((step, index) => {
        const isCurrent = !step.completed && index === lastCompletedIndex + 1;
        const stateClass = step.completed ? 'is-complete' : isCurrent ? 'is-current' : 'is-pending';
        const at = formatDate(step.at);

        return (
          <li key={step.code} className={`order-timeline-step ${stateClass}`}>
            <span className="order-timeline-dot" aria-hidden="true" />
            <div>
              <div className="order-timeline-label">{step.label}</div>
              {at && <div className="order-timeline-date muted">{at}</div>}
            </div>
          </li>
        );
      })}

      {durableEvents.length > 0 && (
        <li className="order-timeline-step is-recorded">
          <span className="order-timeline-dot" aria-hidden="true" />
          <div style={{ width: '100%' }}>
            <div className="order-timeline-label">Activity history</div>
            <div style={{ marginTop: 6 }}>
              {durableEvents.map((event) => (
                <div key={event.id} className="muted" style={{ fontSize: 12, marginBottom: 5 }}>
                  <strong>{String(event.type || '').replace(/_/g, ' ')}</strong>
                  {event.actor?.name ? ` — ${event.actor.name}` : ''}
                  {formatDate(event.at) ? ` · ${formatDate(event.at)}` : ''}
                </div>
              ))}
            </div>
          </div>
        </li>
      )}
    </ol>
  );
}
