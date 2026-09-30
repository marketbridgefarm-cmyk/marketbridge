import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

const LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];
const ACTIVE_SALE_STATUSES = ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'];
const TRANSPORT_STARTED = ['TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'];
const NO_PROGRESS = ['CANCELLED', 'DISPUTED', 'FROZEN', 'REJECTED', 'FAILED', 'PENDING_PAYMENT'];

function money(value) {
  return `${Number(value || 0).toLocaleString()} ETB`;
}

function shortId(id) {
  return id ? id.slice(0, 8).toUpperCase() : '—';
}

function listingLabel(listing) {
  return listing?.cropType || listing?.title || 'Listing';
}

function recordTag(label) {
  return String(label || '??').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '??';
}

// Initials from a name, falling back to a 2-letter tag when the name is
// missing or literally "Unknown".
function initialsOf(name, fallback) {
  const cleaned = String(name || '').trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') {
    return recordTag(fallback);
  }
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

function statusTone(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'CONFIRMED', 'PAID', 'ACCEPTED', 'SELECTED'].includes(s)) return 'success';
  if (['IN_TRANSIT', 'TRANSPORT_ARRANGED', 'TRANSPORT_PAID'].includes(s)) return 'info';
  if (['CANCELLED', 'DISPUTED', 'FROZEN', 'REJECTED', 'FAILED'].includes(s)) return 'danger';
  if (['PENDING_PAYMENT', 'PENDING', 'AWAITING_INSPECTION', 'EXPIRED', 'RECONCILIATION_REQUIRED'].includes(s)) return 'gold';
  return 'muted';
}

const label = (s) => String(s || '').replace(/_/g, ' ');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : null);

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Order helpers: extra pills + progress steps (payment / transport)
// ---------------------------------------------------------------------------

function orderExtras(o) {
  const payments = o.payments || [];
  const salePay = payments.find((p) => p.type !== 'TRANSPORT');
  const transportPay = payments.find((p) => p.type === 'TRANSPORT');
  const job = o.transportJob;

  const pills = [];
  if (salePay?.status) {
    pills.push({ key: 'pay', tone: statusTone(salePay.status), text: `Payment: ${label(salePay.status)}` });
  }
  if (job?.status) {
    const text = `Transport: ${label(job.status)}${transportPay?.status ? ` · ${label(transportPay.status)}` : ''}`;
    const tone = transportPay?.status && transportPay.status !== 'PAID' ? 'gold' : statusTone(job.status);
    pills.push({ key: 'tr', tone, text });
  }

  let steps = null;
  if (!NO_PROGRESS.includes(o.status)) {
    const jobStatus = String(job?.status || '').toUpperCase();
    steps = [
      { name: 'Confirmed', done: true },
      { name: 'Transport', done: TRANSPORT_STARTED.includes(o.status) || ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(jobStatus) },
      { name: 'Delivered', done: ['DELIVERED', 'COMPLETED'].includes(o.status) || jobStatus === 'DELIVERED' },
      { name: 'Completed', done: o.status === 'COMPLETED' },
    ];
  }
  return { pills, steps };
}

function Progress({ steps }) {
  if (!steps) return null;
  return (
    <ol className="order-progress" aria-label="Order progress">
      {steps.map((s) => (
        <li key={s.name} className={`order-progress-step${s.done ? ' is-done' : ''}`} title={s.name}>
          <span className="order-progress-dot">{s.done && <CheckIcon />}</span>
          <span className="sr-only">{s.name}{s.done ? ' — done' : ' — pending'}</span>
        </li>
      ))}
    </ol>
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

// ---------------------------------------------------------------------------
// Shared card (identical structure to the design screenshot)
// ---------------------------------------------------------------------------

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
          <h2 className="order-title">{title}</h2>
          {date && <p className="order-date">{date}</p>}
        </div>
        <div className="order-card-head-party">
          <div className="order-party-info">
            <span className="order-party-role">{partyRole}</span>
            <span className="order-party-name">{partyName}</span>
          </div>
          <div className={`order-avatar tone-${avatarTone}`}>{avatar}</div>
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
          <section className="card-block card-block--amount">
            <div className="card-block-title"><h3>Amount</h3></div>
            <div className="card-block-body">
              <div className="order-price">
                <span className="price-amount">{Number(amount || 0).toLocaleString()}</span>
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
  const tone = statusTone(o.status);
  const title = listingLabel(o.listing);
  const { pills, steps } = orderExtras(o);
  const date = fmtDate(o.createdAt);
  return (
    <RecordCard
      eyebrow={eyebrowOverride || (isSeller ? 'Selling' : 'Buying')}
      selling={isSeller}
      title={title}
      date={date}
      partyRole={isSeller ? 'Buyer' : 'Seller'}
      partyName={counterparty?.name || 'Unknown'}
      avatar={initialsOf(counterparty?.name, title)}
      avatarTone={tone}
      blockTitle={blockTitle}
      blockNote={`ORD ${shortId(o.id)}`}
      badges={
        <>
          <Pill tone={tone} dot>{label(o.status)}</Pill>
          {pills.map((p) => <Pill key={p.key} tone={p.tone}>{p.text}</Pill>)}
        </>
      }
      steps={steps}
      amount={o.finalPrice}
      footer={<CardFooter date={date} to={`/orders/${o.id}`} text={footerText} />}
    />
  );
}

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

  const [offerBusy, setOfferBusy] = useState('');
  const [counterDrafts, setCounterDrafts] = useState({});

  const [selectedCounterpart, setSelectedCounterpart] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError('');

    try {
      const [offersRes, ordersRes, ...listingResults] = await Promise.all([
        api.get('/offers/mine'),
        api.get('/orders'),
        ...LISTING_STATUSES.map((status) =>
          api.get('/listings', { params: { sellerId: user.id, status, limit: 50 } })
        ),
      ]);

      setOffersSent(offersRes.data?.offers || []);
      setOrders(ordersRes.data?.orders || []);

      const listings = listingResults.flatMap((r) => r.data?.listings || []);
      setMyListings(listings);

      if (listings.length > 0) {
        const offerResults = await Promise.all(
          listings.map((l) => api.get(`/offers/listing/${l.id}`))
        );
        const received = listings.flatMap((l, i) =>
          (offerResults[i].data?.offers || []).map((o) => ({ ...o, listing: l }))
        );
        setOffersReceived(received);
      } else {
        setOffersReceived([]);
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

  // --------------------------------------------------------------------
  // Derived views
  // --------------------------------------------------------------------

  const allOffers = useMemo(() => {
    const sent = offersSent.map((o) => ({ ...o, viewerRole: 'BUYER' }));
    const received = offersReceived.map((o) => ({ ...o, viewerRole: 'SELLER' }));
    const combined = [...sent, ...received];
    const seen = new Set();
    const deduped = combined.filter((o) => {
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
  const buyerOrdersCount = ordersTagged.filter((o) => o.viewerRole === 'BUYER').length;
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

        {/* SERVICE ACCESS */}
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

        {/* TABS */}
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

          <div
            id="dashboard-tabs-list"
            className="sd-tabs-list"
            role="tablist"
            aria-label="Dashboard sections"
          >
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

            <div className="tab-head-chip-row">
              <span className="tab-head-chip">
                {offersSent.length} offer{offersSent.length === 1 ? '' : 's'} sent
              </span>
              <span className="tab-head-chip">
                {buyerOrdersCount} order{buyerOrdersCount === 1 ? '' : 's'} as buyer
              </span>
            </div>

            {offersSent.length === 0 ? (
              <p className="muted">You haven't made an offer yet.</p>
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
                      partyName={o.seller?.name || 'Unknown'}
                      avatar={initialsOf(o.seller?.name, title)}
                      avatarTone={tone}
                      blockTitle="Offer status"
                      blockNote={`OFF ${shortId(o.id)}`}
                      badges={<Pill tone={tone} dot>{label(o.status)}</Pill>}
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

            <section className="panel">
              <div className="panel-head">
                <h3>Summary</h3>
                <span className="panel-head-note">
                  {activeListings} active · {offersReceived.length} offer
                  {offersReceived.length === 1 ? '' : 's'} received
                </span>
              </div>
              <p className="muted">
                You have <strong>{myListings.length} listing{myListings.length === 1 ? '' : 's'}</strong> on file.
                Confirmed sales so far: <strong>{money(grossSales)}</strong>.
              </p>
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
              <p className="muted">You haven't listed anything yet.</p>
            ) : (
              <div className="order-list">
                {myListings.map((l) => {
                  const offersForListing = offersReceived.filter((o) => o.listing?.id === l.id).length;
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
                      partyName={l.status}
                      avatar={recordTag(title)}
                      avatarTone={tone}
                      blockTitle="Offers received"
                      blockNote={`LST ${shortId(l.id)}`}
                      badges={
                        <>
                          <Pill tone={tone} dot>{label(l.status)}</Pill>
                          <Pill tone="muted">
                            {offersForListing} offer{offersForListing === 1 ? '' : 's'}
                          </Pill>
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
              <p className="muted">No offers yet.</p>
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
                          <input
                            className="sd-counter-input"
                            type="number"
                            placeholder="Counter ETB"
                            value={counterDrafts[o.id] || ''}
                            onChange={(e) =>
                              setCounterDrafts((d) => ({ ...d, [o.id]: e.target.value }))
                            }
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
                      partyName={counterparty?.name || 'Unknown'}
                      avatar={initialsOf(counterparty?.name, title)}
                      avatarTone={isSeller ? 'success' : 'info'}
                      blockTitle="Offer status"
                      blockNote={`OFF ${shortId(o.id)}`}
                      badges={
                        <>
                          <Pill tone={tone} dot>{label(o.status)}</Pill>
                          {o.status === 'COUNTERED' && (
                            <Pill tone="gold">
                              {o.counteredBy === 'SELLER' ? 'Seller' : 'Buyer'} countered
                            </Pill>
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
              <span className="tab-head-chip">{ordersTagged.length} total</span>
            </header>

            {ordersTagged.length === 0 ? (
              <p className="muted">No orders yet.</p>
            ) : (
              <div className="order-list">
                {ordersTagged.map((o) => <OrderCard key={o.id} o={o} />)}
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
                  <p className="muted">Conversations appear once you have an order with someone.</p>
                ) : (
                  <div className="order-list order-list--one">
                    {counterparts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`conv-card${selectedCounterpart?.id === c.id ? ' conv-card--active' : ''}`}
                        onClick={() => openThread(c)}
                      >
                        <span className="order-avatar tone-muted">
                          {initialsOf(c.name, 'User')}
                        </span>
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
              <p className="muted">No payments yet.</p>
            ) : (
              <div className="order-list">
                {allPayments.map((p) => {
                  const date = fmtDate(p.createdAt);
                  const tone = p.status === 'PAID' ? 'success' : 'gold';
                  return (
                    <RecordCard
                      key={p.id}
                      eyebrow="Payment"
                      title={p.type === 'TRANSPORT' ? 'Transport payment' : 'Marketplace payment'}
                      date={date}
                      partyRole="Order"
                      partyName={`ORD ${shortId(p.orderId)}`}
                      avatar={p.type === 'TRANSPORT' ? 'TR' : 'PY'}
                      avatarTone={tone}
                      blockTitle="Payment status"
                      blockNote={`PAY ${shortId(p.id)}`}
                      badges={<Pill tone={tone} dot>{p.status}</Pill>}
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

            <section className="panel">
              <div className="panel-head"><h3>At a glance</h3></div>
              <div className="sd-stat-grid">
                <div className="sd-stat sd-stat--accent">
                  <span>Confirmed sales</span>
                  <b>{money(grossSales)}</b>
                </div>
                <div className="sd-stat">
                  <span>Completed / active sales</span>
                  <b>{confirmedSales.length}</b>
                </div>
                <div className="sd-stat">
                  <span>Awaiting buyer payment</span>
                  <b>{pendingSales.length}</b>
                </div>
              </div>
            </section>

            {confirmedSales.length === 0 ? (
              <p className="muted">No confirmed sales yet.</p>
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
