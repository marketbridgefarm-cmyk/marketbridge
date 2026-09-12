import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';

const TABS = [
  { id: 'listings', label: 'My Listings' },
  { id: 'offers', label: 'Offers' },
  { id: 'orders', label: 'Orders' },
  { id: 'inspections', label: 'Inspections' },
  { id: 'earnings', label: 'Sales & Earnings' },
  { id: 'transport', label: 'Transport' },
];

export default function SellerDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [listings, setListings] = useState([]);
  const [offersByListing, setOffersByListing] = useState({});
  const [inspectionsByListing, setInspectionsByListing] = useState({});
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('listings');
  const [toastMsg, setToastMsg] = useState('');
  const [selectedOffer, setSelectedOffer] = useState(null);
  const [editingListing, setEditingListing] = useState(null);
  const [editKeepPhotos, setEditKeepPhotos] = useState([]); // [{ key, url }]
  const [editKeepVideos, setEditKeepVideos] = useState([]); // [{ key, url }]
  const [editNewPhotos, setEditNewPhotos] = useState([]); // [{ key, name, previewUrl }]
  const [editNewVideos, setEditNewVideos] = useState([]); // [{ key, name, previewUrl }]
  const [editMediaUploading, setEditMediaUploading] = useState(false);
  const [editMediaError, setEditMediaError] = useState('');

  const listingModalRef = useRef(null);
  const offerModalRef = useRef(null);
  const editModalRef = useRef(null);

  function toast(msg) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 2500);
  }

  async function loadAll() {
    const statuses = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];
    const results = await Promise.all(
      statuses.map((status) => api.get('/listings', { params: { status } }))
    );
    const mine = {};
    results.forEach((res) => {
      res.data.listings.forEach((l) => {
        if (l.sellerId === user.id) mine[l.id] = l;
      });
    });
    const myListings = Object.values(mine);
    setListings(myListings);

    const [offerResults, inspectionResults] = await Promise.all([
      Promise.all(myListings.map((l) => api.get(`/offers/listing/${l.id}`))),
      Promise.all(myListings.map((l) => api.get(`/listings/${l.id}`))),
    ]);
    const offersMap = {};
    myListings.forEach((l, i) => { offersMap[l.id] = offerResults[i].data.offers; });
    setOffersByListing(offersMap);

    const inspMap = {};
    myListings.forEach((l, i) => { inspMap[l.id] = inspectionResults[i].data.listing.inspectionRequests || []; });
    setInspectionsByListing(inspMap);

    const ordersRes = await api.get('/orders');
    setOrders(ordersRes.data.orders.filter((o) => o.sellerId === user.id));
  }

  useEffect(() => { loadAll(); }, []); // eslint-disable-line

  const allOffers = listings.flatMap((l) => (offersByListing[l.id] || []).map((o) => ({ ...o, listing: l })));
  // Always render the current leaf of each negotiation chain.
  // The previous root offer is historical and must not receive the action
  // buttons after a buyer counter-offer.
  const offerParentIds = new Set(allOffers.map((o) => o.parentOfferId).filter(Boolean));
  const latestOffers = allOffers.filter((o) => !offerParentIds.has(o.id));
  const allInspections = listings.flatMap((l) => (inspectionsByListing[l.id] || []).map((r) => ({ ...r, listing: l })));
  const openOffers = latestOffers.filter((o) => o.status === 'PENDING' || (o.status === 'COUNTERED' && o.counteredBy === 'BUYER'));
  const confirmedSales = orders.filter((o) => ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(o.status));
  const grossSales = confirmedSales.reduce((sum, o) => sum + o.finalPrice, 0);

  const activityItems = [
    ...latestOffers.map((o) => ({
      id: `offer-${o.id}`,
      icon: '💬',
      text: `${o.amount.toLocaleString()} ETB offer on ${o.listing?.cropType || o.listing?.title || 'your listing'}`,
      time: o.updatedAt || o.createdAt,
      href: `/listings/${o.listing?.id}`,
    })),
    ...orders.map((o) => ({
      id: `order-${o.id}`,
      icon: '📦',
      text: `Order for ${o.listing?.cropType || o.listing?.title || 'a listing'} is ${o.status.replaceAll('_', ' ').toLowerCase()}`,
      time: o.updatedAt || o.createdAt,
      href: `/orders/${o.id}`,
    })),
    ...allInspections.map((r) => ({
      id: `insp-${r.id}`,
      icon: '🔍',
      text: `Inspection for ${r.listing?.cropType || 'your listing'} ${r.status === 'COMPLETED' ? 'report is ready' : `is ${r.status.toLowerCase()}`}`,
      time: r.updatedAt || r.createdAt,
      href: `/listings/${r.listing?.id}`,
    })),
  ];

  async function submitListing(e) {
    e.preventDefault();
    const d = new FormData(e.target);
    try {
      await api.post('/listings', {
        sellerId: user.id,
        cropType: d.get('produce'),
        quantity: Number(d.get('quantity')),
        unit: d.get('unit') || 'quintal',
        askingPrice: Number(d.get('price')),
        minAcceptablePrice: d.get('minimum') ? Number(d.get('minimum')) : undefined,
        location: d.get('location'),
        readinessDate: d.get('date') || undefined,
      });
      listingModalRef.current.close();
      e.target.reset();
      toast('Listing published successfully.');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not publish listing');
    }
  }

  async function withdrawListing(listing) {
    if (!window.confirm(`Withdraw "${listing.cropType}"? Buyers will no longer be able to see or offer on this listing.`)) return;
    try {
      await api.patch(`/listings/${listing.id}`, { status: 'CANCELLED' });
      toast('Listing withdrawn.');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not withdraw listing');
    }
  }

  async function cancelOrder(order) {
    if (!window.confirm('Cancel this order? This cannot be undone. The listing will become available again and any completed payments will be flagged for refund.')) return;
    try {
      await api.patch(`/orders/${order.id}/cancel`);
      toast('Order cancelled.');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not cancel order');
    }
  }

  function openEditModal(listing) {
    setEditingListing(listing);
    setEditKeepPhotos((listing.photoKeys || []).map((key, i) => ({ key, url: listing.photos?.[i] })));
    setEditKeepVideos((listing.videoKeys || []).map((key, i) => ({ key, url: listing.videos?.[i] })));
    setEditNewPhotos([]);
    setEditNewVideos([]);
    setEditMediaError('');
    editModalRef.current.showModal();
  }

  async function handleEditMediaSelect(kind, e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later
    if (!files.length) return;

    setEditMediaError('');
    setEditMediaUploading(true);
    try {
      const body = new FormData();
      files.forEach(f => body.append('files', f));
      const { data } = await api.post('/listings/media', body);
      const keys = kind === 'photo' ? data.photoKeys : data.videoKeys;
      const items = files.map((f, i) => ({
        key: keys[i],
        name: f.name,
        previewUrl: URL.createObjectURL(f)
      })).filter(item => item.key);
      if (kind === 'photo') setEditNewPhotos(prev => [...prev, ...items]);
      else setEditNewVideos(prev => [...prev, ...items]);
    } catch (err) {
      setEditMediaError(err.response?.data?.error || `Could not upload ${kind === 'photo' ? 'photo' : 'video'}. Try a smaller file.`);
    } finally {
      setEditMediaUploading(false);
    }
  }

  function removeEditKeepMedia(kind, index) {
    if (kind === 'photo') setEditKeepPhotos(prev => prev.filter((_, i) => i !== index));
    else setEditKeepVideos(prev => prev.filter((_, i) => i !== index));
  }

  function removeEditNewMedia(kind, index) {
    const setter = kind === 'photo' ? setEditNewPhotos : setEditNewVideos;
    setter(prev => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function submitEditListing(e) {
    e.preventDefault();
    if (!editingListing) return;
    const d = new FormData(e.target);
    try {
      await api.patch(`/listings/${editingListing.id}`, {
        askingPrice: Number(d.get('price')),
        minAcceptablePrice: d.get('minimum') ? Number(d.get('minimum')) : null,
        quantity: Number(d.get('quantity')),
        readinessDate: d.get('date') || undefined,
        photos: [...editKeepPhotos.map(p => p.key), ...editNewPhotos.map(p => p.key)],
        videos: [...editKeepVideos.map(v => v.key), ...editNewVideos.map(v => v.key)],
      });
      editModalRef.current.close();
      setEditingListing(null);
      toast('Listing updated.');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not update listing');
    }
  }

  function openOfferModal(offer) {
    setSelectedOffer(offer);
    offerModalRef.current.showModal();
  }

  async function respondOffer(action) {
    if (!selectedOffer) return;
    try {
      if (action === 'COUNTER') {
        const v = prompt('Enter your counteroffer amount (ETB):');
        if (!v) return;
        await api.patch(`/offers/${selectedOffer.id}`, { action: 'COUNTER', counterAmount: Number(v) });
        toast('Counteroffer sent: ' + Number(v).toLocaleString() + ' ETB');
      } else {
        const response = await api.patch(`/offers/${selectedOffer.id}`, { action });
        if (action === 'ACCEPT' && response.data?.order?.id) {
          offerModalRef.current.close();
          toast('Offer accepted. Opening the new order…');
          await loadAll();
          navigate(`/orders/${response.data.order.id}`);
          return;
        }
        toast(action === 'ACCEPT' ? 'Offer accepted. Order created.' : 'Offer rejected.');
      }
      offerModalRef.current.close();
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Action failed');
    }
  }

  return (
    <div className="sd-dashboard">
      <section id="overview">
        <DashboardWelcome user={user} subtitle="Manage listings, compare buyer offers, and decide who arranges transport." />
        <span className="sd-eyebrow">SELLER / FARMER DASHBOARD</span>
        <h1>Your produce. Your price authority. Your transport choice.</h1>
        <p className="sd-muted" style={{ maxWidth: 780 }}>
          Manage listings, compare buyer offers, authorize inspectors and decide whether you or the buyer will arrange transport.
        </p>
        <RoleSwitchCTA current="SELLER" />
        <RecentActivity items={activityItems} emptyText="No offers, orders, or inspection updates yet." />
        <div className="sd-actions">
          <button className="sd-btn sd-btn-primary" onClick={() => listingModalRef.current.showModal()}>+ Create Listing</button>
          <button className="sd-btn sd-btn-outline" onClick={() => setActiveTab('orders')}>Orders</button>
          <button className="sd-btn sd-btn-outline" onClick={() => setActiveTab('transport')}>Transport</button>
          <button className="sd-btn sd-btn-outline" onClick={() => setActiveTab('offers')}>Offers</button>
          <button className="sd-btn sd-btn-outline" onClick={() => setActiveTab('inspections')}>Inspections</button>
        </div>
        <div className="sd-stat-grid">
          <div className="sd-stat"><span>ACTIVE LISTINGS</span><b>{listings.filter((l) => l.status === 'ACTIVE').length}</b></div>
          <div className="sd-stat"><span>OPEN OFFERS</span><b>{openOffers.length}</b></div>
          <div className="sd-stat"><span>CONFIRMED SALES</span><b>{confirmedSales.length}</b></div>
          <div className="sd-stat"><span>GROSS SALES (ETB)</span><b>{grossSales.toLocaleString()}</b></div>
        </div>
      </section>

      <section id="workspace">
        <div className="sd-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`sd-tab ${activeTab === t.id ? 'sd-active' : ''}`} onClick={() => setActiveTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {activeTab === 'listings' && (
          <div>
            <div className="sd-toolbar">
              <div><span className="sd-eyebrow">LISTINGS</span><h2>My active produce</h2></div>
              <button className="sd-btn sd-btn-primary" onClick={() => listingModalRef.current.showModal()}>+ Create Listing</button>
            </div>
            <div className="sd-panel sd-table-wrap">
              <table className="sd-table">
                <thead><tr><th>Produce</th><th>Quantity</th><th>Asking</th><th>Best offer</th><th>Inspection</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {listings.map((l) => {
                    const offers = offersByListing[l.id] || [];
                    const best = offers.reduce((max, o) => (o.amount > (max?.amount || 0) ? o : max), null);
                    const insp = inspectionsByListing[l.id] || [];
                    const latestInsp = insp[0];
                    return (
                      <tr key={l.id}>
                        <td>{l.cropType}</td>
                        <td>{l.quantity} {l.unit}</td>
                        <td>{l.askingPrice.toLocaleString()} ETB</td>
                        <td>{best ? best.amount.toLocaleString() + ' ETB' : '—'}</td>
                        <td>{latestInsp ? <span className={`sd-badge ${latestInsp.status === 'COMPLETED' ? '' : 'sd-warn'}`}>{latestInsp.status === 'COMPLETED' ? 'Verified' : latestInsp.status}</span> : <span className="sd-badge sd-warn">Not requested</span>}</td>
                        <td><span className="sd-badge">{l.status}</span></td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Link to={`/listings/${l.id}`}><button className="sd-btn sd-btn-outline">View</button></Link>
                            {l.status === 'ACTIVE' && (
                              <>
                                <button className="sd-btn sd-btn-outline" onClick={() => openEditModal(l)}>Edit</button>
                                <button className="sd-btn sd-btn-outline" onClick={() => withdrawListing(l)}>Withdraw</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {listings.length === 0 && <tr><td colSpan="7">No listings yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'offers' && (
          <div>
            <div className="sd-toolbar"><div><span className="sd-eyebrow">BUYER INTEREST</span><h2>Offers & negotiations</h2></div></div>
            <div className="sd-cards">
              {openOffers.map((o) => (
                <div className="sd-card" key={o.id}>
                  <h3>{o.listing.cropType}</h3>
                  <p>Offer: <b>{o.amount.toLocaleString()} ETB</b></p>
                  <p className="sd-muted">{o.listing.quantity} {o.listing.unit} · From {o.buyer?.name || 'buyer'}</p>
                  <button className="sd-btn sd-btn-primary" onClick={() => openOfferModal(o)}>Review offer</button>
                </div>
              ))}
              {openOffers.length === 0 && <p>No open offers.</p>}
            </div>
          </div>
        )}

        {activeTab === 'orders' && (
          <div>
            <div className="sd-toolbar"><div><span className="sd-eyebrow">ORDERS</span><h2>Confirmed sales</h2></div></div>
            <div className="sd-panel sd-table-wrap">
              <table className="sd-table">
                <thead><tr><th>Order</th><th>Produce</th><th>Buyer</th><th>Value</th><th>Transport</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td>{o.id.slice(0, 8)}</td>
                      <td>{o.listing?.cropType}</td>
                      <td>{o.buyer?.name || '—'}</td>
                      <td>{o.finalPrice.toLocaleString()} ETB</td>
                      <td>{o.transportJob ? `${o.transportJob.arrangingParty} — ${o.transportJob.method === 'OWN_TRUCK' ? 'Own Truck' : 'Hire Transport'}` : '—'}</td>
                      <td><span className="sd-badge sd-blue">{o.status}</span></td>
                      <td><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link to={`/orders/${o.id}`} className="sd-btn sd-btn-primary">{!o.transportJob ? 'Open order / arrange' : o.transportJob.status === 'REQUESTED' || o.transportJob.status === 'QUOTED' ? 'Review transport' : 'Open order / continue'}</Link>{!o.transportJob && <Link to={`/orders/${o.id}/transport`} className="sd-btn sd-btn-outline">Arrange transport</Link>}{['PENDING_PAYMENT', 'CONFIRMED'].includes(o.status) && !(o.transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(o.transportJob.status)) && <button type="button" className="sd-btn sd-btn-outline" onClick={() => cancelOrder(o)}>Cancel order</button>}</div></td>
                    </tr>
                  ))}
                  {orders.length === 0 && <tr><td colSpan="7">No orders yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'inspections' && (
          <div>
            <div className="sd-toolbar"><div><span className="sd-eyebrow">INSPECTIONS</span><h2>Inspection requests & reports</h2></div></div>
            <div className="sd-cards">
              {allInspections.map((r) => (
                <div className="sd-card" key={r.id}>
                  <h3>{r.listing.cropType}</h3>
                  <span className={`sd-badge ${r.status === 'COMPLETED' ? '' : 'sd-warn'}`}>{r.status === 'COMPLETED' ? 'Verified' : r.status}</span>
                  <p className="sd-muted">{r.status === 'COMPLETED' ? 'Quantity and quality evidence published.' : 'Waiting for inspector.'}</p>
                  <Link to={`/listings/${r.listing.id}`}><button className="sd-btn sd-btn-outline">{r.status === 'COMPLETED' ? 'View report' : 'Track request'}</button></Link>
                </div>
              ))}
              {allInspections.length === 0 && <p>No inspection activity yet.</p>}
            </div>
          </div>
        )}

        {activeTab === 'earnings' && (
          <div>
            <div className="sd-toolbar"><div><span className="sd-eyebrow">SALES</span><h2>Sales & earnings</h2></div></div>
            <div className="sd-stat-grid">
              <div className="sd-stat"><span>GROSS SALES</span><b>{grossSales.toLocaleString()} ETB</b></div>
              <div className="sd-stat"><span>CONFIRMED ORDERS</span><b>{confirmedSales.length}</b></div>
              <div className="sd-stat"><span>OPEN OFFERS</span><b>{openOffers.length}</b></div>
              <div className="sd-stat"><span>ACTIVE LISTINGS</span><b>{listings.filter((l) => l.status === 'ACTIVE').length}</b></div>
            </div>
            <div className="sd-panel" style={{ marginTop: 20 }}>
              <h3>Price decision support</h3>
              <p className="sd-muted">Estimated farmer net revenue = buyer offer − transport cost − inspection cost − platform fees.</p>
            </div>
          </div>
        )}

        {activeTab === 'transport' && (
          <div>
            <div className="sd-toolbar"><div><span className="sd-eyebrow">TRANSPORT</span><h2>Seller-controlled transport options</h2></div></div>
            <div className="sd-flow">
              <div className="sd-panel">
                <h3>🚛 Arrange transport</h3>
                <p className="sd-muted">Use your own truck, or hire a registered transporter — choose on the next screen.</p>
                {orders.filter((o) => !o.transportJob).map((o) => (
                  <Link key={o.id} className="sd-btn sd-btn-primary" style={{ marginTop: 8, display: 'block' }} to={`/orders/${o.id}/transport`}>{o.listing?.cropType} — {o.id.slice(0, 8)}</Link>
                ))}
                {orders.filter((o) => !o.transportJob).length === 0 && <p className="sd-muted">No orders currently need transport arranged.</p>}
              </div>
              <div className="sd-panel">
                <h3>🤝 Buyer arranges</h3>
                <p className="sd-muted">If the buyer is handling transport themselves, they can arrange it from their own order view — no action needed here. It'll show up below once recorded.</p>
              </div>
            </div>
            <div className="sd-panel" style={{ marginTop: 20 }}>
              {orders.filter((o) => o.transportJob).map((o) => (
                <div className="sd-notice" key={o.id} style={{ marginBottom: 10 }}>
                  <b>Order {o.id.slice(0, 8)}:</b> {o.transportJob.arrangingParty} arranging via {o.transportJob.method === 'OWN_TRUCK' ? 'own truck' : 'hired transporter'}. Status: {o.transportJob.status}.
                  <div className="sd-actions" style={{ marginTop: 10 }}>
                    <Link to={`/orders/${o.id}`} className="sd-btn sd-btn-primary">Open order / continue</Link>
                    {o.transportJob.arrangingParty === 'SELLER' && ['REQUESTED','QUOTED'].includes(o.transportJob.status) && !o.transportJob.truckOwnerId && <Link to={`/orders/${o.id}`} className="sd-btn sd-btn-outline">Choose transporter</Link>}
                  </div>
                </div>
              ))}
              {orders.filter((o) => o.transportJob).length === 0 && <p>No transport records yet.</p>}
            </div>
          </div>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="sd-workspace">
          <div className="sd-panel">
            <span className="sd-eyebrow">FARMER PROTECTION</span>
            <h2>Price authority stays with you.</h2>
            <div className="sd-notice"><b>Seller-controlled price.</b><br /><br />An inspector may help create a listing only with farmer authorization and cannot secretly reduce or change the farmer's asking or minimum acceptable price.</div>
          </div>
          <div className="sd-panel">
            <span className="sd-eyebrow">ROLE SEPARATION</span>
            <h3>MarketBridge is the facilitator.</h3>
            <p className="sd-muted">The platform connects parties, facilitates matching, communication, verification workflows and records. It does not become owner, seller, buyer, carrier or inspector.</p>
          </div>
        </div>
      </section>

      <dialog ref={listingModalRef} className="sd-dialog">
        <div className="sd-modal">
          <button className="sd-close" onClick={() => listingModalRef.current.close()}>×</button>
          <span className="sd-eyebrow">CREATE LISTING</span>
          <h2>List your agricultural produce</h2>
          <form onSubmit={submitListing}>
            <div className="sd-form-grid">
              <div><label>Produce</label><input name="produce" required placeholder="Potatoes Grade A" /></div>
              <div><label>Quantity</label><input name="quantity" type="number" required /></div>
              <div><label>Unit</label><input name="unit" defaultValue="quintal" /></div>
              <div><label>Asking price (ETB)</label><input name="price" type="number" required /></div>
              <div><label>Minimum acceptable price</label><input name="minimum" type="number" /></div>
              <div><label>Farm / pickup location</label><input name="location" required /></div>
              <div><label>Readiness date</label><input name="date" type="date" /></div>
            </div>
            <div className="sd-modal-actions" style={{ marginTop: 20 }}>
              <button className="sd-btn sd-btn-primary">Publish Listing</button>
              <button type="button" className="sd-btn sd-btn-outline" onClick={() => listingModalRef.current.close()}>Cancel</button>
            </div>
          </form>
        </div>
      </dialog>

      <dialog ref={editModalRef} className="sd-dialog">
        <div className="sd-modal">
          <button className="sd-close" onClick={() => { editModalRef.current.close(); setEditingListing(null); }}>×</button>
          <span className="sd-eyebrow">EDIT LISTING</span>
          <h2>Update {editingListing?.cropType || 'listing'}</h2>
          {editingListing && (
            <form onSubmit={submitEditListing}>
              <div className="sd-form-grid">
                <div><label>Quantity ({editingListing.unit})</label><input name="quantity" type="number" defaultValue={editingListing.quantity} required /></div>
                <div><label>Asking price (ETB)</label><input name="price" type="number" defaultValue={editingListing.askingPrice} required /></div>
                <div><label>Minimum acceptable price</label><input name="minimum" type="number" defaultValue={editingListing.minAcceptablePrice ?? ''} /></div>
                <div><label>Readiness date</label><input name="date" type="date" defaultValue={editingListing.readinessDate ? editingListing.readinessDate.slice(0, 10) : ''} /></div>
              </div>
              <div className="sd-notice" style={{ marginTop: 12 }}>Buyers who already made an offer will still see their original offer amount — this only changes your public asking price going forward.</div>

              {editMediaError && <div className="alert error">{editMediaError}</div>}

              <label style={{ marginTop: 12, display: 'block' }}>Photos</label>
              {(editKeepPhotos.length > 0 || editNewPhotos.length > 0) && (
                <div className="media-preview-grid">
                  {editKeepPhotos.map((p, i) => (
                    <div className="media-preview-item" key={`keep-photo-${p.key}`}>
                      <img src={p.url} alt="" />
                      <button type="button" className="media-preview-remove" onClick={() => removeEditKeepMedia('photo', i)}>×</button>
                    </div>
                  ))}
                  {editNewPhotos.map((p, i) => (
                    <div className="media-preview-item" key={`new-photo-${p.key}`}>
                      <img src={p.previewUrl} alt={p.name} />
                      <button type="button" className="media-preview-remove" onClick={() => removeEditNewMedia('photo', i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <input type="file" accept="image/*" multiple onChange={e => handleEditMediaSelect('photo', e)} disabled={editMediaUploading} />

              <label style={{ marginTop: 12, display: 'block' }}>Short videos</label>
              {(editKeepVideos.length > 0 || editNewVideos.length > 0) && (
                <div className="media-preview-grid">
                  {editKeepVideos.map((v, i) => (
                    <div className="media-preview-item" key={`keep-video-${v.key}`}>
                      <video src={v.url} muted />
                      <button type="button" className="media-preview-remove" onClick={() => removeEditKeepMedia('video', i)}>×</button>
                    </div>
                  ))}
                  {editNewVideos.map((v, i) => (
                    <div className="media-preview-item" key={`new-video-${v.key}`}>
                      <video src={v.previewUrl} muted />
                      <button type="button" className="media-preview-remove" onClick={() => removeEditNewMedia('video', i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <input type="file" accept="video/*" multiple onChange={e => handleEditMediaSelect('video', e)} disabled={editMediaUploading} />

              {editMediaUploading && <p className="muted">Uploading media…</p>}

              <div className="sd-modal-actions" style={{ marginTop: 20 }}>
                <button className="sd-btn sd-btn-primary" disabled={editMediaUploading}>Save changes</button>
                <button type="button" className="sd-btn sd-btn-outline" onClick={() => { editModalRef.current.close(); setEditingListing(null); }}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      </dialog>

      <dialog ref={offerModalRef} className="sd-dialog">
        <div className="sd-modal">
          <button className="sd-close" onClick={() => offerModalRef.current.close()}>×</button>
          <span className="sd-eyebrow">NEGOTIATION</span>
          <h2>Review buyer offer</h2>
          <p>Current offer: <b>{selectedOffer?.amount?.toLocaleString() || '—'}</b> ETB</p>
          <div className="sd-notice">You retain the decision to accept, reject or counteroffer.</div>
          <div className="sd-modal-actions" style={{ marginTop: 20 }}>
            <button className="sd-btn sd-btn-primary" onClick={() => respondOffer('ACCEPT')}>Accept</button>
            <button className="sd-btn sd-btn-outline" onClick={() => respondOffer('COUNTER')}>Counteroffer</button>
            <button className="sd-btn sd-btn-outline" onClick={() => respondOffer('REJECT')}>Reject</button>
          </div>
        </div>
      </dialog>

      {toastMsg && <div className="sd-toast">{toastMsg}</div>}
    </div>
  );
}
