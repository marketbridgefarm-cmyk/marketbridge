import React, { useEffect, useState } from 'react';

import { initials } from './orderDetailUtils.js';

// ============================================================================
// ORDER DETAIL — UI PRIMITIVES
// ============================================================================
//
// Small presentational components used by OrderDetail.jsx and its extracted
// card components. No data fetching, no state, no side effects — pure
// render-only building blocks.
// ============================================================================

export function Modal({ isOpen, onClose, title, children }) {
  if (!isOpen) return null;
  return (
    <div className="od-modal-backdrop" onClick={onClose}>
      <div className="od-modal" onClick={(e) => e.stopPropagation()}>
        <div className="od-modal-head">
          <span className="od-modal-title">{title}</span>
          <button type="button" className="od-modal-close" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>
        <div className="od-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Card({ id, eyebrow, eyebrowClass, title, subtitle, side, tone, className, children }) {
  return (
    <section className={`card${tone ? ` od-card-${tone}` : ''}${className ? ` ${className}` : ''}`} id={id}>
      <header className="od-card-head">
        <div className="od-card-head-main">
          {eyebrow && <span className={`od-eyebrow${eyebrowClass ? ` ${eyebrowClass}` : ''}`}>{eyebrow}</span>}
          <h2 className="od-card-title">{title}</h2>
          {subtitle && <p className="od-card-subtitle">{subtitle}</p>}
        </div>
        {side && <div className="od-card-head-side">{side}</div>}
      </header>
      {children}
    </section>
  );
}

export function Section({ title, meta, strong, children }) {
  return (
    <div className="od-card-section">
      {(title || meta) && (
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">{title}</h3>
          {meta != null && (
            <div className={`od-card-section-meta${strong ? ' is-strong' : ''}`}>
              {meta}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export const Avatar = ({ name, small }) => (
  <span className={`od-party-avatar${small ? ' od-party-avatar--sm' : ''}`} aria-hidden="true">
    {initials(name)}
  </span>
);

export function PartyBadge({ role, name }) {
  return (
    <div className="od-card-side-party">
      <div>
        <span className="od-card-side-label">{role}</span>
        <span className="od-card-side-value">{name || '—'}</span>
      </div>
      <Avatar name={name} />
    </div>
  );
}

export const Pill = ({ tone = 'neutral', dot = true, children }) => (
  <span className={`od-status-pill od-tone-${tone}`}>
    {dot && <span className="od-status-pill-dot" aria-hidden="true" />}
    {children}
  </span>
);

export const Finding = ({ text, empty }) =>
  text ? <span className="od-finding-flag">{text}</span> : <Pill tone="good" dot={false}>{empty}</Pill>;

export const Facts = ({ children }) => <div className="od-detail-facts">{children}</div>;

export const Fact = ({ name, children }) => (
  <div>
    <span>{name}</span>
    <strong>{children}</strong>
  </div>
);

export const YouTag = ({ inline }) => (
  <span className={`od-party-you${inline ? ' od-party-you-inline' : ''}`}>You</span>
);

export const Actions = ({ children }) => <div className="od-actions">{children}</div>;

export const SideLabel = ({ name, children }) => (
  <>
    <span className="od-card-side-label">{name}</span>
    {children}
  </>
);

export function Notice({ title, children }) {
  return (
    <div className="od-notice">
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export const Button = ({ variant = 'default', size, busy, busyText, children, ...rest }) => (
  <button
    type="button"
    className={`btn${variant !== 'default' ? ` btn-${variant}` : ''}${size ? ` btn-${size}` : ''}`}
    {...rest}
  >
    {busy ? busyText : children}
  </button>
);

export function useNowUntil(targetMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetMs || Number.isNaN(targetMs)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [targetMs]);
  return now;
}
