import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import './orders/Orders.css';

const shortId = (id) => (id || '').slice(0, 8).toUpperCase() || '—';

const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const getError = (error, fallback) =>
  error?.response?.data?.error ||
  error?.response?.data?.message ||
  error?.message ||
  fallback;

function initialsOf(name) {
  if (!name) return '??';
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

/*
 * Best-effort location extractor. Tries the listing first (that's where
 * the produce is), then falls back to the counterparty. Handles both
 * `location: "Adama"` and `location: { city, region }` shapes.
 */
function locationOf(order) {
  const listing = order?.listing || {};
  const seller = order?.seller || {};
  const buyer = order?.buyer || {};

  const fromListing = readLocation(listing);
  if (fromListing) return fromListing;

  const fromSeller = readLocation(seller);
  if (fromSeller) return fromSeller;

  const fromBuyer = readLocation(buyer);
  if (fromBuyer) return fromBuyer;

  return null;
}

function readLocation(source) {
  if (!source) return null;

  const loc = source.location;

  // `location` as a plain string — "Adama, Oromia"
  if (typeof loc === 'string' && loc.trim()) return loc.trim();

  // `location` as an object — { city, region, country }
  if (loc && typeof loc === 'object') {
    const joined = [loc.city || loc.town, loc.region || loc.state, loc.country]
      .filter(Boolean)
      .join(', ');
    if (joined) return joined;
  }

  // Flat fields directly on the listing / party object
  const parts = [
    source.city || source.town,
    source.woreda || source.district || source.zone,
    source.region || source.state,
  ].filter(Boolean);

  if (parts.length) return parts.join(', ');

  return source.address || null;
}

function statusTone(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'CONFIRMED', 'PAID'].includes(s)) return 'success';
  if (['IN_TRANSIT', 'TRANSPORT_ARRANGED', 'TRANSPORT_PAID'].includes(s)) return 'info';
  if (['CANCELLED', 'DISPUTED', 'FROZEN'].includes(s)) return 'danger';
  if (
    [
      'PENDING_PAYMENT',
      'PENDING',
      'AWAITING_INSPECTION',
      'INSPECTION_PENDING',
      'FAILED',
      'RECONCILIATION_REQUIRED',
    ].includes(s)
  ) {
    return 'gold';
  }
  return 'muted';
}

const TABS = [
  { id: 'all', label: 'All orders' },
  { id: 'buying', label: 'Buying' },
  { id: 'selling', label: 'Selling' },
];

function summarizePayments(payments, type) {
  const rows = (payments || []).filter((payment) => payment.type === type);
  if (rows.length === 0) return null;
  if (rows.some((payment) => payment.status === 'PAID')) return 'PAID';
  if (rows.some((payment) => payment.status === 'PENDING')) return 'PENDING';
  if (rows.some((payment) => payment.status === 'RECONCILIATION_REQUIRED')) return 'RECONCILIATION_REQUIRED';
  if (rows.some((payment) => payment.status === 'FAILED')) return 'FAILED';
  return rows[0].status;
}

function progressFor(order) {
  const steps = ['Order placed', 'Payment', 'Transport', 'Delivered'];
  const status = String(order.status || '').toUpperCase();

  const paid = order.paymentSummary === 'PAID';
  const hasTransport = Boolean(order.transportJob);
  const transportOk = hasTransport && order.transportJob.status !== 'FAILED';
  const delivered = ['DELIVERED', 'COMPLETED'].includes(status);
  const isTerminal = ['CANCELLED', 'DISPUTED'].includes(status);

  let idx = 0;
  if (paid) idx = 1;
  if (transportOk) idx = 2;
  if (delivered) idx = 3;
  if (isTerminal) idx = 0;

  return steps.map((label, i) => {
    let cls = '';
    if (i < idx) cls = 'done';
    else if (i === idx) cls = delivered || isTerminal ? 'done' : 'current';
    return { label, cls };
  });
}

// ============================================================================
// BUYER-SAFE COORDINATION INDICATOR
// ----------------------------------------------------------------------------
// The seller <-> inspector site handoff is not buyer-visible in content.
// This derives a *status string only* from the newest non-cancelled
// inspection request. It never touches contact fields — the payload from
// GET /orders does not even contain them (see orders.js PATCH B1).
//
// Rules:
//   • No inspection request             → null (no chip rendered)
//   • Status below ACCEPTED             → null (coordination not yet open)
//   • ACCEPTED or later, neither shared → "Coordination in progress"
//   • Exactly one side shared           → "Coordination in progress"
//   • Both sides shared                 → "Site handoff complete"
//   • Handoff was superseded            → "Handoff released"
// ============================================================================
function coordinationChipFor(order) {
  const requests = Array.isArray(order?.inspectionRequests)
    ? order.inspectionRequests.filter((r) => r && r.status !== 'CANCELLED')
    : [];
  if (requests.length === 0) return null;

  // Newest request is the canonical one (matches orderWorkflowService.js).
  const sorted = [...requests].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
  const current = sorted[0];

  const status = String(current.status || '').toUpperCase();
  if (!['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(status)) return null;

  const summary = current.coordinationStatus;
  if (!summary) return null;

  if (summary.supersededAt) {
    return { tone: 'muted', text: 'Handoff released' };
  }
  if (summary.sellerSubmitted && summary.inspectorSubmitted) {
    return { tone: 'success', text: 'Site handoff complete' };
  }
  return { tone: 'gold', text: 'Coordination in progress' };
}

const STAT_TONES = {
  accent:  { ring: '#1e9e5a', ink: '#0f7a44' },
  info:    { ring: '#1e5fa8', ink: '#1e5fa8' },
  gold:    { ring: '#a86f10', ink: '#a86f10' },
  success: { ring: '#0f7a44', ink: '#0f7a44' },
};

function StatCard({ label, value, total, tone = 'accent' }) {
  const pct = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;

  const R = 16;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - pct);
  const colors = STAT_TONES[tone] || STAT_TONES.accent;

  return (
    <div
      className={`stat tone-${tone}`}
      aria-label={`${label}: ${value}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 16px',
        border: '1px solid #e5e9ef',
        borderRadius: 14,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(15, 30, 45, .05)',
      }}
    >
      <span
        className="stat-label"
        style={{
          fontFamily: "'DM Sans', system-ui, sans-serif",
          fontSize: 10.5,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          color: '#64748b',
        }}
      >
        {label}
      </span>

      <div
        className="stat-graphic"
        style={{
          position: 'relative',
          width: 44,
          height: 44,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 40 40"
          width="44"
          height="44"
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        >
          <circle cx="20" cy="20" r={R} fill="none" stroke="#e5e9ef" strokeWidth="4" />
          <circle
            cx="20"
            cy="20"
            r={R}
            fill="none"
            stroke={colors.ring}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
            transform="rotate(-90 20 20)"
          />
        </svg>

        <span
          className="stat-count"
          style={{
            position: 'relative',
            zIndex: 1,
            fontFamily: "'Manrope', system-ui, sans-serif",
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: '-.4px',
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            color: colors.ink,
          }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function OrderCard({ order, currentUserId }) {
  const isBuyer = currentUserId === order.buyerId;
  const counterparty = isBuyer ? order.seller : order.buyer;
  const title = order.listing?.title || order.listing?.cropType || 'Order';

  const transportJob = order.transportJob || null;
  const marketplaceStatus = summarizePayments(order.payments, 'MARKETPLACE');
  const transportStatus =
    transportJob?.method === 'HIRE_TRANSPORTER'
      ? summarizePayments(order.payments, 'TRANSPORT')
      : null;

  const openDispute = (order.disputes || []).some(
    (dispute) => dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW'
  );

  const tone = statusTone(order.status);
  const avatarTone = openDispute ? 'danger' : tone;

  const steps = progressFor({
    status: order.status,
    transportJob,
    paymentSummary: marketplaceStatus,
  });

  const locationLabel = locationOf(order);
  const createdLabel = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString()
    : null;

  // Buyer-safe coordination chip. Renders only when coordination is actually
  // open on this order. Never exposes names, phones, emails, or times.
  const coordinationChip = coordinationChipFor(order);

  return (
    <article className="order-card">
      <div className="order-card-head">
        <div className="order-card-head-text">
          <span className={`eyebrow ${isBuyer ? '' : 'is-selling'}`}>
            {isBuyer ? 'Buying' : 'Selling'}
          </span>
          <h2 className="order-title" title={title}>{title}</h2>

          {locationLabel && (
            <p className="order-date" title={locationLabel}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ verticalAlign: '-1px', marginRight: 4 }}
              >
                <path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" />
                <circle cx="12" cy="10" r="2.6" />
              </svg>
              {locationLabel}
            </p>
          )}
        </div>

        <div className="order-card-head-party">
          <div className="order-party-info">
            <span className="order-party-role">
              {isBuyer ? 'Seller' : 'Buyer'}
            </span>
            <span className="order-party-name">
              {counterparty?.name || 'Unknown party'}
            </span>
          </div>

          <div className={`order-avatar tone-${avatarTone}`} aria-hidden="true">
            {initialsOf(counterparty?.name)}
          </div>
        </div>
      </div>

      <div className="card-body">
        <section className="card-block">
          <div className="card-block-title">
            <h3>Order status</h3>
            <span className="card-block-note">ORD {shortId(order.id)}</span>
          </div>

          <div className="card-block-body">
            <div className="badges">
              <span className={`status-pill tone-${tone}`}>
                <span className="status-pill-dot" aria-hidden="true" />
                {String(order.status || '').replace(/_/g, ' ')}
              </span>

              {openDispute && (
                <span className="status-pill tone-danger">
                  <span className="status-pill-dot" aria-hidden="true" />
                  Disputed
                </span>
              )}

              {marketplaceStatus && (
                <span className={`status-pill tone-${statusTone(marketplaceStatus)}`}>
                  Payment: {marketplaceStatus}
                </span>
              )}

              {transportJob && (
                <span className={`status-pill tone-${statusTone(transportJob.status)}`}>
                  Transport: {transportJob.status}
                  {transportStatus ? ` · ${transportStatus}` : ''}
                </span>
              )}

              {/* ★ Buyer-safe coordination status. Renders only when the
                  inspection is ACCEPTED or later and coordination is actually
                  open. Content (names, phones, sites, times) is never exposed
                  on this list view. */}
              {coordinationChip && (
                <span className={`status-pill tone-${coordinationChip.tone}`}>
                  <span className="status-pill-dot" aria-hidden="true" />
                  {coordinationChip.text}
                </span>
              )}
            </div>

            <div className="order-progress" role="list" aria-label="Order progress">
              {steps.map((step) => (
                <div
                  key={step.label}
                  role="listitem"
                  className={['progress-step', step.cls].filter(Boolean).join(' ')}
                >
                  <span className="progress-dot" aria-hidden="true" />
                  <span className="progress-label">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card-block">
          <div className="card-block-title">
            <h3>Amount</h3>
          </div>
          <div className="card-block-body">
            <div className="order-price">
              <span className="price-amount">{money(order.finalPrice)}</span>
              <span className="price-currency">ETB</span>
            </div>
          </div>
        </section>

        <div className="order-actions">
          <span className="order-time">
            {createdLabel ? `Created ${createdLabel}` : 'Recently updated'}
          </span>
          <Link className="btn-view" to={`/orders/${order.id}`}>
            View order
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
      </div>
    </article>
  );
}

export default function Orders() {
  const { user } = useAuth();
  const currentUserId = user?.id || user?.userId || user?._id || null;
  const authReady = Boolean(currentUserId);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setError('');

      try {
        const response = await api.get('/orders');
        if (alive) setOrders(response.data?.orders || []);
      } catch (err) {
        if (alive) setError(getError(err, 'Could not load orders'));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const stats = useMemo(() => {
    const total = orders.length;
    const buying = orders.filter((o) => o.buyerId === currentUserId).length;
    const selling = orders.filter((o) => o.sellerId === currentUserId).length;
    const completed = orders.filter((o) =>
      ['DELIVERED', 'COMPLETED'].includes(String(o.status || '').toUpperCase())
    ).length;
    return { total, buying, selling, completed };
  }, [orders, currentUserId]);

  const filtered = useMemo(() => {
    let rows = orders;

    if (tab === 'buying') {
      rows = rows.filter((order) => order.buyerId === currentUserId);
    } else if (tab === 'selling') {
      rows = rows.filter((order) => order.sellerId === currentUserId);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((order) => {
        const title = (order.listing?.title || order.listing?.cropType || '').toLowerCase();
        const buyer = (order.buyer?.name || '').toLowerCase();
        const seller = (order.seller?.name || '').toLowerCase();
        const id = String(order.id || '').toLowerCase();
        const loc = (locationOf(order) || '').toLowerCase();
        return (
          title.includes(q) ||
          buyer.includes(q) ||
          seller.includes(q) ||
          id.includes(q) ||
          loc.includes(q)
        );
      });
    }

    return rows;
  }, [orders, tab, query, currentUserId]);

  return (
    <main className="section orders-page">
      <div className="container-narrow">
        <div className="orders-hero">
          <span className="orders-hero-eyebrow">ORDERS</span>
          <h1 className="orders-hero-title">Your orders</h1>
          <p className="orders-hero-text">
            Every accepted offer or purchase becomes an order. Open one to continue with payment,
            transport, inspection and delivery.
          </p>
        </div>

        {!loading && !error && orders.length > 0 && authReady && (
          <div className="stats-strip">
            <StatCard label="Total"     value={stats.total}     total={stats.total} tone="accent"  />
            <StatCard label="Buying"    value={stats.buying}    total={stats.total} tone="info"    />
            <StatCard label="Selling"   value={stats.selling}   total={stats.total} tone="gold"    />
            <StatCard label="Completed" value={stats.completed} total={stats.total} tone="success" />
          </div>
        )}

        {!loading && !error && orders.length > 0 && authReady && (
          <div className="toolbar">
            <div className="sd-tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`sd-tab ${tab === t.id ? 'sd-active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <label className="search">
              <span className="search-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search orders…"
                aria-label="Search orders"
              />
            </label>
          </div>
        )}

        {loading || !authReady ? (
          <p className="loading">Loading orders…</p>
        ) : error ? (
          <div className="state-card">
            <div className="state-icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <circle cx="12" cy="12" r="10" />
              </svg>
            </div>
            <h3>Nothing to show</h3>
            <p>{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="state-card">
            <div className="state-icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7l9-4 9 4-9 4-9-4z" />
                <path d="M3 7v10l9 4 9-4V7" />
                <path d="M12 11v10" />
              </svg>
            </div>
            <h3>{orders.length === 0 ? 'No orders here yet' : 'No orders in this view'}</h3>
            <p>
              {orders.length === 0
                ? 'Once an offer is accepted or a purchase is completed, it will appear on this page ready for payment, transport, inspection and delivery.'
                : 'Try a different tab or clear the search to see more results.'}
            </p>
          </div>
        ) : (
          <div className="order-list">
            {filtered.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                currentUserId={currentUserId}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
