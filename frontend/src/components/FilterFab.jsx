import React, { useEffect, useRef, useState } from 'react';
import './FilterFab.css';

/**
 * Filters as a floating action button (bottom-right). Tapping it fans out one
 * rounded-square icon button per filter, each with its name (and current value)
 * beside it. Tapping a filter opens just that filter's options.
 *
 * Props:
 *  - groups:   chip filters. [{ key?, title, icon?, value, defaultValue, onChange(value),
 *              options: [{ id, label }] }]  (badge dot when value !== defaultValue)
 *  - sections: custom filters with their own controls.
 *              [{ key?, title, icon?, active?: boolean, children, footer? }]
 *  - label:    accessible name for the main button (default "Filters")
 *  - stacked:  lift the button one slot higher (use when another FAB is on the page)
 *
 * icon is one of: status, type, show, filter, sliders, location, price, calendar, tag.
 * The parent still owns all filter state.
 */

const ICONS = {
  filter:   <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  sliders:  <><path d="M4 6h16M7 12h10M10 18h4" /></>,
  status:   <><circle cx="12" cy="12" r="8" /><path d="m8.5 12.3 2.4 2.4 4.6-5" /></>,
  type:     <><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  show:     <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3 3 0 0 1 0 5M18 20a6 6 0 0 0-2.5-4.9" /></>,
  location: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  price:    <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 12h.01M17.5 12h.01" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4" /></>,
  tag:      <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.2" /></>,
  close:    <path d="M6 6l12 12M18 6L6 18" />,
  back:     <path d="m15 6-6 6 6 6" />,
};

function Icon({ name, size = 24 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] || ICONS.filter}
    </svg>
  );
}

export default function FilterFab({
  groups = [],
  sections = [],
  label = 'Filters',
  stacked = false,
}) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(null);
  const shellRef = useRef(null);

  const items = [
    ...groups.map((g) => ({ ...g, kind: 'group', key: g.key || g.title })),
    ...sections.map((s) => ({ ...s, kind: 'section', key: s.key || s.title })),
  ];
  const active = items.find((i) => i.key === activeKey) || null;

  const close = () => { setOpen(false); setActiveKey(null); };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (shellRef.current && !shellRef.current.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (activeKey) setActiveKey(null); else close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, activeKey]);

  const isOn = (i) => (i.kind === 'group'
    ? i.value !== (i.defaultValue ?? i.options?.[0]?.id)
    : Boolean(i.active));
  const badge = items.filter(isOn).length;
  const currentLabel = (i) => i.options?.find((o) => o.id === i.value)?.label;

  return (
    <div className={`mb-fab-shell${stacked ? ' mb-fab-shell--stacked' : ''}`} ref={shellRef}>
      {open && !active && (
        <ul className="mb-fab-stack" aria-label={label}>
          {items.map((i) => (
            <li key={i.key}>
              <button type="button" className="mb-fab-item" onClick={() => setActiveKey(i.key)}>
                <span className="mb-fab-item-label">
                  <strong>{i.title}</strong>
                  {i.kind === 'group' && currentLabel(i) && <em>{currentLabel(i)}</em>}
                </span>
                <span className={`mb-fab-item-icon${isOn(i) ? ' on' : ''}`}>
                  <Icon name={i.icon || (i.kind === 'group' ? 'filter' : 'sliders')} size={22} />
                  {isOn(i) && <span className="mb-fab-item-dot" aria-hidden="true" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && active && (
        <div className="mb-fab-panel" role="dialog" aria-label={active.title}>
          <div className="mb-fab-panel-head">
            <button type="button" className="mb-fab-back" aria-label="Back to filters" onClick={() => setActiveKey(null)}>
              <Icon name="back" size={20} />
            </button>
            <span className="mb-fab-panel-icon"><Icon name={active.icon || 'filter'} size={20} /></span>
            <strong>{active.title}</strong>
          </div>
          {active.kind === 'group' ? (
            <div className="mb-fab-options">
              {active.options.map(({ id, label: optLabel }) => (
                <button
                  key={id}
                  type="button"
                  className={`mb-fab-option${active.value === id ? ' active' : ''}`}
                  aria-pressed={active.value === id}
                  onClick={() => active.onChange(id)}
                >
                  {optLabel}
                </button>
              ))}
            </div>
          ) : (
            <div className="mb-fab-extra">
              {active.children}
              {active.footer}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className={`mb-fab${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name={open ? 'close' : 'filter'} />
        {!open && badge > 0 && <span className="mb-fab-badge" aria-hidden="true">{badge}</span>}
      </button>
    </div>
  );
}
