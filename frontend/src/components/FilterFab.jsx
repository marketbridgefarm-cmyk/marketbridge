import React, { useEffect, useRef, useState } from 'react';
import './FilterFab.css';

/**
 * Filters as a floating action button (bottom-right). Tapping it opens a panel
 * with the page's filters; the parent still owns all filter state.
 *
 * Props:
 *  - groups: [{ title, value, defaultValue, onChange(value), options: [{ id, label }] }]
 *            Chip groups. A group counts toward the badge when value !== defaultValue.
 *  - extraBadge: extra number added to the badge (for filters passed as `children`)
 *  - children: any extra controls (inputs, selects, buttons) shown under the chips
 *  - label: accessible name for the button (default "Filters")
 *  - stacked: lift the button one slot higher (use when another FAB is on the page)
 */
export default function FilterFab({
  groups = [],
  extraBadge = 0,
  children,
  label = 'Filters',
  stacked = false,
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (shellRef.current && !shellRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const badge =
    groups.filter((g) => g.value !== (g.defaultValue ?? g.options?.[0]?.id)).length +
    (extraBadge || 0);

  return (
    <div className={`mb-fab-shell${stacked ? ' mb-fab-shell--stacked' : ''}`} ref={shellRef}>
      <button
        type="button"
        className={`mb-fab${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
        )}
        {!open && badge > 0 && <span className="mb-fab-badge" aria-hidden="true">{badge}</span>}
      </button>

      {open && (
        <div className="mb-fab-panel" role="dialog" aria-label={label}>
          {groups.map((g) => (
            <div key={g.title} className="mb-fab-group">
              <p className="mb-fab-group-title">{g.title}</p>
              <div className="mb-fab-options">
                {g.options.map(({ id, label: optLabel }) => (
                  <button
                    key={id}
                    type="button"
                    className={`mb-fab-option${g.value === id ? ' active' : ''}`}
                    aria-pressed={g.value === id}
                    onClick={() => g.onChange(id)}
                  >
                    {optLabel}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {children && <div className="mb-fab-extra">{children}</div>}
        </div>
      )}
    </div>
  );
}
