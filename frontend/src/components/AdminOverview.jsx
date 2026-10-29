import React, { useMemo } from 'react';
import { movingFrom, pipelineFromCounts } from '../utils/dashboardOverview.js';
import './DashboardOverview.css';
import './AdminOverview.css';

// Overview for the admin Control Center: money, users, the order pipeline, this week's activity and the queues that
// need a decision. Numbers come from data the page already loads; the order counts and the weekly figures come from
// /admin/operations/summary (ordersByStatus, week).

const money = (v) => `${Number(v || 0).toLocaleString()} ETB`;
const wholeMoney = (v) => `${Math.round(Number(v || 0)).toLocaleString()} ETB`;      // big numbers: no cents, so they never wrap
const count = (v) => Number(v || 0).toLocaleString();
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
const dayNumber = (iso) => Number(String(iso).slice(8, 10));

export default function AdminOverview({ overview, commission, operations, queues, onOpenTab }) {
  const stages = useMemo(() => pipelineFromCounts(operations?.ordersByStatus), [operations]);
  const moving = movingFrom(stages);
  const visible = stages.filter((s) => s.key !== 'disputed' || s.count > 0);
  const total = visible.reduce((sum, s) => sum + s.count, 0);
  const summary = visible.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ');
  const peak = Math.max(1, ...stages.map((s) => s.count));

  const week = operations?.week;
  const weekOrders = (week?.days || []).reduce((sum, d) => sum + d.orders, 0);
  const weekPaid = (week?.days || []).reduce((sum, d) => sum + d.paidVolume, 0);
  const weekPeak = Math.max(1, ...(week?.days || []).map((d) => d.orders));

  const open = (queues || []).filter((q) => q.count > 0);
  const openTotal = open.reduce((sum, q) => sum + q.count, 0);

  return (
    <section className="dash-overview dash-overview--admin" aria-label="Marketplace overview">
      <div className="dov-main">
        <div className="dov-stats">
          <article className="dov-card dov-stat is-accent">
            <span className="dov-label">Paid volume</span>
            <span className="dov-big">{wholeMoney(overview?.totalPaidVolume)}</span>
            <span className="dov-note">Commission {money(commission?.totalCommission)}</span>
          </article>
          <article className="dov-card dov-stat">
            <span className="dov-label">Users</span>
            <span className="dov-big">{count(overview?.users)}</span>
            <span className="dov-note">{count(overview?.suspendedUsers)} suspended</span>
          </article>
          <article className="dov-card dov-stat">
            <span className="dov-label">Listings</span>
            <span className="dov-big">{count(overview?.listings)}</span>
            <span className="dov-note">{count(overview?.activeAds)} active ad{Number(overview?.activeAds) === 1 ? '' : 's'}</span>
          </article>
          <article className="dov-card dov-stat">
            <span className="dov-label">Orders</span>
            <span className="dov-big">{count(overview?.orders)}</span>
            <span className="dov-note">{moving} in progress</span>
            <span className="dov-bars" aria-hidden="true">
              {stages.slice(0, 4).map((s) => (
                <span key={s.key} className={`dov-bar dov-tone-${s.tone}`} style={{ height: `${Math.max(12, (s.count / peak) * 100)}%` }} />
              ))}
            </span>
          </article>
        </div>

        <article className="dov-card">
          <div className="dov-head"><h2>Order pipeline</h2><span className="dov-note">All orders on the marketplace</span></div>
          {total === 0 ? (
            <p className="dov-empty">No orders yet.</p>
          ) : (
            <>
              <div className="dov-track" role="img" aria-label={`Order pipeline: ${summary}`}>
                {visible.filter((s) => s.count > 0).map((s) => (
                  <span key={s.key} className={`dov-seg dov-tone-${s.tone}`} style={{ flexGrow: s.count }} />
                ))}
              </div>
              <ul className="dov-legend">
                {visible.map((s) => (
                  <li key={s.key}>
                    <span className="dov-count">{s.count}</span>
                    <span className="dov-legend-label"><span className={`dov-dot dov-tone-${s.tone}`} aria-hidden="true" />{s.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      </div>

      <aside className="dov-side">
        <article className="dov-card">
          <div className="dov-head"><h2>This week</h2></div>
          {week ? (
            <>
              <ol className="dov-weekbars" aria-label="New orders per day this week">
                {week.days.map((d) => (
                  <li key={d.date} className={d.date === week.today ? 'is-today' : ''} aria-current={d.date === week.today ? 'date' : undefined}>
                    <span className="dov-wb-track" aria-hidden="true"><span className="dov-wb-fill" style={{ height: `${d.orders ? Math.max(8, (d.orders / weekPeak) * 100) : 3}%` }} /></span>
                    <span className="dov-wd">{dayLabel(d.date)}</span>
                    <span className="dov-day">{dayNumber(d.date)}</span>
                    <span className="dov-sr">{d.orders} new orders, {money(d.paidVolume)} paid</span>
                  </li>
                ))}
              </ol>
              <p className="dov-note dov-weeksum">{weekOrders} new order{weekOrders === 1 ? '' : 's'} · {money(weekPaid)} paid</p>
            </>
          ) : (
            <p className="dov-empty">Weekly figures are not available yet.</p>
          )}
        </article>

        <article className="dov-card">
          <div className="dov-head">
            <h2>Needs a decision</h2>
            {openTotal > 0 && <span className="dov-badge">{openTotal}</span>}
          </div>
          {open.length === 0 ? (
            <p className="dov-empty">All queues are clear.</p>
          ) : (
            <ul className="dov-list">
              {open.map((q) => (
                <li key={q.key}>
                  <button type="button" className={`dov-item dov-item--row dov-tone-${q.tone}`} onClick={() => onOpenTab(q.tab)}>
                    <span className="dov-item-text">{q.label}</span>
                    <span className="dov-pill">{q.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
      </aside>
    </section>
  );
}
