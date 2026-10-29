import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { attentionItems, inProgressCount, pipelineCounts, upcomingDues, weekDays } from '../utils/dashboardOverview.js';
import './DashboardOverview.css';

// Overview cards at the top of the dashboard: key numbers, the order pipeline, this week's payment deadlines and what
// needs the user's attention. Everything is computed from data the dashboard already loaded.

const money = (v) => `${Number(v || 0).toLocaleString()} ETB`;
const fmtDue = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function DashboardOverview({ mode, orders, myTurnOffers, listingLabel, stats }) {
  const now = useMemo(() => new Date(), []);
  const stages = useMemo(() => pipelineCounts(orders), [orders]);
  const moving = useMemo(() => inProgressCount(orders), [orders]);
  const week = useMemo(() => weekDays(now, orders), [now, orders]);
  const dues = useMemo(() => upcomingDues(orders, now, 3), [orders, now]);
  const attention = useMemo(() => attentionItems({ orders, myTurnOffers, listingLabel, money }), [orders, myTurnOffers, listingLabel]);

  const visible = stages.filter((s) => s.key !== 'disputed' || s.count > 0);
  const total = visible.reduce((sum, s) => sum + s.count, 0);
  const summary = visible.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ');
  const peak = Math.max(1, ...stages.map((s) => s.count));

  const cards = mode === 'seller'
    ? [
        { label: 'Confirmed sales', value: money(stats.grossSales), note: `${stats.confirmedCount} confirmed order${stats.confirmedCount === 1 ? '' : 's'}`, tone: 'accent' },
        { label: 'Active listings', value: stats.activeListings, note: `${stats.listingCount} listing${stats.listingCount === 1 ? '' : 's'} in total` },
      ]
    : [
        { label: 'Offers sent', value: stats.offersSent, note: 'Waiting for sellers', tone: 'accent' },
        { label: 'Orders as buyer', value: stats.buyerOrders, note: 'All time' },
      ];

  return (
    <section className="dash-overview" aria-label="Overview">
      <div className="dov-main">
        <div className="dov-stats">
          {cards.map((c) => (
            <article key={c.label} className={`dov-card dov-stat${c.tone ? ` is-${c.tone}` : ''}`}>
              <span className="dov-label">{c.label}</span>
              <span className="dov-big">{c.value}</span>
              <span className="dov-note">{c.note}</span>
            </article>
          ))}
          <article className="dov-card dov-stat">
            <span className="dov-label">Orders in progress</span>
            <span className="dov-big">{moving}</span>
            <span className="dov-bars" aria-hidden="true">
              {stages.slice(0, 4).map((s) => (
                <span key={s.key} className={`dov-bar dov-tone-${s.tone}`} style={{ height: `${Math.max(12, (s.count / peak) * 100)}%` }} />
              ))}
            </span>
          </article>
        </div>

        <article className="dov-card">
          <div className="dov-head">
            <h2>Order pipeline</h2>
            <Link className="dov-link" to="/orders">All orders</Link>
          </div>
          {total === 0 ? (
            <p className="dov-empty">No orders yet. <Link to="/listings">Browse listings</Link> to start your first deal.</p>
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
          <div className="dov-head"><h2>{now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2></div>
          <ol className="dov-week" aria-label="This week">
            {week.map((d) => (
              <li key={d.key} className={`${d.isToday ? 'is-today' : ''}${d.hasDue ? ' has-due' : ''}`} aria-current={d.isToday ? 'date' : undefined}>
                <span className="dov-wd">{d.weekday}</span>
                <span className="dov-day">{d.day}</span>
                {d.hasDue && <span className="dov-due-dot" aria-label="Payment deadline" />}
              </li>
            ))}
          </ol>
          {dues.length === 0 ? (
            <p className="dov-empty">No payment deadlines coming up.</p>
          ) : (
            <ul className="dov-list">
              {dues.map((o) => (
                <li key={o.id}>
                  <Link to={`/orders/${o.id}`} className="dov-item">
                    <span className="dov-item-text">{o.viewerRole === 'BUYER' ? 'You pay' : 'Buyer pays'} for {listingLabel(o.listing)}</span>
                    <span className="dov-item-meta">by {fmtDue(o.paymentDueAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="dov-card">
          <div className="dov-head">
            <h2>Needs your attention</h2>
            {attention.total > 0 && <span className="dov-badge">{attention.total}</span>}
          </div>
          {attention.items.length === 0 ? (
            <p className="dov-empty">You are all caught up.</p>
          ) : (
            <ul className="dov-list">
              {attention.items.map((it) => (
                <li key={it.id}>
                  <Link to={it.href} className={`dov-item dov-tone-${it.tone}`}><span className="dov-item-text">{it.text}</span></Link>
                </li>
              ))}
            </ul>
          )}
        </article>
      </aside>
    </section>
  );
}
