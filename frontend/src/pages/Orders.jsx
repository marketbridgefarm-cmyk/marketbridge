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

// Maps backend order status strings to tone variants.
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

/*
 * Marketplace payment status, reduced to a single label.
 * PAID wins over PENDING, which wins over FAILED — mirrors OrderDetail.jsx.
 */
function summarizePayments(payments, type) {
  const rows = (payments || []).filter((payment) => payment.type === type);
  if (rows.length === 0) return null;
  if (rows.some((payment) => payment.status === 'PAID')) return 'PAID';
  if (rows.some((payment) => payment.status === 'PENDING')) return 'PENDING';
  if (rows.some((payment) => payment.status === 'RECONCILIATION_REQUIRED')) return 'RECONCILIATION_REQUIRED';
  if (rows.some((payment) => payment.status === 'FAILED')) return 'FAILED';
  return rows[0].status;
}

/*
 * Derive the four-step progress timeline from an order's state:
 *   Order placed → Payment → Transport → Delivered
 * Cancelled/disputed orders reset to step 1.
 */
function progressFor(order) {
  const steps = ['Order placed', 'Payment', 'Transport', 'Delivered'];
  const status = String(order.status || '').toUpperCase();

  const paid = order.paymentSummary === 'PAID' || summarizePayments(order.payments, 'MARKETPLACE') === 'PAID';
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
    payments: order.payments,
  });

  const createdLabel = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString()
    : null;

  return (
    <article className="order-card">
      <header className="order-head">
        <div className={`order-avatar tone-${avatarTone}`} aria-hidden="true">
          {initialsOf(counterparty?.name)}
        </div>

        <div className="order-headings">
          <div className="order-overline">
            <span className={`role-chip ${isBuyer ? '' : 'is-selling'}`}>
              {isBuyer ? 'Buying' : 'Selling'}
            </span>
            <span className="order-id">ORD {shortId(order.id)}</span>
          </div>
          <h3 className="order-title" title={title}>{title}</h3>
          <p className="order-party">
            {counterparty?.name || 'Unknown party'}
            {createdLabel && (
              <>
                <span className="dot" aria-hidden="true" />
                <span>{createdLabel}</span>
              </>
            )}
          </p>
        </div>

        <div className="order-price">
          <span className="price-amount">{money(order.finalPrice)}</span>
          <span className="price-currency">ETB</span>
        </div>
      </header>

      <div className="badges">
        <span className={`status-pill tone-${statusTone(order.status)}`}>
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
      </div>

      <div className="order-progress" aria-label="Order progress">
        {steps.map((step) => (
          <div key={step.label} className={`progress-step ${step.cls}`}>
            <span className="progress-dot" aria-hidden="true" />
            <span className="progress-label">{step.label}</span>
          </div>
        ))}
      </div>

      <footer className="order-actions">
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
      </footer>
    </article>
  );
}

export default function Orders() {
  const { user } = useAuth();
  const currentUserId = user?.id || user?.userId || user?._id || null;

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
        return title.includes(q) || buyer.includes(q) || seller.includes(q) || id.includes(q);
      });
    }

    return rows;
  }, [orders, tab, query, currentUserId]);

  return (
    <main className="section orders-page">
      <div className="container-narrow">
        <div className="page-header">
          <span className="eyebrow">ORDERS</span>
          <h1>Your orders</h1>
          <p>
            Every accepted offer or purchase becomes an order. Open one to continue with payment,
            transport, inspection and delivery.
          </p>
        </div>

        {!loading && !error && orders.length > 0 && (
          <div className="stats-strip">
            <div className="stat tone-accent">
              <span className="stat-label">Total</span>
              <span className="stat-value">{stats.total}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Buying</span>
              <span className="stat-value">{stats.buying}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Selling</span>
              <span className="stat-value">{stats.selling}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Completed</span>
              <span className="stat-value">{stats.completed}</span>
            </div>
          </div>
        )}

        {error && <div className="alert error">{error}</div>}

        {!loading && !error && orders.length > 0 && (
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
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
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

        {loading ? (
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
            <p>We couldn't reach the orders service. Refresh the page or try again in a moment.</p>
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
