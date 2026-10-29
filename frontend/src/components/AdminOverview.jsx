import React, { useMemo } from 'react';
import { movingFrom, pipelineFromCounts } from '../utils/dashboardOverview.js';
import './AdminOverview.css';

// Overview for the admin Control Center: KPI cards with sparklines, an order pipeline, a weekly activity chart and the
// queues that need a decision. Numbers come from data the page already loads; the order counts and the weekly figures
// come from /admin/operations/summary (ordersByStatus, week).

const money = (v) => `${Number(v || 0).toLocaleString()} ETB`;
const wholeMoney = (v) => `${Math.round(Number(v || 0)).toLocaleString()} ETB`;
const count = (v) => Number(v || 0).toLocaleString();
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });

// A smooth line through the values, scaled into a w×h box.
function smoothPath(values, w, h, pad = 3) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

function Sparkline({ values, tone = 'accent' }) {
  if (!values || values.length < 2) return <span className="aov-spark aov-spark--empty" aria-hidden="true" />;
  return (
    <svg className={`aov-spark aov-tone-${tone}`} viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true">
      <path d={smoothPath(values, 120, 36)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const ICONS = {
  volume: <path d="M4 17l5-5 4 3 7-8M15 7h5v5" />,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5M16 5.5a3 3 0 010 5.6M18 15c1.8.6 2.7 2.2 3 4" /></>,
  listings: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16M9 5v14" /></>,
  orders: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
};

function KpiIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function Kpi({ icon, label, value, chip, chipTone = 'neutral', spark, sparkTone }) {
  return (
    <article className="aov-kpi">
      <div className="aov-kpi-label"><KpiIcon name={icon} />{label}</div>
      <div className="aov-kpi-value">{value}</div>
      <div className={`aov-chip aov-chip--${chipTone}`}><span className="aov-chip-dot" aria-hidden="true" />{chip}</div>
      <Sparkline values={spark} tone={sparkTone} />
    </article>
  );
}

export default function AdminOverview({ overview, commission, operations, queues, onOpenTab }) {
  const stages = useMemo(() => pipelineFromCounts(operations?.ordersByStatus), [operations]);
  const moving = movingFrom(stages);
  const visible = stages.filter((s) => s.key !== 'disputed' || s.count > 0);
  const total = visible.reduce((sum, s) => sum + s.count, 0);
  const summary = visible.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ');

  const week = operations?.week;
  const days = week?.days || [];
  const weekOrders = days.reduce((sum, d) => sum + d.orders, 0);
  const weekPaid = days.reduce((sum, d) => sum + d.paidVolume, 0);
  const orderSeries = days.map((d) => d.orders);
  const paidSeries = days.map((d) => d.paidVolume);
  const peakDay = days.reduce((best, d) => (d.orders > (best?.orders ?? -1) ? d : best), null);
  const weekPeak = Math.max(1, ...orderSeries);

  const open = (queues || []).filter((q) => q.count > 0);
  const openTotal = open.reduce((sum, q) => sum + q.count, 0);

  return (
    <section className="aov" aria-label="Marketplace overview">
      <header className="aov-head">
        <div>
          <h2>Overview</h2>
          <p>Understand how the marketplace is moving, and what needs you.</p>
        </div>
        <span className="aov-pill">This week</span>
      </header>

      <div className="aov-kpis">
        <Kpi
          icon="volume"
          label="Paid volume"
          value={wholeMoney(overview?.totalPaidVolume)}
          chip={`Commission ${money(commission?.totalCommission)}`}
          chipTone="good"
          spark={paidSeries}
          sparkTone="good"
        />
        <Kpi
          icon="users"
          label="Users"
          value={count(overview?.users)}
          chip={`${count(overview?.suspendedUsers)} suspended`}
          chipTone={Number(overview?.suspendedUsers) > 0 ? 'bad' : 'neutral'}
        />
        <Kpi
          icon="listings"
          label="Listings"
          value={count(overview?.listings)}
          chip={`${count(overview?.activeAds)} active ad${Number(overview?.activeAds) === 1 ? '' : 's'}`}
        />
        <Kpi
          icon="orders"
          label="Orders"
          value={count(overview?.orders)}
          chip={`${moving} in progress`}
          chipTone="info"
          spark={orderSeries}
          sparkTone="info"
        />
      </div>

      <div className="aov-grid">
        <article className="aov-panel">
          <div className="aov-panel-head">
            <h3>Order pipeline</h3>
            <span className="aov-pill aov-pill--ghost">All orders</span>
          </div>
          {total === 0 ? (
            <p className="aov-empty">No orders yet.</p>
          ) : (
            <>
              <div className="aov-total">{count(total)}<span> orders tracked</span></div>
              <div className="aov-track" role="img" aria-label={`Order pipeline: ${summary}`}>
                {visible.filter((s) => s.count > 0).map((s) => (
                  <span key={s.key} className={`aov-seg aov-bg-${s.tone}`} style={{ flexGrow: s.count }} />
                ))}
              </div>
              <ul className="aov-legend">
                {visible.map((s) => (
                  <li key={s.key}>
                    <span className="aov-legend-label"><span className={`aov-dot aov-bg-${s.tone}`} aria-hidden="true" />{s.label}</span>
                    <strong>{s.count}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>

        <article className="aov-panel">
          <div className="aov-panel-head">
            <h3>This week</h3>
            <span className="aov-pill aov-pill--ghost">Mon – Sun</span>
          </div>
          {week ? (
            <>
              <dl className="aov-figures">
                <div><dt>New orders</dt><dd>{count(weekOrders)}</dd></div>
                <div><dt>Paid</dt><dd>{wholeMoney(weekPaid)}</dd></div>
                <div><dt>Busiest day</dt><dd>{peakDay && peakDay.orders > 0 ? dayLabel(peakDay.date) : '—'}</dd></div>
              </dl>
              <ol className="aov-bars" aria-label="New orders per day this week">
                {days.map((d) => (
                  <li key={d.date} className={d.date === week.today ? 'is-today' : ''} aria-current={d.date === week.today ? 'date' : undefined}>
                    <span className="aov-bar-val">{d.orders}</span>
                    <span className="aov-bar-track" aria-hidden="true">
                      <span className="aov-bar-fill" style={{ height: `${d.orders ? Math.max(8, (d.orders / weekPeak) * 100) : 3}%` }} />
                    </span>
                    <span className="aov-bar-day">{dayLabel(d.date)}</span>
                    <span className="aov-sr">{d.orders} new orders, {money(d.paidVolume)} paid</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="aov-empty">Weekly figures are not available yet.</p>
          )}
        </article>
      </div>

      <article className="aov-panel">
        <div className="aov-panel-head">
          <h3>Needs a decision</h3>
          {openTotal > 0 && <span className="aov-count">{openTotal}</span>}
        </div>
        {open.length === 0 ? (
          <p className="aov-empty">All queues are clear.</p>
        ) : (
          <ul className="aov-queues">
            {open.map((q) => (
              <li key={q.key}>
                <button type="button" className={`aov-queue aov-tone-${q.tone}`} onClick={() => onOpenTab(q.tab)}>
                  <span className="aov-queue-dot" aria-hidden="true" />
                  <span className="aov-queue-text">{q.label}</span>
                  <span className="aov-queue-count">{q.count}</span>
                  <span className="aov-queue-arrow" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}
