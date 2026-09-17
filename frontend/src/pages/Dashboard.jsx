import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import MessageThread from '../components/MessageThread.jsx';

// ============================================================================
// UNIFIED DASHBOARD
// ============================================================================
// PDF recommendation #2: a normal registered user is both a buyer and a
// seller (DEFAULT_ROLES = ['BUYER', 'SELLER'] at registration — see
// backend/src/routes/auth.js) so they should have one home base instead of
// two disconnected dashboards. This page replaces the split
// BuyerDashboard/SellerDashboard entry point with a single page and tabs:
// Buying, Selling, My Listings, Offers, Orders, Messages, Payments, Earnings.
//
// Scope note: "My Listings" here is a summary list (status, offer count)
// rather than the full create/edit-with-media-upload flow — that heavier
// flow still lives on /create-listing and the listing detail page. Offer
// Accept/Reject are wired directly; Counter still links out to the listing
// page, which already has the full negotiation UI. See CHANGES.md.
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

function money(value) {
  return `${Number(value || 0).toLocaleString()} ETB`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

function listingLabel(listing) {
  return listing?.cropType || listing?.title || 'Listing';
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
  // Derived, unified views
  // --------------------------------------------------------------------

  // Only the current leaf of each negotiation chain gets action buttons —
  // the earlier offer in a countered chain is historical.
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
      toast(action === 'ACCEPT' ? 'Offer accepted' : action === 'REJECT' ? 'Offer rejected' : 'Counter-offer sent');
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
      <main className="section">
        <div className="container-wide loading">Loading your dashboard…</div>
      </main>
    );
  }

  return (
    <main className="section dashboard-page">
      <div className="container-wide">
        <DashboardWelcome user={user} subtitle="Buying, selling, and everything in between — all in one place.">
          <RecentActivity items={activityItems} emptyText="No activity yet — browse listings or create one to get started." />
        </DashboardWelcome>

        <section className="service-access" aria-labelledby="service-access-title">
          <div className="service-access-header">
            <div>
              <span className="eyebrow">MARKET SERVICES</span>
              <h2 id="service-access-title">Need help with your transaction?</h2>
              <p className="muted">Buyers and sellers can request transport or inspection directly. You do not need to become a transporter or inspector.</p>
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

        <div className={`sd-tabs-nav${tabsOpen ? ' sd-tabs-open' : ''}`}>
          <button
            type="button"
            className="sd-tabs-current"
            aria-expanded={tabsOpen}
            aria-controls="dashboard-tabs-list"
            onClick={() => setTabsOpen((open) => !open)}
          >
            <span>
              {TABS.find((tab) => tab.id === activeTab)?.label || 'Dashboard'}
              {activeTab === 'offers' && myTurnOffers.length > 0 && (
                <span className="sd-tab-count">{myTurnOffers.length}</span>
              )}
            </span>
            <span className="sd-tabs-chevron" aria-hidden="true">⌄</span>
          </button>
          <div id="dashboard-tabs-list" className="sd-tabs-list" role="tablist" aria-label="Dashboard sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`sd-tab ${activeTab === tab.id ? 'sd-active' : ''}`}
                onClick={() => { setActiveTab(tab.id); setTabsOpen(false); }}
              >
                {tab.label}
                {tab.id === 'offers' && myTurnOffers.length > 0 && (
                  <span className="sd-tab-count">{myTurnOffers.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ==================================================================== */}
        {/* BUYING */}
        {/* ==================================================================== */}
        {activeTab === 'buying' && (
          <div className="card">
            <div className="row-between">
              <h2>Buying</h2>
              <Link className="btn btn-primary" to="/listings">Browse listings</Link>
            </div>
            <p className="muted">{offersSent.length} offer{offersSent.length === 1 ? '' : 's'} sent · {ordersTagged.filter((o) => o.viewerRole === 'BUYER').length} order{ordersTagged.filter((o) => o.viewerRole === 'BUYER').length === 1 ? '' : 's'} as buyer.</p>
            {offersSent.length === 0 ? (
              <p className="muted">You haven't made an offer yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Listing</th><th>Amount</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {offersSent.slice(0, 8).map((o) => (
                    <tr key={o.id}>
                      <td data-label="Listing">{listingLabel(o.listing)}</td>
                      <td data-label="Amount">{money(o.amount)}</td>
                      <td data-label="Status">{o.status}</td>
                      <td data-label="Action"><Link className="sd-mobile-action" to={`/listings/${o.listing?.id}`}>View</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* SELLING */}
        {/* ==================================================================== */}
        {activeTab === 'selling' && (
          <div className="card">
            <div className="row-between">
              <h2>Selling</h2>
              <Link className="btn btn-primary" to="/create-listing">Create a listing</Link>
            </div>
            <p className="muted">
              {myListings.filter((l) => l.status === 'ACTIVE').length} active listing(s) ·{' '}
              {offersReceived.length} offer(s) received · {money(grossSales)} in confirmed sales.
            </p>
            <div className="sd-actions">
              <button type="button" className="btn btn-outline" onClick={() => setActiveTab('listings')}>Manage my listings</button>
              <button type="button" className="btn btn-outline" onClick={() => setActiveTab('offers')}>Review offers</button>
              <button type="button" className="btn btn-outline" onClick={() => setActiveTab('earnings')}>View earnings</button>
            </div>
          </div>
        )}

        {/* ==================================================================== */}
        {/* MY LISTINGS */}
        {/* ==================================================================== */}
        {activeTab === 'listings' && (
          <div className="card">
            <div className="row-between">
              <h2>My Listings</h2>
              <Link className="btn btn-primary" to="/create-listing">Create a listing</Link>
            </div>
            {myListings.length === 0 ? (
              <p className="muted">You haven't listed anything yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Listing</th><th>Status</th><th>Offers</th><th /></tr></thead>
                <tbody>
                  {myListings.map((l) => (
                    <tr key={l.id}>
                      <td data-label="Listing">{listingLabel(l)}</td>
                      <td data-label="Status"><span className="badge">{l.status}</span></td>
                      <td data-label="Offers">{offersReceived.filter((o) => o.listing?.id === l.id).length}</td>
                      <td data-label="Action"><Link className="sd-mobile-action" to={`/listings/${l.id}`}>Manage</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* OFFERS */}
        {/* ==================================================================== */}
        {activeTab === 'offers' && (
          <div className="card">
            <h2>Offers</h2>
            {allOffers.length === 0 ? (
              <p className="muted">No offers yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Listing</th><th>Role</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  {allOffers.map((o) => {
                    const myTurn = myTurnOffers.some((mt) => mt.id === o.id);
                    return (
                      <tr key={o.id}>
                        <td data-label="Listing">{listingLabel(o.listing)}</td>
                        <td data-label="Role">{o.viewerRole}</td>
                        <td data-label="Amount">{money(o.amount)}</td>
                        <td data-label="Status">{o.status}{o.status === 'COUNTERED' ? ` (${o.counteredBy === 'SELLER' ? 'seller' : 'buyer'} countered)` : ''}</td>
                        <td data-label="Action">
                          {myTurn ? (
                            <div className="sd-actions">
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={offerBusy === o.id}
                                onClick={() => {
                                  // A counter-offer belongs to the party that
                                  // made the latest counter. The responding
                                  // party accepts it with the normal ACCEPT
                                  // action. ACCEPT_COUNTER is specifically for
                                  // a buyer accepting a seller counter.
                                  const acceptAction =
                                    o.status === 'COUNTERED' && o.counteredBy === 'SELLER'
                                      ? 'ACCEPT_COUNTER'
                                      : 'ACCEPT';
                                  respondToOffer(o.id, acceptAction);
                                }}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-outline"
                                disabled={offerBusy === o.id}
                                onClick={() => respondToOffer(o.id, 'REJECT')}
                              >
                                Reject
                              </button>
                              <input
                                className="sd-counter-input"
                                type="number"
                                placeholder="Counter ETB"
                                value={counterDrafts[o.id] || ''}
                                onChange={(e) => setCounterDrafts((d) => ({ ...d, [o.id]: e.target.value }))}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-outline"
                                disabled={offerBusy === o.id || !counterDrafts[o.id]}
                                onClick={() => respondToOffer(o.id, o.status === 'COUNTERED' ? 'RE_COUNTER' : 'COUNTER', counterDrafts[o.id])}
                              >
                                Counter
                              </button>
                            </div>
                          ) : (
                            <span className="muted">
                              {['PENDING', 'COUNTERED'].includes(o.status) ? 'Waiting on the other party' : '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* ORDERS */}
        {/* ==================================================================== */}
        {activeTab === 'orders' && (
          <div className="card">
            <h2>Orders</h2>
            {ordersTagged.length === 0 ? (
              <p className="muted">No orders yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Order</th><th>Listing</th><th>Role</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {ordersTagged.map((o) => (
                    <tr key={o.id}>
                      <td data-label="Order">{shortId(o.id)}</td>
                      <td data-label="Listing">{listingLabel(o.listing)}</td>
                      <td data-label="Role">{o.viewerRole}</td>
                      <td data-label="Status"><span className="badge">{o.status}</span></td>
                      <td data-label="Action"><Link className="sd-mobile-action" to={`/orders/${o.id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* MESSAGES */}
        {/* ==================================================================== */}
        {activeTab === 'messages' && (
          <div className="card-grid two-col">
            <div className="card">
              <h2>Conversations</h2>
              {counterparts.length === 0 ? (
                <p className="muted">Conversations appear once you have an order with someone.</p>
              ) : (
                <ul className="sd-list">
                  {counterparts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`sd-list-item ${selectedCounterpart?.id === c.id ? 'sd-active' : ''}`}
                        onClick={() => openThread(c)}
                      >
                        {c.name || 'User'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              {!selectedCounterpart ? (
                <div className="card"><p className="muted">Select a conversation to view messages.</p></div>
              ) : threadLoading ? (
                <div className="card"><p className="muted">Loading conversation…</p></div>
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
        )}

        {/* ==================================================================== */}
        {/* PAYMENTS */}
        {/* ==================================================================== */}
        {activeTab === 'payments' && (
          <div className="card">
            <h2>Payments</h2>
            {allPayments.length === 0 ? (
              <p className="muted">No payments yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Order</th><th>Type</th><th>Amount</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {allPayments.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Order">{shortId(p.orderId)}</td>
                      <td data-label="Type">{p.type}</td>
                      <td data-label="Amount">{money(p.amount)}</td>
                      <td data-label="Status"><span className={`badge ${p.status === 'PAID' ? 'badge-success' : 'badge-pending'}`}>{p.status}</span></td>
                      <td data-label="Action"><Link className="sd-mobile-action" to={`/orders/${p.order.id}`}>Open order</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* EARNINGS */}
        {/* ==================================================================== */}
        {activeTab === 'earnings' && (
          <div className="card">
            <h2>Sales & Earnings</h2>
            <div className="sd-stat-grid">
              <div className="sd-stat"><span>Confirmed sales</span><b>{money(grossSales)}</b></div>
              <div className="sd-stat"><span>Completed / active sales</span><b>{confirmedSales.length}</b></div>
              <div className="sd-stat"><span>Awaiting buyer payment</span><b>{pendingSales.length}</b></div>
            </div>
            {confirmedSales.length === 0 ? (
              <p className="muted">No confirmed sales yet.</p>
            ) : (
              <table className="sd-table sd-table--mobile-cards">
                <thead><tr><th>Order</th><th>Listing</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {confirmedSales.map((o) => (
                    <tr key={o.id}>
                      <td data-label="Order"><Link className="sd-mobile-action" to={`/orders/${o.id}`}>{shortId(o.id)}</Link></td>
                      <td data-label="Listing">{listingLabel(o.listing)}</td>
                      <td data-label="Amount">{money(o.finalPrice)}</td>
                      <td data-label="Status">{o.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
