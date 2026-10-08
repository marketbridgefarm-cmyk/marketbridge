/* ==========================================================================
   Orders — MarketBridge card style
   Replaces src/pages/orders/Orders.css (pair with the updated Orders.jsx).
   Rules: card title = 2px line + short accent segment; sub-headers = 1.5px
   line only. Card internals respond to the card's own width.
   ========================================================================== */

.orders-page {
  --mb-ink: #0f172a;
  --mb-ink-2: #334155;
  --mb-muted: #64748b;
  --mb-accent: #c2410c;
  --mb-accent-ink: #9a3412;
  --mb-accent-tint: #fff7ed;
  --mb-accent-border: #fed7aa;
  --mb-ok: #047857;
  --mb-danger: #b91c1c;
  --mb-line: #cbd5e1;
  --mb-card: rgba(248, 251, 255, 0.95);
  --mb-radius-card: 22px;
  --mb-radius-field: 16px;

  background: linear-gradient(135deg, #eef0ff 0%, #dbe8f8 55%, #e6f6ee 100%);
  min-height: 100vh;
  min-height: 100dvh;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

/* ---- Page hero ---------------------------------------------------------- */
.orders-hero { margin: 0 0 20px; }

.orders-hero-eyebrow {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--mb-accent);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.25em;
  text-transform: uppercase;
}

.orders-hero-eyebrow::before {
  content: "";
  flex: none;
  width: 32px;
  height: 3px;
  background: var(--mb-accent);
  border-radius: 2px;
}

.orders-hero-title {
  margin: 8px 0 0;
  color: var(--mb-ink);
  font-size: 30px;
  font-weight: 800;
  line-height: 1.15;
}

.orders-hero-text {
  max-width: 60ch;
  margin: 10px 0 0;
  color: var(--mb-muted);
  font-size: 15px;
  line-height: 1.6;
}

/* ---- Stats strip -------------------------------------------------------- */
.stats-strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 20px;
}

.orders-page .stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: #fff;
  border: 1.5px solid var(--mb-line);
  border-radius: var(--mb-radius-field);
}

.orders-page .stat.tone-accent  { --stat-tone: #c2410c; }
.orders-page .stat.tone-info    { --stat-tone: #1d4ed8; }
.orders-page .stat.tone-gold    { --stat-tone: #b45309; }
.orders-page .stat.tone-success { --stat-tone: #047857; }

.stat-label {
  color: var(--mb-muted);
  font-size: 13px;
  font-weight: 700;
}

.stat-graphic {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
}

.stat-graphic svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.stat-track { stroke: #e2e8f0; }
.stat-ring  { stroke: var(--stat-tone); }

.stat-count {
  position: relative;
  color: var(--stat-tone);
  font-size: 15px;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* ---- Toolbar: tabs + search --------------------------------------------- */
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 20px;
}

.orders-page .sd-tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.orders-page .sd-tabs::-webkit-scrollbar { display: none; }

.orders-page .sd-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  white-space: nowrap;
}

.search {
  position: relative;
  display: block;
  flex: 1 1 240px;
}

.search-icon {
  position: absolute;
  left: 16px;
  top: 50%;
  width: 20px;
  height: 20px;
  margin-top: -10px;
  color: var(--mb-muted);
  pointer-events: none;
}

.search-icon svg { display: block; width: 100%; height: 100%; }

.search input {
  box-sizing: border-box;
  width: 100%;
  min-height: 52px;
  padding: 0 16px 0 46px;
  background: #fff;
  border: 1.5px solid var(--mb-line);
  border-radius: var(--mb-radius-field);
  color: var(--mb-ink);
  font-size: 16px;
}

.search input:focus-visible {
  outline: 3px solid var(--mb-accent-border);
  outline-offset: 2px;
}

@media (min-width: 720px) {
  .stats-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .toolbar { flex-direction: row; align-items: center; justify-content: space-between; }
  .search { flex: 0 1 320px; }
}

/* ---- Order cards -------------------------------------------------------- */
.order-list { display: flex; flex-direction: column; }

.order-card {
  container-type: inline-size;
  position: relative;
  margin: 0 0 20px;
  padding: 24px;
  background: var(--mb-card);
  border-radius: var(--mb-radius-card);
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
}

/* Always fill the card width, even if another rule shrink-wraps children */
.orders-page .order-list { align-items: stretch; }

.orders-page .order-card {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: none;
}

.orders-page .card-body,
.orders-page .card-block { display: block; }

.orders-page .order-card > *,
.orders-page .card-body > *,
.orders-page .card-block > *,
.orders-page .card-block-body > * {
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  min-width: 0;
}

/* Card tone: green on every card (Buying and Selling). Used by the eyebrow
   and the body headers so they always match. */
.order-card { --card-tone: var(--mb-ok); }

/* Title block: eyebrow + title + location on the left, party top right */
.order-card-head {
  position: relative;
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--mb-line);
}

.order-card-head::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -2px;
  width: 44px;
  height: 4px;
  background: var(--mb-accent);
}

.order-card-head-text { flex: 1 1 0; min-width: 0; }

.order-card .eyebrow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 8px;
  color: var(--card-tone);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.25em;
  text-transform: uppercase;
}

.order-card .eyebrow::before {
  content: "";
  flex: none;
  width: 16px;
  height: 3px;
  background: currentColor;
  border-radius: 2px;
}

.order-card .eyebrow.is-selling { color: var(--mb-ok); }

.order-title {
  margin: 0;
  color: var(--mb-ink);
  font-size: 24px;
  font-weight: 800;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.order-date {
  margin: 6px 0 0;
  color: var(--mb-muted);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.order-card-head-party {
  flex: none;
  align-self: flex-start;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.order-party-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 0;
  max-width: 120px;
  text-align: right;
}

.order-party-role {
  color: var(--mb-muted);
  font-size: 13px;
  font-weight: 700;
}

.order-party-name {
  max-width: 100%;
  overflow: hidden;
  color: var(--mb-ink);
  font-size: 15px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1.5px solid #e2e8f0;
  border-radius: 50%;
  background: #f1f5f9;
  color: var(--mb-ink-2);
  font-size: 14px;
  font-weight: 800;
}

.order-avatar.tone-success { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.order-avatar.tone-info    { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.order-avatar.tone-danger  { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.order-avatar.tone-gold    { background: #fffbeb; border-color: #fde68a; color: #92400e; }

/* ---- Blocks and sub-headers (line only) --------------------------------- */
.card-body { margin-top: 20px; }

.card-block + .card-block { margin-top: 22px; }

/* Push body content (pills, stepper, amount, created date) to the right of
   the headers. The indent scales with the card width. */
.orders-page .card-block-body {
  padding-inline-start: clamp(16px, 13cqw, 48px);
}

.orders-page .order-time {
  padding-inline-start: clamp(16px, 13cqw, 48px);
}

.card-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--mb-line);
}

.card-block-title h3 {
  margin: 0;
  color: var(--card-tone, var(--mb-ink));
  font-size: 15px;
  font-weight: 700;
}

.card-block-note {
  padding: 2px 10px;
  background: #fff;
  border: 1.5px solid var(--mb-line);
  border-radius: 999px;
  color: var(--mb-ink-2);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}

/* ---- Status pills ------------------------------------------------------- */
.badges { display: flex; flex-wrap: wrap; gap: 8px; }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: #f1f5f9;
  border: 1.5px solid #e2e8f0;
  border-radius: 999px;
  color: #475569;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.3;
}

.status-pill-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill.tone-success { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.status-pill.tone-info    { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.status-pill.tone-danger  { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.status-pill.tone-gold    { background: #fffbeb; border-color: #fde68a; color: #92400e; }

/* Latest progress pill, right side of the "Order status" header */
.card-block-title .header-pill {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 68%;
}

.header-pill-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Progress: vertical on narrow cards, horizontal when there is room -- */
.order-progress {
  display: flex;
  flex-direction: column;
  margin: 18px 0 0;
}

.progress-step {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 16px;
  color: var(--mb-muted);
  font-size: 14px;
  font-weight: 700;
  line-height: 18px;
}

.progress-step:last-child { padding-bottom: 0; }

.progress-step::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 18px;
  bottom: 0;
  width: 2px;
  background: var(--mb-line);
}

.progress-step:last-child::before { display: none; }

.progress-dot {
  flex: none;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  background: #fff;
  border: 2px solid var(--mb-line);
  border-radius: 50%;
}

.progress-step.done { color: var(--mb-ink-2); }
.progress-step.done::before { background: var(--mb-ok); }
.progress-step.done .progress-dot { background: var(--mb-ok); border-color: var(--mb-ok); }

.progress-step.current { color: var(--mb-ink); }
.progress-step.current .progress-dot {
  background: var(--mb-accent);
  border-color: var(--mb-accent);
  box-shadow: inset 0 0 0 3px #fff;
}

/* Vertical stepper: center the block in the card; dots and labels stay
   left-aligned inside it. The horizontal layout still fills the row. */
.order-progress {
  width: fit-content;
  min-width: min(240px, 100%);
  max-width: 100%;
  margin-inline: auto;
}

/* In Orders list cards the stepper lines up with the indented body instead */
.orders-page .card-block-body > .order-progress {
  width: 100%;
  min-width: 0;
  margin-inline: 0;
  margin-top: 0;
}

@container (min-width: 520px) {
  .order-progress { width: 100%; }
}

/* ---- Amount ------------------------------------------------------------- */
.order-price {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.price-amount {
  color: var(--mb-ink);
  font-size: 30px;
  font-weight: 800;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.price-currency {
  color: var(--mb-muted);
  font-size: 15px;
  font-weight: 700;
}

/* ---- Meta row: created date (left) + ORD code (right) ------------------- */
.order-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 22px;
  padding-inline-end: 14px;
}

.order-time {
  min-width: 0;
  color: var(--mb-muted);
  font-size: 14px;
}

.order-code {
  flex: none;
  color: var(--mb-muted);
  font-size: 14px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* The meta row's children must not stretch to full width */
.orders-page .order-meta > * {
  width: auto;
}

/* ---- Footer actions ----------------------------------------------------- */
.order-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.btn-view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  padding: 0 18px;
  background: transparent;
  border: 2px solid var(--mb-line);
  border-radius: var(--mb-radius-field);
  color: var(--mb-ink-2);
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
  transition: background-color 0.15s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-view:focus-visible {
  outline: 3px solid var(--mb-accent-border);
  outline-offset: 2px;
}

@media (hover: hover) {
  .btn-view:hover { background: rgba(255, 255, 255, 0.8); }
}

/* ---- Loading and empty/error states ------------------------------------- */
.loading {
  margin: 24px 0;
  color: var(--mb-muted);
  font-size: 15px;
}

.state-card {
  padding: 24px;
  background: var(--mb-card);
  border-radius: var(--mb-radius-card);
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
}

.state-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin: 0 0 14px;
  background: var(--mb-accent-tint);
  border: 1.5px solid var(--mb-accent-border);
  border-radius: 50%;
  color: var(--mb-accent-ink);
}

.state-card h3 {
  position: relative;
  margin: 0 0 14px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--mb-line);
  color: var(--mb-ink);
  font-size: 20px;
  font-weight: 800;
}

.state-card h3::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -2px;
  width: 44px;
  height: 4px;
  background: var(--mb-accent);
}

.state-card p {
  margin: 0;
  color: var(--mb-muted);
  font-size: 15px;
  line-height: 1.6;
}

/* ---- Responsiveness ----------------------------------------------------- */

/* Phones: tighter padding and type so content gets the width */
@media (max-width: 480px) {
  .order-card,
  .state-card { padding: 18px; border-radius: 18px; }

  .orders-hero-title { font-size: 26px; }
  .order-title { font-size: 22px; }
  .order-card .eyebrow,
  .orders-hero-eyebrow { gap: 10px; letter-spacing: 0.2em; }
  .order-card .eyebrow::before { width: 13px; }
  .orders-hero-eyebrow::before { width: 26px; }
  .price-amount { font-size: 28px; }
}

@media (max-width: 360px) {
  .order-card,
  .state-card { padding: 14px; }

  .order-title { font-size: 20px; }
  .order-party-info { max-width: 84px; }
}

/* Card internals respond to the card's own width (works beside a sidebar) */
@container (min-width: 460px) {
  .order-actions { flex-direction: row; align-items: center; justify-content: flex-end; }
  .btn-view { width: auto; flex: none; }
}

@container (min-width: 520px) {
  .order-progress { flex-direction: row; }

  .progress-step {
    flex: 1 1 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 0 8px 0 0;
  }

  .progress-step::before {
    left: 26px;
    right: 4px;
    top: 8px;
    bottom: auto;
    width: auto;
    height: 2px;
  }
}

@container (min-width: 760px) {
  .order-party-info { max-width: 220px; }
}

@media (prefers-reduced-motion: reduce) {
  .btn-view { transition: none; }
}
