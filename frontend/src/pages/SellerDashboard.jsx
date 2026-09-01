import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

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
  const [listings, setListings] = useState([]);
  const [offersByListing, setOffersByListing] = useState({});
  const [inspectionsByListing, setInspectionsByListing] = useState({});
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('listings');
  const [toastMsg, setToastMsg] = useState('');
  const [selectedOffer, setSelectedOffer] = useState(null);
  const [transportTarget, setTransportTarget] = useState(null);

  const listingModalRef = useRef(null);
  const offerModalRef = useRef(null);
  const transportModalRef = useRef(null);

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
  const allInspections = listings.flatMap((l) => (inspectionsByListing[l.id] || []).map((r) => ({ ...r, listing: l })));
  const openOffers = allOffers.filter((o) => o.status === 'PENDING' || o.status === 'COUNTERED');
  const confirmedSales = orders.filter((o) => ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(o.status));
  const grossSales = confirmedSales.reduce((sum, o) => sum + o.finalPrice, 0);

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
        await api.patch(`/offers/${selectedOffer.id}`, { action });
        toast(action === 'ACCEPT' ? 'Offer accepted. Order created.' : 'Offer rejected.');
      }
      offerModalRef.current.close();
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Action failed');
    }
  }

  function openTransportModal(order, method) {
    setTransportTarget({ order, method });
    transportModalRef.current.showModal();
  }

  async function submitTransport(e) {
    e.preventDefault();
    if (!transportTarget) return;
    const d = new FormData(e.target);
    const partyMap = { Seller: 'SELLER', Buyer: 'BUYER', 'Joint-agreed': 'JOINT' };
    const method = transportTarget.method === 'hire' ? 'HIRE_TRANSPORTER' : 'OWN_TRUCK';
    try {
      await api.post('/transport', {
        orderId: transportTarget.order.id,
        arrangingParty: partyMap[d.get('party')] || 'SELLER',
        method,
        pickupLocation: transportTarget.order.listing?.location || 'Farm location',
        destination: d.get('destination'),
        load: transportTarget.order.listing?.cropType || 'Produce',
        specialRequirements: d.get('requirements') || undefined,
      });
      transportModalRef.current.close();
      toast('Transport record saved.');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not save transport record');
    }
  }

  return (
    <div className="sd-dashboard">
      <section id="overview">
        <span className="sd-eyebrow">SELLER / FARMER DASHBOARD</span>
        <h1>Your produce. Your price authority. Your transport choice.</h1>
        <p className="sd-muted" style={{ maxWidth: 780 }}>
          Manage listings, compare buyer offers, authorize inspectors and decide whether you or the buyer will arrange transport.
        </p>
        <div className="sd-actions">
          <button className="sd-btn sd-btn-primary" onClick={() => listingModalRef.current.showModal()}>+ Create Listing</button>
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
                        <td><Link to={`/listings/${l.id}`}><button className="sd-btn sd-btn-outline">View</button></Link></td>
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
                      <td>{!o.transportJob && <button className="sd-btn sd-btn-outline" onClick={() => openTransportModal(o, 'hire')}>Arrange</button>}</td>
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
                <h3>🚛 Use My Own Truck</h3>
                <p className="sd-muted">Record your own vehicle for an order without transport arranged yet.</p>
                {orders.filter((o) => !o.transportJob).map((o) => (
                  <button key={o.id} className="sd-btn sd-btn-outline" style={{ marginTop: 8, display: 'block' }} onClick={() => openTransportModal(o, 'own')}>{o.listing?.cropType} — {o.id.slice(0, 8)}</button>
                ))}
              </div>
              <div className="sd-panel">
                <h3>🚚 Hire Transport</h3>
                <p className="sd-muted">Create a request and select a registered truck owner.</p>
                {orders.filter((o) => !o.transportJob).map((o) => (
                  <button key={o.id} className="sd-btn sd-btn-primary" style={{ marginTop: 8, display: 'block' }} onClick={() => openTransportModal(o, 'hire')}>{o.listing?.cropType} — {o.id.slice(0, 8)}</button>
                ))}
              </div>
              <div className="sd-panel">
                <h3>🤝 Buyer Arranges</h3>
                <p className="sd-muted">Record that the buyer will handle transportation.</p>
                {orders.filter((o) => !o.transportJob).map((o) => (
                  <button key={o.id} className="sd-btn sd-btn-outline" style={{ marginTop: 8, display: 'block' }} onClick={() => openTransportModal(o, 'buyer')}>{o.listing?.cropType} — {o.id.slice(0, 8)}</button>
                ))}
              </div>
            </div>
            <div className="sd-panel" style={{ marginTop: 20 }}>
              {orders.filter((o) => o.transportJob).map((o) => (
                <div className="sd-notice" key={o.id} style={{ marginBottom: 10 }}>
                  <b>Order {o.id.slice(0, 8)}:</b> {o.transportJob.arrangingParty} arranging via {o.transportJob.method === 'OWN_TRUCK' ? 'own truck' : 'hired transporter'}. Status: {o.transportJob.status}.
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

      <dialog ref={transportModalRef} className="sd-dialog">
        <div className="sd-modal">
          <button className="sd-close" onClick={() => transportModalRef.current.close()}>×</button>
          <span className="sd-eyebrow">TRANSPORT</span>
          <h2>{transportTarget?.method === 'hire' ? 'Hire Transporter' : transportTarget?.method === 'own' ? 'Use My Own Truck' : 'Buyer Arranges'}</h2>
          <form onSubmit={submitTransport}>
            <div className="sd-form-grid">
              <div><label>Order</label><input value={transportTarget?.order?.id?.slice(0, 8) || ''} disabled /></div>
              <div><label>Arranging party</label>
                <select name="party" defaultValue="Seller">
                  <option>Seller</option><option>Buyer</option><option>Joint-agreed</option>
                </select>
              </div>
              <div><label>Destination</label><input name="destination" required placeholder="Buyer / delivery destination" /></div>
              <div><label>Capacity / truck type</label><input name="capacity" placeholder="e.g. 20t flatbed" /></div>
              <div className="sd-full"><label>Access / special requirements</label><textarea name="requirements" rows="3"></textarea></div>
            </div>
            <div className="sd-modal-actions" style={{ marginTop: 20 }}>
              <button className="sd-btn sd-btn-primary">Save Transport Record</button>
            </div>
          </form>
        </div>
      </dialog>

      {toastMsg && <div className="sd-toast">{toastMsg}</div>}
    </div>
  );
}
