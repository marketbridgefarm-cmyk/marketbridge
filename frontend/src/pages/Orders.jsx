/* ============================================================
   MarketBridge — Orders list  (pages/order/orders.css)
   Every order card follows the OrderDetail card system:
     card-head       — eyebrow (green dash) + title on the left,
                       party + avatar on the right
     card-block      — content title + tiny hairline
     content
     footer          — action row
   2-column grid on desktop / tablet, single column on phones.
   ============================================================ */

.orders-page {
  /* ── Tokens ───────────────────────────────────────────── */
  --o-accent:      #1e9e5a;
  --o-accent-2:    #0f7a44;
  --o-accent-ink:  #12734a;
  --o-accent-soft: #ecfdf3;
  --o-accent-line: #c6eccf;

  --o-ink:         #0d1b2a;
  --o-ink-soft:    #2c3a4a;
  --o-muted:       #64748b;
  --o-muted-2:     #94a3b8;

  --o-card:        #ffffff;
  --o-tint-a:      #eefbf3;
  --o-tint-b:      #eff3fb;

  --o-line:        #e5e9ef;
  --o-line-soft:   #eef1f5;
  --o-surface:     #fbfcfd;

  --o-gold:        #a86f10;
  --o-gold-soft:   #fdf6e7;
  --o-gold-line:   #f4e0b6;

  --o-danger:      #b42318;
  --o-danger-soft: #fef2f2;
  --o-danger-line: #fecaca;

  --o-info:        #1e5fa8;
  --o-info-soft:   #eff5fd;
  --o-info-line:   #cddff5;

  --o-radius:      20px;
  --o-shadow:      0 1px 2px rgba(15, 30, 45, .04),
                   0 8px 24px rgba(15, 30, 45, .05);
  --o-shadow-hi:   0 2px 4px rgba(15, 30, 45, .04),
                   0 18px 44px rgba(15, 30, 45, .09);
  --o-shadow-sm:   0 1px 2px rgba(15, 30, 45, .05);
  --o-ring:        0 0 0 3px rgba(30, 158, 90, .18);
  --o-ease:        cubic-bezier(.2, .7, .3, 1);

  min-height: calc(100vh - 72px);
  color: var(--o-ink);
  font-family: var(--mb-font-body, 'DM Sans', system-ui, -apple-system, Segoe UI, Roboto, sans-serif);
  -webkit-font-smoothing: antialiased;

  background:
    radial-gradient(circle at 88% 0%,  rgba(230, 245, 236, .85), transparent 40%),
    radial-gradient(circle at 5% 100%, rgba(231, 235, 245, .8),  transparent 40%),
    linear-gradient(180deg, #f6f8fa 0%, #eef2f5 100%);
  background-attachment: fixed;
}

.orders-page .container-narrow {
  max-width: 1180px;
  margin: 0 auto;
  padding: 40px 24px 80px;
}

/* ── Page header ────────────────────────────────────────── */

.orders-page .page-header {
  margin-bottom: 26px;
}

.orders-page .page-header .eyebrow,
.orders-page .eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--o-accent-ink);
  font: 700 11px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .16em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.orders-page .eyebrow::before {
  content: '';
  flex: 0 0 20px;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
}

.orders-page .page-header h1 {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: clamp(26px, 4vw, 34px);
  font-weight: 800;
  letter-spacing: -.7px;
  line-height: 1.1;
  color: var(--o-ink);
  margin: 0 0 10px;
}

.orders-page .page-header p {
  color: var(--o-muted);
  font-size: 15px;
  line-height: 1.6;
  max-width: 60ch;
  margin: 0;
}

/* ── Stats strip ────────────────────────────────────────── */

.orders-page .stats-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}

.orders-page .stat {
  padding: 14px 16px;
  border: 1px solid var(--o-line);
  border-radius: 14px;
  background: #fff;
  box-shadow: var(--o-shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: border-color .18s var(--o-ease), transform .18s var(--o-ease);
}

.orders-page .stat:hover {
  border-color: rgba(30, 158, 90, .3);
  transform: translateY(-1px);
}

.orders-page .stat-label {
  font: 700 10.5px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--o-muted);
}

.orders-page .stat-value {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -.5px;
  color: var(--o-ink);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.orders-page .stat.tone-accent .stat-value { color: var(--o-accent-2); }

/* ── Toolbar: tabs + search ─────────────────────────────── */

.orders-page .toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.orders-page .sd-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--o-line);
  border-radius: 999px;
  background: #fff;
  box-shadow: var(--o-shadow-sm);
}

.orders-page .sd-tab {
  appearance: none;
  border: none;
  background: transparent;
  padding: 8px 18px;
  border-radius: 999px;
  color: var(--o-muted);
  font: 600 13px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  cursor: pointer;
  transition: color .15s var(--o-ease), background .15s var(--o-ease);
}

.orders-page .sd-tab:hover {
  color: var(--o-ink);
  background: var(--o-line-soft);
}

.orders-page .sd-tab:focus-visible {
  outline: none;
  box-shadow: var(--o-ring);
}

.orders-page .sd-tab.sd-active {
  background: linear-gradient(150deg, var(--o-accent) 0%, var(--o-accent-2) 100%);
  color: #fff;
  box-shadow: 0 4px 12px rgba(30, 158, 90, .24);
}

/* ── Search ─────────────────────────────────────────────── */

.orders-page .search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 220px;
  min-width: 180px;
  max-width: 320px;
  margin-left: auto;
}

.orders-page .search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--o-muted-2);
  pointer-events: none;
  z-index: 1;
}

.orders-page .search-icon svg {
  display: block;
  width: 100%;
  height: 100%;
}

.orders-page .search input {
  width: 100%;
  height: 40px;
  padding: 0 14px 0 40px;
  border: 1px solid var(--o-line);
  border-radius: 999px;
  background: #fff;
  color: var(--o-ink);
  font: inherit;
  font-size: 13.5px;
  line-height: 1;
  box-shadow: var(--o-shadow-sm);
  transition: border-color .18s var(--o-ease), box-shadow .18s var(--o-ease);
  -webkit-appearance: none;
  appearance: none;
}

.orders-page .search input::placeholder { color: var(--o-muted-2); }

.orders-page .search input:focus {
  outline: none;
  border-color: var(--o-accent);
  box-shadow: var(--o-ring);
}

.orders-page .search input::-webkit-search-decoration,
.orders-page .search input::-webkit-search-cancel-button,
.orders-page .search input::-webkit-search-results-button,
.orders-page .search input::-webkit-search-results-decoration {
  -webkit-appearance: none;
  appearance: none;
}

/* ── Order grid — 2 columns on desktop / tablet ─────────── */

.orders-page .order-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (min-width: 760px) {
  .orders-page .order-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* ── Order card ─────────────────────────────────────────── */

.orders-page .order-card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 22px 24px;
  border: 1px solid var(--o-line);
  border-radius: var(--o-radius);
  background-color: #fff;
  box-shadow: var(--o-shadow);
  transition: border-color .2s var(--o-ease),
              box-shadow .2s var(--o-ease),
              transform .2s var(--o-ease);
}

.orders-page .order-card:hover {
  border-color: rgba(30, 158, 90, .28);
  box-shadow: var(--o-shadow-hi);
  transform: translateY(-2px);
}

/* ── Card head — eyebrow + title on the left, party + avatar on the right ── */

.orders-page .order-card .card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 16px;
  margin: 0 0 16px;
  border-bottom: 1px solid var(--o-line);
}

.orders-page .order-card .card-head-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  flex: 1 1 auto; /* Ensures this takes up available space, pushing the right side away */
}

/* The eyebrow inside a card */
.orders-page .order-card .eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--o-accent-ink);
  font: 700 11px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .16em;
  text-transform: uppercase;
  margin: 0 0 6px;
}

.orders-page .order-card .eyebrow::before {
  content: '';
  flex: 0 0 18px;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
}

.orders-page .order-card .eyebrow.is-selling {
  color: var(--o-info);
}

.orders-page .order-title {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -.3px;
  line-height: 1.25;
  color: var(--o-ink);
  margin: 0 0 4px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.orders-page .order-date {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--o-muted);
  font-variant-numeric: tabular-nums;
}

/* ── Party cluster at the far right of the header ──────── */

.orders-page .order-card .card-head-party {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  /* ✨ FIX: Forces this block to the absolute right edge */
  margin-left: auto; 
}

.orders-page .order-card .order-party-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
  gap: 2px;
  min-width: 0;
  max-width: 160px;
}

.orders-page .order-card .order-party-role {
  font: 700 10px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--o-muted);
}

.orders-page .order-card .order-party-name {
  font: 700 13.5px/1.3 var(--mb-font-body, 'DM Sans', sans-serif);
  color: var(--o-ink);
  letter-spacing: -.1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.orders-page .order-avatar {
  width: 46px;
  height: 46px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-weight: 800;
  font-size: 15px;
  letter-spacing: -.2px;
  flex: 0 0 auto;
}

.orders-page .order-avatar.tone-success { background: var(--o-accent-soft); color: var(--o-accent-2); }
.orders-page .order-avatar.tone-info    { background: var(--o-info-soft);   color: var(--o-info); }
.orders-page .order-avatar.tone-gold    { background: var(--o-gold-soft);   color: var(--o-gold); }
.orders-page .order-avatar.tone-danger  { background: var(--o-danger-soft); color: var(--o-danger); }
.orders-page .order-avatar.tone-muted   { background: var(--o-line-soft);   color: var(--o-muted); }

/* Legacy helper — kept for safety in case other pages use it */
.orders-page .order-party {
  margin: 0;
  font-size: 13px;
  color: var(--o-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.orders-page .order-party .dot {
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--o-muted-2);
  flex: 0 0 auto;
}

/* ── Card body ──────────────────────────────────────────── */

.orders-page .order-card .card-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
}

/* ── Card block — content title with tiny hairline ─────── */

.orders-page .order-card .card-block {
  margin: 0 0 18px;
}
.orders-page .order-card .card-block:last-of-type { margin-bottom: 0; }

.orders-page .order-card .card-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 0 10px;
  margin: 0 0 14px;
  border-bottom: 1px solid var(--o-line-soft);
}

.orders-page .order-card .card-block-title h3 {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: -.1px;
  line-height: 1.3;
  color: var(--o-ink);
  margin: 0;
}

.orders-page .order-card .card-block-note {
  font: 600 12px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .01em;
  color: var(--o-muted);
  flex: 0 0 auto;
}

.orders-page .order-card .card-block-body { display: block; }

/* ── Badges row ─────────────────────────────────────────── */

.orders-page .badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.orders-page .status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--o-line-soft);
  color: var(--o-ink-soft);
  font: 700 11px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.orders-page .status-pill-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; flex: 0 0 auto; opacity: .85;
}

.orders-page .status-pill.tone-success {
  background: var(--o-accent-soft);
  border-color: var(--o-accent-line);
  color: var(--o-accent-ink);
}

.orders-page .status-pill.tone-info {
  background: var(--o-info-soft);
  border-color: var(--o-info-line);
  color: var(--o-info);
}

.orders-page .status-pill.tone-gold {
  background: var(--o-gold-soft);
  border-color: var(--o-gold-line);
  color: var(--o-gold);
}

.orders-page .status-pill.tone-danger {
  background: var(--o-danger-soft);
  border-color: var(--o-danger-line);
  color: var(--o-danger);
}

.orders-page .status-pill.tone-muted {
  background: var(--o-line-soft);
  border-color: var(--o-line);
  color: var(--o-muted);
}

/* ── Progress timeline ─────────────────────────────────── */

.orders-page .order-progress {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  width: 100%;
  margin: 16px 0 0;
  padding: 0 4px;
}

.orders-page .progress-step {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.orders-page .progress-step::before {
  content: '';
  position: absolute;
  top: 7px;
  right: 50%;
  left: -50%;
  height: 2px;
  background: var(--o-line);
  z-index: 0;
}

.orders-page .progress-step:first-child::before { display: none; }

.orders-page .progress-step.done::before,
.orders-page .progress-step.current::before {
  background: var(--o-accent);
}

.orders-page .progress-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--o-line);
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all .2s var(--o-ease);
}

.orders-page .progress-dot::after {
  content: '';
  width: 4px; height: 4px;
  border-radius: 50%;
  background: transparent;
}

.orders-page .progress-step.done .progress-dot {
  background: var(--o-accent);
  border-color: var(--o-accent);
}

.orders-page .progress-step.done .progress-dot::after {
  content: '';
  width: 8px; height: 8px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3 8.5l3 3 7-7' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>");
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}

.orders-page .progress-step.current .progress-dot {
  background: #fff;
  border-color: var(--o-accent);
  box-shadow: 0 0 0 4px rgba(30, 158, 90, .16);
}

.orders-page .progress-step.current .progress-dot::after {
  background: var(--o-accent);
}

.orders-page .progress-label {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--o-muted-2);
  letter-spacing: .01em;
  line-height: 1.3;
  max-width: 90px;
}

.orders-page .progress-step.done .progress-label { color: var(--o-ink-soft); }

.orders-page .progress-step.current .progress-label {
  color: var(--o-accent-2);
  font-weight: 700;
}

/* ── Amount block ──────────────────────────────────────── */

.orders-page .order-price {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.orders-page .price-amount {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -.5px;
  color: var(--o-ink);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.orders-page .price-currency {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .12em;
  color: var(--o-muted);
  text-transform: uppercase;
}

/* ── Card footer ────────────────────────────────────────── */

.orders-page .order-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid var(--o-line-soft);
}

.orders-page .order-time {
  font-size: 12px;
  color: var(--o-muted);
}

.orders-page .btn-view {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 16px;
  border-radius: 10px;
  border: 1px solid var(--o-line);
  background: #fff;
  color: var(--o-ink);
  font: 700 13px/1 var(--mb-font-body, 'DM Sans', sans-serif);
  letter-spacing: .01em;
  cursor: pointer;
  text-decoration: none;
  transition: border-color .15s var(--o-ease),
              background .15s var(--o-ease),
              color .15s var(--o-ease),
              transform .15s var(--o-ease);
}

.orders-page .btn-view svg { transition: transform .15s var(--o-ease); }

.orders-page .btn-view:hover {
  border-color: var(--o-accent);
  background: var(--o-accent-soft);
  color: var(--o-accent-2);
  text-decoration: none;
}

.orders-page .btn-view:hover svg { transform: translateX(3px); }

.orders-page .btn-view:focus-visible {
  outline: none;
  box-shadow: var(--o-ring);
}

/* ── Empty / loading / error ────────────────────────────── */

.orders-page .state-card {
  padding: 48px 24px;
  border: 1px dashed var(--o-line);
  border-radius: var(--o-radius);
  background: rgba(255, 255, 255, .7);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.orders-page .state-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--o-accent-soft);
  border: 1px solid var(--o-accent-line);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--o-accent-2);
}

.orders-page .state-card h3 {
  font-family: var(--mb-font-head, Manrope, sans-serif);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -.2px;
  color: var(--o-ink);
  margin: 0;
}

.orders-page .state-card p {
  margin: 0;
  color: var(--o-muted);
  font-size: 14px;
  line-height: 1.55;
  max-width: 40ch;
}

.orders-page .loading {
  padding: 24px;
  border: 1px dashed var(--o-line);
  border-radius: var(--o-radius);
  background: rgba(255, 255, 255, .7);
  color: var(--o-muted);
  text-align: center;
  font-size: 14.5px;
  margin: 0;
}

.orders-page .alert {
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.45;
  margin-bottom: 14px;
}

.orders-page .alert.error {
  background: var(--o-danger-soft);
  border: 1px solid var(--o-danger-line);
  color: var(--o-danger);
}

/* ── Responsive: tablet ─────────────────────────────────── */

@media (max-width: 720px) {
  .orders-page .container-narrow { padding: 24px 16px 56px; }

  .orders-page .page-header h1 { font-size: 24px; }

  .orders-page .stats-strip {
    grid-template-columns: repeat(2, 1fr);
  }

  .orders-page .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .orders-page .sd-tabs {
    display: flex;
    width: 100%;
    justify-content: space-between;
  }

  .orders-page .sd-tab {
    flex: 1 1 auto;
    text-align: center;
    padding: 8px 12px;
  }

  .orders-page .search {
    margin-left: 0;
    max-width: none;
    min-width: 0;
    flex: 0 0 auto;
  }

  .orders-page .order-card { padding: 18px; }

  .orders-page .order-actions { gap: 10px; }

  .orders-page .order-time { font-size: 12px; }

  .orders-page .btn-view {
    width: 100%;
    justify-content: center;
  }
}

/* ── Responsive: small phone ────────────────────────────── */

@media (max-width: 420px) {
  .orders-page .order-card .card-head-party {
    gap: 8px;
  }

  .orders-page .order-card .order-party-info {
    /* ✨ FIX: Increased from 110px to allow the seller name more room before wrapping/truncating */
    max-width: 140px; 
  }

  .orders-page .order-card .order-party-name {
    font-size: 12.5px;
  }

  .orders-page .order-avatar {
    width: 40px;
    height: 40px;
    font-size: 13px;
    border-radius: 11px;
  }

  .orders-page .order-title { font-size: 16px; }

  .orders-page .price-amount { font-size: 20px; }

  .orders-page .progress-label { display: none; }
  .orders-page .progress-step  { gap: 0; }
  .orders-page .order-progress { margin: 12px 0 0; }

  .orders-page .btn-view {
    height: 36px;
    font-size: 12.5px;
  }
}

/* ── Reduced motion ─────────────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  .orders-page .order-card,
  .orders-page .stat,
  .orders-page .sd-tab,
  .orders-page .btn-view,
  .orders-page .progress-dot {
    transition: none;
  }

  .orders-page .order-card:hover,
  .orders-page .stat:hover {
    transform: none;
  }

  .orders-page .btn-view:hover svg { transform: none; }
}
