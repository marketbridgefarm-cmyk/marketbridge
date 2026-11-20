import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { activityChange, attentionItems, dailyActivity, inProgressCount, liveOrders, orderProgress, pipelineCounts, upcomingDues, weekDays } from '../utils/dashboardOverview.js';
import useMediaQuery from './useMediaQuery.js';
import './DashboardOverview.css';

// Overview cards at the top of the dashboard: key numbers, the order pipeline, this week's payment deadlines and what
// needs the user's attention. Everything is computed from data the dashboard already loaded.

const money = (v) => `${Number(v || 0).toLocaleString()} ETB`;
const fmtDue = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Dot-matrix bar chart: one column per day, one dot per order created that day (max 8 shown).
const MAX_DOTS = 8;
function DotChart({ dots }) {
  const big = dots.length <= 14;
  const col = big ? 36 : 18, r = big ? 9 : 5, step = big ? 20 : 12, h = step * MAX_DOTS + 8, w = dots.length * col;
  const total = dots.reduce((sum, d) => sum + d.count, 0);
  return (
    <div className="dov-chart-wrap">
      <svg className="dov-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMinYMax meet" role="img"
           aria-label={`Orders created per day over the last ${dots.length} days: ${total} in total`}>
        {dots.map((d, i) => {
          const cx = i * col + col / 2;
          const n = Math.min(d.count, MAX_DOTS);
          return (
            <g key={d.key} className={d.isToday ? 'is-today' : ''}>
              <title>{`${d.count} order${d.count === 1 ? '' : 's'} on day ${d.day}`}</title>
              <circle className="dov-base" cx={cx} cy={h - 6} r={2.4} />
              {Array.from({ length: n }, (_, k) => <circle key={k} className="dov-pt" cx={cx} cy={h - 6 - step * (k + 1)} r={r} />)}
            </g>
          );
        })}
      </svg>
      {total === 0 && <p className="dov-chart-empty">Your order activity will appear here.</p>}
    </div>
  );
}

export default function DashboardOverview({ mode, orders, myTurnOffers, listingLabel, stats }) {
  const now = useMemo(() => new Date(), []);
  const stages = useMemo(() => pipelineCounts(orders), [orders]);
  const moving = useMemo(() => inProgressCount(orders), [orders]);
  const week = useMemo(() => weekDays(now, orders), [now, orders]);
  const dues = useMemo(() => upcomingDues(orders, now, 3), [orders, now]);
  const attention = useMemo(() => attentionItems({ orders, myTurnOffers, listingLabel, money }), [orders, myTurnOffers, listingLabel]);

  const narrow = useMediaQuery('(max-width: 520px)');
  const span = narrow ? 14 : 30;   // fewer, larger dots on phones so the chart stays readable
  const dots = useMemo(() => dailyActivity(orders, now, span), [orders, now, span]);
  const change = useMemo(() => activityChange(orders, now, 7), [orders, now]);
  const rows = useMemo(() => liveOrders(orders, 5), [orders]);

  const visible = stages.filter((s) => s.key !== 'disputed' || s.count > 0);
  const total = visible.reduce((sum, s) => sum + s.count, 0);
  const summary = visible.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ');

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
        <article className="dov-card dov-hero">
          <div className="dov-hero-top">
            <div>
              <span className="dov-label">Orders in progress</span>
              <span className="dov-hero-num">{moving}</span>
              <span className="dov-hero-sub">
                {change.recent} new order{change.recent === 1 ? '' : 's'} in the last 7 days
                {change.percent !== null && (
                  <span className={`dov-delta ${change.percent >= 0 ? 'is-up' : 'is-down'}`}>
                    {change.percent >= 0 ? '+' : ''}{change.percent}% vs previous week
                  </span>
                )}
              </span>
            </div>
            <div className="dov-hero-legend" aria-hidden="true"><span><i className="dov-dot dov-tone-accent" />Today</span><span><i className="dov-dot dov-dot-ink" />Orders created</span></div>
          </div>
          <DotChart dots={dots} />
          <div className="dov-hero-foot">
            {attention.total > 0 ? (
              <span className="dov-foot-alert"><b>{attention.total}</b> thing{attention.total === 1 ? '' : 's'} need{attention.total === 1 ? 's' : ''} you today</span>
            ) : (
              <span className="dov-foot-ok">All caught up — nothing is waiting on you.</span>
            )}
            <Link className="dov-link" to="/orders">Open all orders</Link>
          </div>
        </article>

        <div className="dov-stats">
          {cards.map((c) => (
            <article key={c.label} className={`dov-card dov-stat${c.tone ? ` is-${c.tone}` : ''}`}>
              <span className="dov-label">{c.label}</span>
              <span className="dov-big">{c.value}</span>
              <span className="dov-note">{c.note}</span>
            </article>
          ))}
        </div>

        <article className="dov-card">
          <div className="dov-head">
            <h2>Your orders</h2>
            <Link className="dov-link" to="/orders">View all</Link>
          </div>
          {rows.length === 0 ? (
            <p className="dov-empty">No orders yet. <Link to="/listings">Browse listings</Link> to start your first deal.</p>
          ) : (
            <ul className="dov-orders">
              {rows.map((o) => {
                const prog = orderProgress(o);
                return (
                  <li key={o.id}>
                    <Link to={`/orders/${o.id}`} className="dov-order">
                      <span className="dov-order-main">
                        <span className="dov-order-title">{listingLabel(o.listing)}</span>
                        <span className="dov-order-meta">{o.viewerRole === 'BUYER' ? 'You are buying' : 'You are selling'}{o.finalPrice ? ` · ${money(o.finalPrice)}` : ''}</span>
                      </span>
                      {prog && (
                        <>
                          <span className="dov-steps" role="img" aria-label={`Step ${prog.step} of ${prog.total}`}>
                            {Array.from({ length: prog.total }, (_, i) => (
                              <i key={i} className={i < prog.step ? `is-on dov-tone-${prog.tone}` : ''} />
                            ))}
                          </span>
                          <span className={`dov-pill dov-pill-${prog.tone}`}>{prog.label}</span>
                        </>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

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
                  <Link to={it.href} className={`dov-item dov-tone-${it.tone}`}>
                    <span className="dov-item-text">{it.text}</span>
                    {it.cta && <span className="dov-cta">{it.cta}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </article>
      </aside>
    </section>
  );
}
