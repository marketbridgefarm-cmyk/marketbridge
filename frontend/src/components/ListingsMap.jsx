/* Listings map — uses the canonical MarketBridge tokens (mb-tokens.css). */

.lm { margin: 0 0 var(--mb-gap, 20px); }

.lm-canvas {
  height: clamp(340px, 62vh, 620px);
  width: 100%;
  border: var(--mb-bw, 1.5px) solid var(--mb-line, #cbd5e1);
  border-radius: var(--mb-radius-card, 22px);
  box-shadow: var(--mb-shadow-card, 0 8px 30px rgba(15, 23, 42, 0.08));
  overflow: hidden;
  background: var(--mb-neutral-bg, #f1f5f9);
  z-index: 0; /* keep Leaflet panes below the sticky nav and modals */
}

@media (max-width: 480px) {
  .lm-canvas { border-radius: 18px; height: clamp(320px, 58vh, 520px); }
}

.lm-note {
  margin: 8px 4px 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--mb-muted, #64748b);
}

/* Pin: orange teardrop with a white centre. */
.lm-pin-wrap { background: transparent; border: 0; }
.lm-pin {
  display: block;
  width: 24px;
  height: 24px;
  margin: 2px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--mb-accent, #c2410c);
  border: 3px solid #ffffff;
  box-shadow: 0 3px 8px rgba(15, 23, 42, 0.35);
  position: relative;
}
.lm-pin::after {
  content: '';
  position: absolute;
  inset: 5px;
  border-radius: 50%;
  background: #ffffff;
}
.leaflet-marker-icon:focus-visible .lm-pin,
.leaflet-marker-icon:hover .lm-pin {
  background: var(--mb-accent-ink, #9a3412);
}
.leaflet-marker-icon:focus-visible {
  outline: var(--mb-focus-ring, 3px solid #fed7aa);
  outline-offset: var(--mb-focus-offset, 2px);
  border-radius: 8px;
}

/* Popup */
.lm .leaflet-popup-content-wrapper {
  border-radius: var(--mb-radius-field, 16px);
  border: var(--mb-bw, 1.5px) solid var(--mb-line-soft, #e2e8f0);
  box-shadow: var(--mb-shadow-card, 0 8px 30px rgba(15, 23, 42, 0.08));
}
.lm .leaflet-popup-content { margin: 14px 16px; }
.lm-popup { display: grid; gap: 4px; color: var(--mb-ink, #0f172a); font-size: 14px; }
.lm-popup strong { font-size: 15px; }
.lm-muted { color: var(--mb-muted, #64748b); font-size: 13px; }
.lm-open {
  margin-top: 8px;
  min-height: var(--mb-touch-min, 44px);
  border: var(--mb-bw-strong, 2px) solid var(--mb-accent, #c2410c);
  border-radius: var(--mb-radius-sm, 12px);
  background: var(--mb-accent, #c2410c);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.lm-open:hover { background: var(--mb-accent-ink, #9a3412); border-color: var(--mb-accent-ink, #9a3412); }
.lm-open:focus-visible { outline: var(--mb-focus-ring, 3px solid #fed7aa); outline-offset: var(--mb-focus-offset, 2px); }

/* List / Map switch (sits in the Listings toolbar) */
.lm-toggle {
  display: inline-flex;
  border: var(--mb-bw, 1.5px) solid var(--mb-line, #cbd5e1);
  border-radius: var(--mb-radius-pill, 999px);
  overflow: hidden;
  background: var(--mb-surface, #ffffff);
}
.lm-toggle button {
  min-height: var(--mb-touch-min, 44px);
  min-width: 72px;
  padding: 0 16px;
  border: 0;
  background: transparent;
  color: var(--mb-ink-2, #334155);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.lm-toggle button[aria-pressed='true'] {
  background: var(--mb-accent, #c2410c);
  color: #ffffff;
}
.lm-toggle button:focus-visible {
  outline: var(--mb-focus-ring, 3px solid #fed7aa);
  outline-offset: calc(var(--mb-focus-offset, 2px) * -1);
}
