import React, { useState } from 'react';

// ============================================================================
// COLLAPSIBLE
// ============================================================================
// A `.card` that can be expanded/collapsed by the person viewing it. Order
// detail pages accumulate a lot of cards (timeline, payouts, payment
// center, disputes...) and on a long-running order every one of them is
// rendered at once, which makes the page very long to scroll. This wraps a
// card's existing header/body so any section can opt into being
// collapsed by default without changing what data it shows or how it's
// fetched — purely a display convenience, no state persists across visits.
//
// Usage:
//   <Collapsible eyebrow="SELLER PAYOUT" title="Seller payout status" summary={<span className="badge ...">HELD</span>}>
//     ...existing card body...
//   </Collapsible>
// ============================================================================

export default function Collapsible({
  eyebrow,
  title,
  description,
  summary,
  defaultOpen = true,
  id,
  className = '',
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`card collapsible-card ${open ? 'is-open' : 'is-closed'} ${className}`} id={id}>
      <button
        type="button"
        className="collapsible-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <div className="collapsible-header-text">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          {title && <h2 style={{ marginBottom: description ? 6 : 0 }}>{title}</h2>}
          {description && <p className="muted" style={{ marginBottom: 0 }}>{description}</p>}
        </div>

        <div className="collapsible-header-side">
          {summary}
          <span className="collapsible-chevron" aria-hidden="true">▾</span>
        </div>
      </button>

      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}
