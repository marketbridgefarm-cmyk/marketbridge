import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const shortId = (id) => id?.slice(0, 8) || '—';

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

const TABS = [
  { id: 'all', label: 'All orders' },
  { id: 'buying', label: 'Buying' },
  { id: 'selling', label: 'Selling' },
];

/*
 * Marketplace payment status, reduced to a single label.
 *
 * A buyer can retry a failed/pending payment, so PAID wins over PENDING,
 * which wins over FAILED — mirrors the precedence OrderDetail.jsx uses.
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

function OrderRow({ order, currentUserId }) {
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

  return (
    <div className="card order-card">
      <div>
        <span className="role-chip">{isBuyer ? 'BUYING' : 'SELLING'}</span>

        <h3>{title}</h3>

        <p>
          ORDER {shortId(order.id)} · {counterparty?.name || 'Unknown party'} · {money(order.finalPrice)} ETB
        </p>

        <p>
          <span className="badge">{order.status}</span>
          {openDispute && <span className="badge"> DISPUTED</span>}
          {marketplaceStatus && <span className="badge"> Payment: {marketplaceStatus}</span>}
          {transportJob && (
            <span className="badge"> Transport: {transportStatus ? `${transportJob.status} · ${transportStatus}` : transportJob.status}</span>
          )}
        </p>
      </div>

      <Link className="btn btn-primary" to={`/orders/${order.id}`}>
        View order
      </Link>
    </div>
  );
}

export default function Orders() {
  const { user } = useAuth();
  const currentUserId = user?.id || user?.userId || user?._id || null;

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');

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

  const filtered = useMemo(() => {
    if (tab === 'buying') {
      return orders.filter((order) => order.buyerId === currentUserId);
    }
    if (tab === 'selling') {
      return orders.filter((order) => order.sellerId === currentUserId);
    }
    return orders;
  }, [orders, tab, currentUserId]);

  return (
    <main className="section">
      <div className="container-narrow">
        <div className="page-header">
          <div>
            <span className="eyebrow">ORDERS</span>
            <h1>Your orders</h1>
            <p>
              Every accepted offer or purchase becomes an order. Open one to continue with payment,
              transport, inspection and delivery.
            </p>
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}

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

        {loading ? (
          <p>Loading orders…</p>
        ) : filtered.length === 0 ? (
          <div className="card notice">
            No orders here yet. {tab === 'buying' ? 'Purchases and accepted offers' : tab === 'selling' ? 'Your sold listings' : 'Accepted offers and purchases'} will appear on this page.
          </div>
        ) : (
          <div>
            {filtered.map((order) => (
              <OrderRow key={order.id} order={order} currentUserId={currentUserId} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
