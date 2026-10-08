import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import MessageThread from '../components/MessageThread.jsx';
import './dashboards/Dashboard.css';

// ============================================================================
// UNIFIED DASHBOARD
// ============================================================================

const TABS = [
  { id: 'buying', label: 'Buying' },
  { id: 'selling', label: 'Selling' },
  { id: 'listings', label: 'My Listings' },
  { id: 'offers', label: 'Offers' },
  { id: 'orders', label: 'Orders' },
  { id: 'messages', label: 'Messages' },
  { id: 'payments', label: 'Payments' },
  { id: 'earnings', label: 'Earnings' },
];

const ORDER_FILTERS = [
  { id: 'all', label: 'All orders' },
  { id: 'buying', label: 'Buying' },
  { id: 'selling', label: 'Selling' },
];

const ACTIVE_SALE_STATUSES = ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const money = (value) => `${Number(value || 0).toLocaleString()} ETB`;
const amountFmt = (value) =>
  Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const shortId = (id) => (id ? String(id).slice(0, 8).toUpperCase() : '—');
const pretty = (s) => String(s || '').replace(/_/g, ' ');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : null);

function listingLabel(listing) {
  return listing?.title || listing?.cropType || 'Listing';
}

function recordTag(text) {
  return String(text || '??').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '??';
}

function initialsOf(name, fallback) {
  const cleaned = String(name || '').trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return recordTag(fallback);
  return cleaned.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function statusTone(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'CONFIRMED', 'PAID', 'ACCEPTED', 'SELECTED'].includes(s)) return 'success';
  if (['IN_TRANSIT', 'TRANSPORT_ARRANGED', 'TRANSPORT_PAID'].includes(s)) return 'info';
  if (['CANCELLED', 'DISPUTED', 'FROZEN', 'REJECTED'].includes(s)) return 'danger';
  if (
    ['PENDING_PAYMENT', 'PENDING', 'AWAITING_INSPECTION', 'INSPECTION_PENDING', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED']
      .includes(s)
  ) return 'gold';
  return 'muted';
}

function summarizePayments(payments, type) {
  const rows = (payments || []).filter((p) => p.type === type);
  if (rows.length === 0) return null;
  if (rows.some((p) => p.status === 'PAID')) return 'PAID';
  if (rows.some((p) => p.status === 'PENDING')) return 'PENDING';
  if (rows.some((p) => p.status === 'RECONCILIATION_REQUIRED')) return 'RECONCILIATION_REQUIRED';
  if (rows.some((p) => p.status === 'FAILED')) return 'FAILED';
  return rows[0].status;
}

function progressFor(order, marketplaceStatus) {
  const steps = ['Order placed', 'Payment', 'Transport', 'Delivered'];
  const status = String(order.status || '').toUpperCase();

  const paid = marketplaceStatus === 'PAID';
  const transportOk = Boolean(order.transportJob) && order.transportJob.status !== 'FAILED';
  const delivered = ['DELIVERED', 'COMPLETED'].includes(status);
  const isTerminal = ['CANCELLED', 'DISPUTED'].includes(status);

  let idx = 0;
  if (paid) idx = 1;
  if (transportOk) idx = 2;
  if (delivered) idx = 3;
  if (isTerminal) idx = 0;

  return steps.map((name, i) => {
    let cls = '';
    if (i < idx) cls = 'done';
    else if (i === idx) cls = delivered || isTerminal ? 'done' : 'current';
    return { label: name, cls };
  });
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

function Pill({ tone, dot, children }) {
  return (
    <span className={`status-pill tone-${tone}`}>
      {dot && <span className="status-pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

function Progress({ steps }) {
  if (!steps) return null;
  return (
    <div className="order-progress" aria-label="Order progress">
      {steps.map((step) => (
        <div key={step.label} className={`progress-step ${step.cls}`}>
          <span className="progress-dot" aria-hidden="true" />
          <span className="progress-label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon = '📭', title, text }) {
  return (
    <div className="state-card">
      <div className="state-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div className={`stat${accent ? ' tone-accent' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function RecordCard({
  eyebrow, selling, title, date,
  partyRole, partyName, avatar, avatarTone,
  blockTitle, blockNote, badges, steps,
  amount, footer, stack, highlight,
}) {
  return (
    <article className={`order-card${highlight ? ' order-card--action' : ''}`}>
      <div className="order-card-head">
        <div className="order-card-head-text">
          <span className={`eyebrow${selling ? ' is-selling' : ''}`}>{eyebrow}</span>
          <h2 className="order-title" title={title}>{title}</h2>
          {date && <p className="order-date">{date}</p>}
        </div>
        <div className="order-card-head-party">
          <div className="order-party-info">
            <span className="order-party-role">{partyRole}</span>
            <span className="order-party-name">{partyName}</span>
          </div>
          <div className={`order-avatar tone-${avatarTone}`} aria-hidden="true">{avatar}</div>
        </div>
      </div>

      <div className="card-body">
        <section className="card-block">
          <div className="card-block-title">
            <h3>{blockTitle}</h3>
            {blockNote && <span className="card-block-note">{blockNote}</span>}
          </div>
          <div className="card-block-body">
            <div className="badges">{badges}</div>
            <Progress steps={steps} />
          </div>
        </section>

        {amount != null && (
          <section className="card-block">
            <div className="card-block-title"><h3>Amount</h3></div>
            <div className="card-block-body">
              <div className="order-price">
                <span className="price-amount">{amountFmt(amount)}</span>
                <span className="price-currency">ETB</span>
              </div>
            </div>
          </section>
        )}

        <div className={`order-actions${stack ? ' order-actions--stack' : ''}`}>{footer}</div>
      </div>
    </article>
  );
}

function CardFooter({ date, to, text }) {
  return (
    <>
      <span className="order-time">{date ? `Created ${date}` : 'Recently updated'}</span>
      <Link className="btn-view" to={to}>
        {text} <ArrowIcon />
      </Link>
    </>
  );
}

function OrderCard({ o, footerText = 'View order', eyebrowOverride, blockTitle = 'Order status' }) {
  const isSeller = o.viewerRole === 'SELLER';
  const counterparty = isSeller ? o.buyer : o.seller;
  const title = listingLabel(o.listing);
  const date = fmtDate(o.createdAt);

  const job = o.transportJob || null;
  const marketplaceStatus = summarizePayments(o.payments, 'MARKETPLACE');
  const transportPayment =
    job?.method === 'HIRE_TRANSPORTER' ? summarizePayments(o.payments, 'TRANSPORT') : null;
  const openDispute = (o.disputes || []).some((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');

  const tone = statusTone(o.status);
  const steps = progressFor(o, marketplaceStatus);

  return (
    <RecordCard
      eyebrow={eyebrowOverride || (isSeller ? 'Selling' : 'Buying')}
      selling={isSeller}
      title={title}
      date={date}
      partyRole={isSeller ? 'Buyer' : 'Seller'}
      partyName={counterparty?.name || 'Unknown party'}
      avatar={initialsOf(counterparty?.name, title)}
      avatarTone={openDispute ? 'danger' : tone}
      blockTitle={blockTitle}
      blockNote={`ORD ${shortId(o.id)}`}
      badges={
        <>
          <Pill tone={tone} dot>{pretty(o.status)}</Pill>
          {openDispute && <Pill tone="danger" dot>Disputed</Pill>}
          {marketplaceStatus && (
            <Pill tone={statusTone(marketplaceStatus)}>Payment: {pretty(marketplaceStatus)}</Pill>
          )}
          {job && (
            <Pill tone={statusTone(job.status)}>
              Transport: {pretty(job.status)}{transportPayment ? ` · ${pretty(transportPayment)}` : ''}
            </Pill>
          )}
        </>
      }
      steps={steps}
      amount={o.finalPrice}
      footer={<CardFooter date={date} to={`/orders/${o.id}`} text={footerText} />}
    />
  );
}

// ============================================================================
// Page
// ============================================================================

export default function Dashboard() {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState('buying');
  const [tabsOpen, setTabsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  const [offersSent, setOffersSent] = useState([]);
  const [orders, setOrders] = useState([]);
  const [myListings, setMyListings] = useState([]);
  const [offersReceived, setOffersReceived] = useState([]);
  const [sellerInspections, setSellerInspections] = useState([]);
  const [inspectionMessages, setInspectionMessages] = useState({});
  const [inspectionBusy, setInspectionBusy] = useState('');
  const [transportMessages, setTransportMessages] = useState({});
  const [transportBusy, setTransportBusy] = useState('');

  const [offerBusy, setOfferBusy] = useState('');
  const [counterDrafts, setCounterDrafts] = useState({});

  const [orderFilter, setOrderFilter] = useState('all');
  const [orderQuery, setOrderQuery] = useState('');

  const [selectedCounterpart, setSelectedCounterpart] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  // --------------------------------------------------------------------
  // PERFORMANCE: 3 requests instead of 25+
  // --------------------------------------------------------------------
  // Old flow: 1 offers + 1 orders + 3 listings statuses + N offers/listing
  // New flow: 1 offers/mine + 1 orders + 1 listings (all statuses) + 1 offers/received
  //
  // The backend /offers/received endpoint is required. If it doesn't exist
  // yet, it can be added as a 5-line route in offers.js (see note below).
  // As a graceful fallback, if that endpoint 404s, we skip received offers.
  // --------------------------------------------------------------------
  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError('');

    try {
      const [offersRes, ordersRes, listingsRes, receivedRes, sellerInspectionRes] = await Promise.allSettled([
        api.get('/offers/mine', { params: { limit: 50 } }),
        api.get('/orders', { params: { limit: 50 } }),
        api.get('/listings', { params: { sellerId: user.id, limit: 100 } }),
        api.get('/offers/received', { params: { limit: 100 } }),
        api.get('/inspections/seller-pending'),
      ]);

      setOffersSent(offersRes.status === 'fulfilled' ? offersRes.value.data?.offers || [] : []);
      setOrders(ordersRes.status === 'fulfilled' ? ordersRes.value.data?.orders || [] : []);
      setMyListings(listingsRes.status === 'fulfilled' ? listingsRes.value.data?.listings || [] : []);

      // offers/received may not exist yet on older backends. If it 404s,
      // fall back to an empty list rather than crashing the dashboard.
      if (receivedRes.status === 'fulfilled') {
        setOffersReceived(receivedRes.value.data?.offers || []);
      } else {
        setOffersReceived([]);
      }
      setSellerInspections(sellerInspectionRes.status === 'fulfilled' ? sellerInspectionRes.value.data?.requests || [] : []);

      // If any critical request failed, surface a friendly error.
      if (offersRes.status === 'rejected' || ordersRes.status === 'rejected' || listingsRes.status === 'rejected') {
        const first = [offersRes, ordersRes, listingsRes].find((r) => r.status === 'rejected');
        setError(first?.reason?.response?.data?.error || 'Could not load your dashboard');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your dashboard');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const confirmSellerInspection = async (requestId) => {
    setInspectionBusy(requestId);
    try {
      await api.post(`/inspections/${requestId}/seller-confirm`, { message: inspectionMessages[requestId] || '' });
      toast('Inspection confirmed. The inspector may now start work.');
      await loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not confirm inspection');
    } finally { setInspectionBusy(''); }
  };

  const confirmSellerTransportPickup = async (jobId) => {
    setTransportBusy(jobId);
    try {
      await api.post(`/transport/${jobId}/seller-confirm-pickup`, { message: transportMessages[jobId] || '' });
      toast('Transporter preparation confirmed. The buyer can now make the final BUY decision and pay the seller.');
      await loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not confirm transport pickup');
    } finally { setTransportBusy(''); }
  };

  const sendSellerInspectionMessage = async (requestId) => {
    const message = inspectionMessages[requestId] || '';
    if (!message.trim()) { toast('Choose or enter a message first.'); return; }
    setInspectionBusy(requestId);
    try {
      await api.post(`/inspections/${requestId}/seller-message`, { message });
      toast('Seller instructions saved. This does not confirm the inspection.');
      await loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not save seller instructions');
    } finally { setInspectionBusy(''); }
  };

  // --------------------------------------------------------------------
  // Derived views
  // --------------------------------------------------------------------

  const allOffers = useMemo(() => {
    const sent = offersSent.map((o) => ({ ...o, viewerRole: 'BUYER' }));
    const received = offersReceived.map((o) => ({ ...o, viewerRole: 'SELLER' }));
    const seen = new Set();
    const deduped = [...sent, ...received].filter((o) => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });
    const parentIds = new Set(deduped.map((o) => o.parentOfferId).filter(Boolean));
    return deduped
      .filter((o) => !parentIds.has(o.id))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }, [offersSent, offersReceived]);

  const myTurnOffers = allOffers.filter(
    (o) =>
      (o.status === 'PENDING' && o.viewerRole === 'SELLER') ||
      (o.status === 'SELECTED' && o.viewerRole === 'BUYER') ||
      (o.status === 'COUNTERED' &&
        ((o.counteredBy === 'SELLER' && o.viewerRole === 'BUYER') ||
          (o.counteredBy === 'BUYER' && o.viewerRole === 'SELLER')))
  );

  const ordersTagged = useMemo(
    () =>
      [...orders]
        .map((o) => ({ ...o, viewerRole: o.buyerId === user?.id ? 'BUYER' : 'SELLER' }))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)),
    [orders, user?.id]
  );

  const orderStats = useMemo(() => ({
    total: ordersTagged.length,
    buying: ordersTagged.filter((o) => o.viewerRole === 'BUYER').length,
    selling: ordersTagged.filter((o) => o.viewerRole === 'SELLER').length,
    completed: ordersTagged.filter((o) =>
      ['DELIVERED', 'COMPLETED'].includes(String(o.status || '').toUpperCase())
    ).length,
  }), [ordersTagged]);

  const filteredOrders = useMemo(() => {
    let rows = ordersTagged;
    if (orderFilter === 'buying') rows = rows.filter((o) => o.viewerRole === 'BUYER');
    if (orderFilter === 'selling') rows = rows.filter((o) => o.viewerRole === 'SELLER');
    const q = orderQuery.trim().toLowerCase();
    if (q) {
      rows = rows.filter((o) => {
        const title = listingLabel(o.listing).toLowerCase();
        return (
          title.includes(q) ||
          (o.buyer?.name || '').toLowerCase().includes(q) ||
          (o.seller?.name || '').toLowerCase().includes(q) ||
          String(o.id || '').toLowerCase().includes(q)
        );
      });
    }
    return rows;
  }, [ordersTagged, orderFilter, orderQuery]);

  const allPayments = useMemo(
    () =>
      ordersTagged
        .flatMap((o) => (o.payments || []).map((p) => ({ ...p, order: o })))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [ordersTagged]
  );

  const counterparts = useMemo(() => {
    const map = new Map();
    for (const o of ordersTagged) {
      const other = o.viewerRole === 'BUYER' ? o.seller : o.buyer;
      if (other && other.id !== user?.id && !map.has(other.id)) {
        map.set(other.id, { id: other.id, name: other.name, lastOrderId: o.id });
      }
      const truckOwnerId = o.transportJob?.truckOwnerId;
      if (truckOwnerId && truckOwnerId !== user?.id && !map.has(truckOwnerId)) {
        map.set(truckOwnerId, { id: truckOwnerId, name: 'Transporter', lastOrderId: o.id });
      }
    }
    return Array.from(map.values());
  }, [ordersTagged, user?.id]);

  const sellerOrders = ordersTagged.filter((o) => o.viewerRole === 'SELLER');
  const confirmedSales = sellerOrders.filter((o) => ACTIVE_SALE_STATUSES.includes(o.status));
  const grossSales = confirmedSales.reduce((sum, o) => sum + Number(o.finalPrice || 0), 0);
  const pendingSales = sellerOrders.filter((o) => o.status === 'PENDING_PAYMENT');
  const buyerOrdersCount = orderStats.buying;
  const activeListings = myListings.filter((l) => l.status === 'ACTIVE').length;

  const activityItems = [
    ...allOffers.map((o) => ({
      id: `offer-${o.id}`,
      icon: '💬',
      text: `${money(o.amount)} offer on ${listingLabel(o.listing)} (${o.viewerRole === 'BUYER' ? 'you sent' : 'you received'})`,
      time: o.updatedAt || o.createdAt,
      href: `/listings/${o.listing?.id}`,
    })),
    ...ordersTagged.map((o) => ({
      id: `order-${o.id}`,
      icon: '📦',
      text: `Order for ${listingLabel(o.listing)} is ${o.status.replaceAll('_', ' ').toLowerCase()}`,
      time: o.updatedAt || o.createdAt,
      href: `/orders/${o.id}`,
    })),
  ].sort((a, b) => new Date(b.time) - new Date(a.time));

  // --------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------

  async function respondToOffer(offerId, action, counterAmount) {
    setOfferBusy(offerId);
    try {
      await api.patch(`/offers/${offerId}`, {
        action,
        ...(counterAmount ? { counterAmount: Number(counterAmount) } : {}),
      });
      toast(
        action === 'SELECT'
          ? 'Buyer selected — negotiation opened.'
          : action === 'ACCEPT' || action === 'ACCEPT_COUNTER' || action === 'ACCEPT_SELECTED'
            ? 'Offer accepted'
            : action === 'REJECT'
              ? 'Offer rejected'
              : 'Counter-offer sent'
      );
      await loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not update the offer');
    } finally {
      setOfferBusy('');
    }
  }

  async function openThread(counterpart) {
    setSelectedCounterpart(counterpart);
    setThreadLoading(true);
    try {
      const res = await api.get(`/messages/thread/${counterpart.id}`);
      setThread(res.data?.messages || []);
    } catch (err) {
      toast(err.response?.data?.error || 'Could not load conversation');
    } finally {
      setThreadLoading(false);
    }
  }

  // --------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------

  if (loading) {
    return (
      <main className="section dashboard-page">
        <div className="container-wide">
          <div className="loading-card">
            <span className="loading-spinner" aria-hidden="true" />
            <span>Loading your dashboard…</span>
          </div>
        </div>
      </main>
    );
  }

  const activeTabMeta = TABS.find((tab) => tab.id === activeTab);

  return (
    <main className="section dashboard-page">
      <div className="container-wide">
        <DashboardWelcome
          user={user}
          subtitle="Buying, selling, and everything in between — all in one place."
        >
          <RecentActivity
            items={activityItems}
            emptyText="No activity yet — browse listings or create one to get started."
          />
        </DashboardWelcome>

        <section className="service-access" aria-labelledby="service-access-title">
          <div className="service-access-header">
            <div>
              <span className="eyebrow">MARKET SERVICES</span>
              <h2 id="service-access-title">Need help with your transaction?</h2>
              <p className="muted">
                Buyers and sellers can request transport or inspection directly.
                You do not need to become a transporter or inspector.
              </p>
            </div>
            <Link className="btn btn-light" to="/services">View all services</Link>
          </div>

          <div className="service-access-grid">
            <Link to="/orders" className="service-access-card">
              <span className="service-access-icon" aria-hidden="true">🚛</span>
              <span className="service-access-copy">
                <strong>Arrange Transport</strong>
                <span>Hire a registered transporter or manage your own truck for an existing order.</span>
              </span>
              <span className="service-access-arrow" aria-hidden="true">→</span>
            </Link>

            <Link to="/agricultural" className="service-access-card">
              <span className="service-access-icon" aria-hidden="true">🔍</span>
              <span className="service-access-copy">
                <strong>Request Inspection</strong>
                <span>Open an agricultural listing and request a registered inspector before you buy or sell.</span>
              </span>
              <span className="service-access-arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </section>

        {error && <div className="alert error">{error}</div>}
        {toastMsg && <div className="sd-toast">{toastMsg}</div>}

        <nav className={`sd-tabs-nav${tabsOpen ? ' sd-tabs-open' : ''}`}>
          <button
            type="button"
            className="sd-tabs-current"
            aria-expanded={tabsOpen}
            aria-controls="dashboard-tabs-list"
            onClick={() => setTabsOpen((open) => !open)}
          >
            <span className="sd-tabs-current-label">
              {activeTabMeta?.label || 'Dashboard'}
              {activeTab === 'offers' && myTurnOffers.length > 0 && (
                <span className="sd-tab-count">{myTurnOffers.length}</span>
              )}
            </span>
            <span className="sd-tabs-chevron" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </button>

          <div id="dashboard-tabs-list" className="sd-tabs-list" role="tablist" aria-label="Dashboard sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`sd-tab ${activeTab === tab.id ? 'sd-active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.id);
                  setTabsOpen(false);
                }}
              >
                {tab.label}
                {tab.id === 'offers' && myTurnOffers.length > 0 && (
                  <span className="sd-tab-count">{myTurnOffers.length}</span>
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* BUYING */}
        {activeTab === 'buying' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">BUYING</span>
                <h1>My buying activity</h1>
              </div>
              <Link className="btn btn-primary" to="/listings">Browse listings</Link>
            </header>

            <div className="stats-strip stats-strip--3">
              <StatTile label="Offers sent" value={offersSent.length} accent />
              <StatTile label="Orders as buyer" value={buyerOrdersCount} />
              <StatTile label="Need your reply" value={myTurnOffers.filter((o) => o.viewerRole === 'BUYER').length} />
            </div>

            {offersSent.length === 0 ? (
              <EmptyState icon="🛒" title="No offers yet" text="You haven't made an offer yet. Browse listings to find something to buy." />
            ) : (
              <div className="order-list">
                {offersSent.slice(0, 8).map((o) => {
                  const title = listingLabel(o.listing);
                  const date = fmtDate(o.createdAt);
                  const tone = statusTone(o.status);
                  return (
                    <RecordCard
                      key={o.id}
                      eyebrow="Buying"
                      title={title}
                      date={date}
                      partyRole="Seller"
                      partyName={o.seller?.name || 'Unknown party'}
                      avatar={initialsOf(o.seller?.name, title)}
                      avatarTone={tone}
                      blockTitle="Offer status"
                      blockNote={`OFF ${shortId(o.id)}`}
                      badges={<Pill tone={tone} dot>{pretty(o.status)}</Pill>}
                      amount={o.amount}
                      footer={<CardFooter date={date} to={`/listings/${o.listing?.id}`} text="View listing" />}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* SELLING */}
        {activeTab === 'selling' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow is-selling">SELLING</span>
                <h1>My selling activity</h1>
              </div>
              <Link className="btn btn-primary" to="/create-listing">Create a listing</Link>
            </header>

            <div className="stats-strip">
              <StatTile label="Listings" value={myListings.length} />
              <StatTile label="Active" value={activeListings} />
              <StatTile label="Offers received" value={offersReceived.length} />
              <StatTile label="Confirmed sales" value={money(grossSales)} accent />
            </div>

            <section className="panel" aria-labelledby="seller-inspection-review-title">
              <div className="panel-head"><h3 id="seller-inspection-review-title">Inspection confirmations</h3></div>
              <p className="muted">An agreed inspector cannot begin until you confirm. Other inspector bids remain visible in the competition.</p>
              {sellerInspections.filter((r) => r.status === 'ACCEPTED' || r.status === 'IN_PROGRESS').length === 0 ? (
                <p>No inspections are awaiting seller review.</p>
              ) : sellerInspections.filter((r) => r.status === 'ACCEPTED' || r.status === 'IN_PROGRESS').map((r) => (
                <div key={r.id} className="panel" style={{ marginTop: 12 }}>
                  <strong>{r.listing?.title || r.listing?.cropType || 'Produce inspection'}</strong>
                  <p>Inspector: {r.inspector?.name || 'Selected inspector'} · Agreed fee: {money(r.fee)}</p>
                  <p>Status: {r.sellerConfirmedAt ? 'Seller confirmed' : 'Waiting for your confirmation'}{r.status === 'IN_PROGRESS' ? ' · Inspection in progress' : ''}</p>
                  {r.sellerMessage && <p>Latest seller message: {r.sellerMessage}</p>}
                  <label style={{ display: 'block', margin: '8px 0' }}>Message to buyer / inspector
                    <select value={inspectionMessages[r.id] || ''} onChange={(e) => setInspectionMessages((old) => ({ ...old, [r.id]: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="">Choose a message or write a custom one below</option>
                      <option value="I confirm the selected inspector and agreed fee.">I confirm the selected inspector and agreed fee.</option>
                      <option value="The produce is ready for inspection.">The produce is ready for inspection.</option>
                      <option value="Please coordinate the inspection time with the buyer.">Please coordinate the inspection time with the buyer.</option>
                      <option value="Please contact me before visiting.">Please contact me before visiting.</option>
                      <option value="The produce is not ready yet; please wait.">The produce is not ready yet; please wait.</option>
                    </select>
                  </label>
                  <textarea aria-label="Custom inspection message" placeholder="Or enter a custom message" value={inspectionMessages[r.id] || ''} onChange={(e) => setInspectionMessages((old) => ({ ...old, [r.id]: e.target.value }))} rows={2} style={{ display: 'block', width: '100%', marginBottom: 8 }} />
                  <div className="action-grid">
                    <button type="button" className="btn btn-outline" disabled={inspectionBusy === r.id} onClick={() => sendSellerInspectionMessage(r.id)}>Send instructions only</button>
                    {!r.sellerConfirmedAt && r.status === 'ACCEPTED' && <button type="button" className="btn btn-primary" disabled={inspectionBusy === r.id} onClick={() => confirmSellerInspection(r.id)}>Confirm inspection</button>}
                  </div>
                </div>
              ))}
            </section>

            <section className="panel" aria-labelledby="seller-transport-confirm-title">
              <div className="panel-head"><h3 id="seller-transport-confirm-title">Transporter preparation confirmations</h3></div>
              <p className="muted">Confirm that the goods are ready before the selected transporter can mark them as picked up.</p>
              {orders.filter((o) => o.sellerId === user?.id && o.transportJob && o.transportJob.status === 'ACCEPTED' && !o.transportJob.sellerPickupConfirmedAt).length === 0 ? (
                <p>No transport pickups are awaiting your confirmation.</p>
              ) : orders.filter((o) => o.sellerId === user?.id && o.transportJob && o.transportJob.status === 'ACCEPTED' && !o.transportJob.sellerPickupConfirmedAt).map((o) => {
                const job = o.transportJob;
                return <div key={job.id} className="panel" style={{ marginTop: 12 }}>
                  <strong>{o.listing?.title || o.listing?.cropType || 'Order transport'}</strong>
                  <p>Transporter: {job.truckOwner?.name || job.truckOwner?.user?.name || 'Selected transporter'} · Status: awaiting seller confirmation of transporter preparation</p>
                  {job.sellerPreparationDueAt && (
                    <p className="muted small">Confirmation deadline: <strong>{new Date(job.sellerPreparationDueAt).toLocaleString()}</strong></p>
                  )}
                  <p>Pickup: {job.pickupLocation || 'Not specified'} · Destination: {job.destination || 'Not specified'}</p>
                  <label style={{ display: 'block', margin: '8px 0' }}>Message to transporter / buyer
                    <select value={transportMessages[job.id] || ''} onChange={(e) => setTransportMessages((old) => ({ ...old, [job.id]: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="">Choose a message or write a custom one below</option>
                      <option value="The goods are ready for pickup. You may proceed after coordinating with the buyer.">The goods are ready for pickup.</option>
                      <option value="Please contact me before submitting the loading plan.">Please contact me before submitting the loading plan.</option>
                      <option value="The goods are not ready yet; please wait.">The goods are not ready yet; please wait.</option>
                      <option value="Please coordinate the pickup time with the buyer.">Please coordinate the pickup time with the buyer.</option>
                    </select>
                  </label>
                  <textarea aria-label="Custom transport pickup message" placeholder="Optional custom message" value={transportMessages[job.id] || ''} onChange={(e) => setTransportMessages((old) => ({ ...old, [job.id]: e.target.value }))} rows={2} style={{ display: 'block', width: '100%', marginBottom: 8 }} />
                  <button type="button" className="btn btn-primary" disabled={transportBusy === job.id} onClick={() => confirmSellerTransportPickup(job.id)}>Confirm goods ready for pickup</button>
                </div>;
              })}
            </section>

            <section className="panel">
              <div className="panel-head"><h3>Quick actions</h3></div>
              <div className="action-grid">
                <button type="button" className="btn btn-outline" onClick={() => setActiveTab('listings')}>
                  Manage my listings
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setActiveTab('offers')}>
                  Review offers
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setActiveTab('earnings')}>
                  View earnings
                </button>
              </div>
            </section>
          </>
        )}

        {/* MY LISTINGS */}
        {activeTab === 'listings' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">LISTINGS</span>
                <h1>My listings</h1>
              </div>
              <Link className="btn btn-primary" to="/create-listing">Create a listing</Link>
            </header>

            <div className="tab-head-chip-row">
              <span className="tab-head-chip">{myListings.length} total</span>
              <span className="tab-head-chip">{activeListings} active</span>
            </div>

            {myListings.length === 0 ? (
              <EmptyState icon="🌾" title="Nothing listed yet" text="Create your first listing and buyers will be able to send you offers." />
            ) : (
              <div className="order-list">
                {myListings.map((l) => {
                  const offersForListing = offersReceived.filter((o) => o.listing?.id === l.id || o.listingId === l.id).length;
                  const date = fmtDate(l.createdAt);
                  const tone = statusTone(l.status);
                  const title = listingLabel(l);
                  return (
                    <RecordCard
                      key={l.id}
                      eyebrow="Listing"
                      title={title}
                      date={date}
                      partyRole="Status"
                      partyName={pretty(l.status)}
                      avatar={recordTag(title)}
                      avatarTone={tone}
                      blockTitle="Offers received"
                      blockNote={`LST ${shortId(l.id)}`}
                      badges={
                        <>
                          <Pill tone={tone} dot>{pretty(l.status)}</Pill>
                          <Pill tone="muted">{offersForListing} offer{offersForListing === 1 ? '' : 's'}</Pill>
                        </>
                      }
                      footer={<CardFooter date={date} to={`/listings/${l.id}`} text="Manage" />}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* OFFERS */}
        {activeTab === 'offers' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">OFFERS</span>
                <h1>Offers &amp; negotiations</h1>
              </div>
              <span className="tab-head-chip">
                {allOffers.length} total
                {myTurnOffers.length > 0 && (
                  <span className="tab-head-chip-alert">{myTurnOffers.length} need reply</span>
                )}
              </span>
            </header>

            {allOffers.length === 0 ? (
              <EmptyState icon="💬" title="No offers yet" text="Offers you send or receive will show up here." />
            ) : (
              <div className="order-list">
                {allOffers.map((o) => {
                  const myTurn = myTurnOffers.some((mt) => mt.id === o.id);
                  const isSeller = o.viewerRole === 'SELLER';
                  const counterparty = isSeller ? o.buyer : o.seller;
                  const date = fmtDate(o.updatedAt || o.createdAt);
                  const tone = statusTone(o.status);
                  const title = listingLabel(o.listing);

                  const isPendingSelect = o.status === 'PENDING' && isSeller;
                  const acceptAction = isPendingSelect
                    ? 'SELECT'
                    : isSeller
                      ? 'ACCEPT'
                      : o.status === 'SELECTED'
                        ? 'ACCEPT_SELECTED'
                        : 'ACCEPT_COUNTER';
                  const counterAction = isSeller ? 'COUNTER' : 'RE_COUNTER';
                  const canCounter = !isPendingSelect;

                  const footer = myTurn ? (
                    <div className="sd-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={offerBusy === o.id}
                        onClick={() => respondToOffer(o.id, acceptAction)}
                      >
                        {isPendingSelect ? 'Select buyer' : 'Accept'}
                      </button>
                      {isSeller && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline"
                          disabled={offerBusy === o.id}
                          onClick={() => respondToOffer(o.id, 'REJECT')}
                        >
                          Reject
                        </button>
                      )}
                      {canCounter && (
                        <>
                          <AmountPicker
                            className="sd-counter-picker"
                            reference={Number(o.counterAmount ?? o.amount)}
                            placeholder="Counter (ETB)"
                            value={counterDrafts[o.id] || ''}
                            onChange={(v) => setCounterDrafts((d) => ({ ...d, [o.id]: v }))}
                            ariaLabel="Counter amount in ETB"
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-outline"
                            disabled={offerBusy === o.id || !counterDrafts[o.id]}
                            onClick={() => respondToOffer(o.id, counterAction, counterDrafts[o.id])}
                          >
                            Counter
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="order-time">
                      {['PENDING', 'SELECTED', 'COUNTERED'].includes(o.status)
                        ? 'Waiting on the other party'
                        : '—'}
                    </span>
                  );

                  return (
                    <RecordCard
                      key={o.id}
                      highlight={myTurn}
                      stack
                      eyebrow={isSeller ? 'Selling' : 'Buying'}
                      selling={isSeller}
                      title={title}
                      date={date}
                      partyRole={isSeller ? 'Buyer' : 'Seller'}
                      partyName={counterparty?.name || 'Unknown party'}
                      avatar={initialsOf(counterparty?.name, title)}
                      avatarTone={isSeller ? 'success' : 'info'}
                      blockTitle="Offer status"
                      blockNote={`OFF ${shortId(o.id)}`}
                      badges={
                        <>
                          <Pill tone={tone} dot>{pretty(o.status)}</Pill>
                          {o.status === 'COUNTERED' && (
                            <Pill tone="gold">{o.counteredBy === 'SELLER' ? 'Seller' : 'Buyer'} countered</Pill>
                          )}
                        </>
                      }
                      amount={o.amount}
                      footer={footer}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ORDERS */}
        {activeTab === 'orders' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">ORDERS</span>
                <h1>Orders</h1>
              </div>
              <span className="tab-head-chip">{orderStats.total} total</span>
            </header>

            {ordersTagged.length > 0 && (
              <>
                <div className="stats-strip">
                  <StatTile label="Total" value={orderStats.total} accent />
                  <StatTile label="Buying" value={orderStats.buying} />
                  <StatTile label="Selling" value={orderStats.selling} />
                  <StatTile label="Completed" value={orderStats.completed} />
                </div>

                <div className="toolbar">
                  <div className="sd-seg" role="tablist" aria-label="Filter orders">
                    {ORDER_FILTERS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        role="tab"
                        aria-selected={orderFilter === f.id}
                        className={`sd-seg-btn${orderFilter === f.id ? ' sd-active' : ''}`}
                        onClick={() => setOrderFilter(f.id)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <label className="search">
                    <span className="search-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                           strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="7" />
                        <path d="M21 21l-4.3-4.3" />
                      </svg>
                    </span>
                    <input
                      type="search"
                      value={orderQuery}
                      onChange={(e) => setOrderQuery(e.target.value)}
                      placeholder="Search orders…"
                      aria-label="Search orders"
                    />
                  </label>
                </div>
              </>
            )}

            {ordersTagged.length === 0 ? (
              <EmptyState icon="📦" title="No orders here yet"
                text="Once an offer is accepted or a purchase is completed, it will appear here ready for payment, transport, inspection and delivery." />
            ) : filteredOrders.length === 0 ? (
              <EmptyState icon="🔎" title="No orders in this view"
                text="Try a different filter or clear the search to see more results." />
            ) : (
              <div className="order-list">
                {filteredOrders.map((o) => <OrderCard key={o.id} o={o} />)}
              </div>
            )}
          </>
        )}

        {/* MESSAGES */}
        {activeTab === 'messages' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">MESSAGES</span>
                <h1>Conversations</h1>
              </div>
              <span className="tab-head-chip">{counterparts.length}</span>
            </header>

            <div className="card-grid two-col">
              <div>
                {counterparts.length === 0 ? (
                  <EmptyState icon="💬" title="No conversations" text="Conversations appear once you have an order with someone." />
                ) : (
                  <div className="order-list order-list--one">
                    {counterparts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`conv-card${selectedCounterpart?.id === c.id ? ' conv-card--active' : ''}`}
                        onClick={() => openThread(c)}
                      >
                        <span className="order-avatar tone-muted">{initialsOf(c.name, 'User')}</span>
                        <span className="conv-card-text">
                          <span className="order-title">{c.name || 'User'}</span>
                          <span className="order-date">ORD {shortId(c.lastOrderId)}</span>
                        </span>
                        <span className="conv-card-arrow" aria-hidden="true">→</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                {!selectedCounterpart ? (
                  <section className="panel panel--empty">
                    <div className="panel-empty">
                      <span className="panel-empty-icon" aria-hidden="true">💬</span>
                      <h3>No conversation open</h3>
                      <p className="muted">Select a conversation to view messages.</p>
                    </div>
                  </section>
                ) : threadLoading ? (
                  <section className="panel panel--empty">
                    <div className="panel-empty">
                      <span className="loading-spinner" aria-hidden="true" />
                      <h3>Loading…</h3>
                      <p className="muted">Fetching the conversation.</p>
                    </div>
                  </section>
                ) : (
                  <MessageThread
                    orderId={selectedCounterpart.lastOrderId}
                    messages={thread}
                    counterpartId={selectedCounterpart.id}
                    counterpartName={selectedCounterpart.name}
                    currentUserId={user?.id}
                    onSent={(m) => setThread((t) => [...t, m])}
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* PAYMENTS */}
        {activeTab === 'payments' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow">PAYMENTS</span>
                <h1>Payments</h1>
              </div>
              <span className="tab-head-chip">{allPayments.length} total</span>
            </header>

            {allPayments.length === 0 ? (
              <EmptyState icon="💳" title="No payments yet" text="Payments for your orders will be listed here." />
            ) : (
              <div className="order-list">
                {allPayments.map((p) => {
                  const date = fmtDate(p.createdAt);
                  const tone = statusTone(p.status);
                  const isTransport = p.type === 'TRANSPORT';
                  return (
                    <RecordCard
                      key={p.id}
                      eyebrow="Payment"
                      title={isTransport ? 'Transport payment' : 'Marketplace payment'}
                      date={date}
                      partyRole="Order"
                      partyName={`ORD ${shortId(p.orderId)}`}
                      avatar={isTransport ? 'TR' : 'PY'}
                      avatarTone={tone}
                      blockTitle="Payment status"
                      blockNote={`PAY ${shortId(p.id)}`}
                      badges={<Pill tone={tone} dot>{pretty(p.status)}</Pill>}
                      amount={p.amount}
                      footer={<CardFooter date={date} to={`/orders/${p.order.id}`} text="View order" />}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* EARNINGS */}
        {activeTab === 'earnings' && (
          <>
            <header className="tab-head">
              <div className="tab-head-text">
                <span className="eyebrow is-selling">EARNINGS</span>
                <h1>Sales &amp; earnings</h1>
              </div>
            </header>

            <div className="stats-strip stats-strip--3">
              <StatTile label="Confirmed sales" value={money(grossSales)} accent />
              <StatTile label="Completed / active" value={confirmedSales.length} />
              <StatTile label="Awaiting buyer payment" value={pendingSales.length} />
            </div>

            {confirmedSales.length === 0 ? (
              <EmptyState icon="📈" title="No confirmed sales yet" text="Confirmed sales will appear here once buyers pay." />
            ) : (
              <div className="order-list">
                {confirmedSales.map((o) => (
                  <OrderCard key={o.id} o={o} eyebrowOverride="Sale" blockTitle="Sale status" />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
