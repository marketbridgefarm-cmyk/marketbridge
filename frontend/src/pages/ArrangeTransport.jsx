import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

export default function ArrangeTransport() {
  const { orderId } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [order, setOrder] = useState(null);
  const [method, setMethod] = useState('OWN_TRUCK');
  const [form, setForm] = useState({ pickupLocation: '', destination: '', load: '', requiredCapacity: '', specialRequirements: '', loadingAt: '', weight: '', packageCount: '', vehicleType: '', loadingHelp: '', unloadingHelp: '', handling: [], deliveryDeadline: '', proofOfDelivery: true });
  const [matches, setMatches] = useState([]);
  const [truck, setTruck] = useState('');
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [error, setError] = useState('');
  const [arrangingParty, setArrangingParty] = useState('');

  useEffect(() => {
    api.get('/transport/trucks/mine').then(r => setOwnTrucks(r.data.trucks || [])).catch(() => {});
    api.get(`/orders/${orderId}`).then(r => {
      setOrder(r.data.order);
      setForm(f => ({ ...f, pickupLocation: r.data.order.listing?.location || '', destination: r.data.order.buyer?.location || '' }));
    });
  }, [orderId]);

  const canSeller = Boolean(order && user?.id === order.sellerId);
  const canBuyer = Boolean(order && user?.id === order.buyerId);
  const isPhysicalGoods = ['AGRICULTURAL', 'PRODUCT'].includes(order?.listing?.category);
  const party = isPhysicalGoods ? 'BUYER' : (arrangingParty || (canSeller ? 'SELLER' : canBuyer ? 'BUYER' : ''));

  async function find() {
    try { const r = await api.get('/transport/match', { params: { minCapacity: form.requiredCapacity, area: form.pickupLocation } }); setMatches(r.data.trucks || []); }
    catch (e) { setError('Could not find matching transporters.'); }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!party) return setError('Select who will arrange transport.');
    if (method === 'OWN_TRUCK' && party === 'JOINT') return setError('Joint arrangements must use a hired transporter.');
    if (method === 'OWN_TRUCK' && !truck) return setError('Select one of your available trucks.');
    try {
      await api.post('/transport', {
        orderId, arrangingParty: party, method,
        truckId: method === 'OWN_TRUCK' ? truck : undefined,
        pickupLocation: form.pickupLocation, destination: form.destination, load: form.load,
        requiredCapacity: form.requiredCapacity ? Number(form.requiredCapacity) : undefined,
        specialRequirements: form.specialRequirements,
        workDetails: { weight: form.weight, packageCount: form.packageCount, vehicleType: form.vehicleType, loadingHelp: form.loadingHelp, unloadingHelp: form.unloadingHelp, handling: form.handling, deliveryDeadline: form.deliveryDeadline, proofOfDelivery: form.proofOfDelivery }
      });
      nav(`/orders/${orderId}`);
    } catch (e) { setError(e.response?.data?.error || 'Could not arrange transport'); }
  }

  if (!order) return <main className="section"><div className="container-narrow loading">Loading order…</div></main>;

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">TRANSPORT</span>
        <h1>Choose how transport is handled.</h1>
        <p className="lead">For physical-goods orders, the buyer opens the transport request and registered truck owners compete with sealed quotes. The buyer selects one bid for negotiation and accepts the final agreed quote.</p>
        {!isPhysicalGoods ? (
          <div className="choice-grid" style={{ marginBottom: 16 }}>
            {canBuyer && <button type="button" className={`choice ${party === 'BUYER' ? 'selected' : ''}`} onClick={() => setArrangingParty('BUYER')}><b>Buyer arranges</b><span>Buyer controls the transport request and quote selection.</span></button>}
            {canSeller && <button type="button" className={`choice ${party === 'SELLER' ? 'selected' : ''}`} onClick={() => setArrangingParty('SELLER')}><b>Seller arranges</b><span>Seller controls the transport request and quote selection.</span></button>}
            {canBuyer && canSeller && <button type="button" className={`choice ${party === 'JOINT' ? 'selected' : ''}`} onClick={() => { setArrangingParty('JOINT'); if (method === 'OWN_TRUCK') setMethod('HIRE_TRANSPORTER'); }}><b>Joint arrangement</b><span>Buyer and seller jointly agree; hired transporter only.</span></button>}
          </div>
        ) : (
          <div className="notice" style={{ marginBottom: 16 }}><strong>Buyer-controlled competition:</strong> registered truck owners can submit competing quotes. Their bids stay sealed from other truck owners; the buyer selects one bid to negotiate.</div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="choice-grid">
          <button disabled={party === 'JOINT' || isAgricultural} className={`choice ${method === 'OWN_TRUCK' ? 'selected' : ''}`} onClick={() => setMethod('OWN_TRUCK')}><b>🚚 Use my own truck</b><span>{isPhysicalGoods ? 'Physical-goods orders use competitive hired transport in this workflow.' : 'Record your own legally permitted vehicle and pickup details. No transport-hiring commission.'}</span></button>
          <button className={`choice ${method === 'HIRE_TRANSPORTER' ? 'selected' : ''}`} onClick={() => setMethod('HIRE_TRANSPORTER')}><b>Hire a registered transporter</b><span>MarketBridge matches by capacity, area, route, availability, rating and verification.</span></button>
        </div>
        <form className="card form-card" onSubmit={submit}>
          <div className="notice"><strong>Role separation:</strong> Inspectors verify produce and evidence; they do not arrange trucks.</div>
          <div className="form-grid">
            <div><label>Pickup farm / location</label><input required value={form.pickupLocation} onChange={e => setForm({ ...form, pickupLocation: e.target.value })} /></div>
            <div><label>Destination</label><input required value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })} /></div>
            <div><label>Load</label><input required value={form.load} onChange={e => setForm({ ...form, load: e.target.value })} /></div>
            <div><label>Required capacity (tons)</label><input type="number" value={form.requiredCapacity} onChange={e => setForm({ ...form, requiredCapacity: e.target.value })} /></div>
            <div><label>Loading date/time</label><input type="datetime-local" value={form.loadingAt} onChange={e => setForm({ ...form, loadingAt: e.target.value })} /></div>
            <div><label>Special requirements / route constraints</label><input value={form.specialRequirements} onChange={e => setForm({ ...form, specialRequirements: e.target.value })} placeholder="Road access, stops, restrictions..." /></div>
            <div><label>Estimated load weight</label><input value={form.weight} onChange={e => setForm({ ...form, weight: e.target.value })} placeholder="e.g. 2.5 tonnes" /></div>
            <div><label>Number of packages / crates</label><input type="number" min="1" value={form.packageCount} onChange={e => setForm({ ...form, packageCount: e.target.value })} /></div>
            <div><label>Vehicle type requested</label><select value={form.vehicleType} onChange={e => setForm({ ...form, vehicleType: e.target.value })}><option value="">Provider recommends</option><option value="PICKUP">Pickup</option><option value="SMALL_TRUCK">Small truck</option><option value="MEDIUM_TRUCK">Medium truck</option><option value="LARGE_TRUCK">Large truck</option><option value="REFRIGERATED_TRUCK">Refrigerated truck</option></select></div>
            <div><label>Loading help required</label><select value={form.loadingHelp} onChange={e => setForm({ ...form, loadingHelp: e.target.value })}><option value="">Not specified</option><option value="SENDER">Sender provides labor</option><option value="TRANSPORTER">Transporter provides labor</option><option value="SHARED">Shared responsibility</option></select></div>
            <div><label>Unloading help required</label><select value={form.unloadingHelp} onChange={e => setForm({ ...form, unloadingHelp: e.target.value })}><option value="">Not specified</option><option value="RECEIVER">Receiver provides labor</option><option value="TRANSPORTER">Transporter provides labor</option><option value="SHARED">Shared responsibility</option></select></div>
            <div><label>Required delivery deadline</label><input type="datetime-local" value={form.deliveryDeadline} onChange={e => setForm({ ...form, deliveryDeadline: e.target.value })} /></div>
          </div>
          <fieldset className="form-card"><legend>Handling requirements</legend><div className="choice-grid">{[['COVERED','Covered truck'],['REFRIGERATED','Temperature controlled'],['FRAGILE','Careful / fragile handling'],['KEEP_DRY','Keep load dry'],['FOOD_SAFE','Food-safe vehicle']].map(([v, label]) => <label key={v}><input type="checkbox" checked={form.handling.includes(v)} onChange={e => setForm({ ...form, handling: e.target.checked ? [...form.handling, v] : form.handling.filter(x => x !== v) })} /> {label}</label>)}</div><label><input type="checkbox" checked={form.proofOfDelivery} onChange={e => setForm({ ...form, proofOfDelivery: e.target.checked })} /> Require delivery confirmation / proof</label></fieldset>
          {method === 'OWN_TRUCK' && (
            <div className="match-box">
              <div className="row-between"><h3>My available trucks</h3></div>
              {ownTrucks.filter(t => t.availability === 'AVAILABLE').map(t => (
                <div className={`transporter ${truck === t.id ? 'chosen' : ''}`} key={t.id}>
                  <div><strong>{t.registration}</strong><p>{t.truckType} · {t.capacity}t · {t.operatingArea}</p></div>
                  <button type="button" className="btn btn-sm" onClick={() => setTruck(t.id)}>{truck === t.id ? 'Selected' : 'Select'}</button>
                </div>
              ))}
              {!ownTrucks.filter(t => t.availability === 'AVAILABLE').length && <p className="muted">No available truck is registered to your account.</p>}
            </div>
          )}
          {method === 'HIRE_TRANSPORTER' && (
            <div className="match-box">
              <div className="row-between"><h3>Registered transporters</h3><button type="button" className="btn btn-light" onClick={find}>Find matches</button></div>
              {matches.map(t => (
                <div className={`transporter ${truck === t.owner.id ? 'chosen' : ''}`} key={t.id}>
                  <div><strong>{t.owner.name}</strong><p>{t.truckType} · {t.capacity}t · {t.operatingArea} · ★ {t.owner.rating?.toFixed?.(1) || '—'}</p></div>
                  <span className="sd-badge sd-blue">Quote later</span>
                </div>
              ))}
              {!matches.length && <p className="muted">Enter your details and select “Find matches”.</p>}
            </div>
          )}
          <button className="btn btn-primary btn-lg full" type="submit">{method === 'HIRE_TRANSPORTER' ? 'Create transport request' : 'Confirm own-truck arrangement'}</button>
        </form>
      </div>
    </main>
  );
}
