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
  const [form, setForm] = useState({ pickupLocation: '', destination: '', load: '', requiredCapacity: '', specialRequirements: '', loadingAt: '' });
  const [matches, setMatches] = useState([]);
  const [truck, setTruck] = useState('');
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/transport/trucks/mine').then(r => setOwnTrucks(r.data.trucks || [])).catch(() => {});
    api.get(`/orders/${orderId}`).then(r => {
      setOrder(r.data.order);
      setForm(f => ({ ...f, pickupLocation: r.data.order.listing?.location || '', destination: r.data.order.buyer?.location || '' }));
    });
  }, [orderId]);

  const [party, setParty] = useState('BUYER');

  useEffect(() => {
    if (order && user?.id === order.sellerId) setParty('SELLER');
    else if (order && user?.id === order.buyerId) setParty('BUYER');
  }, [order, user]);

  async function find() {
    try { const r = await api.get('/transport/match', { params: { minCapacity: form.requiredCapacity, area: form.pickupLocation } }); setMatches(r.data.trucks || []); }
    catch (e) { setError('Could not find matching transporters.'); }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (method === 'OWN_TRUCK' && party === 'JOINT') return setError('Joint arrangements must use a hired transporter.');
    if (method === 'OWN_TRUCK' && !truck) return setError('Select one of your available trucks.');
    try {
      await api.post('/transport', {
        orderId, arrangingParty: party, method,
        truckId: method === 'OWN_TRUCK' ? truck : undefined,
        pickupLocation: form.pickupLocation, destination: form.destination, load: form.load,
        requiredCapacity: form.requiredCapacity ? Number(form.requiredCapacity) : undefined,
        specialRequirements: form.specialRequirements
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
        <p className="lead">Choose who will take responsibility for transport. Transport is not automatically assigned.</p>
        <div className="choice-grid" style={{ marginBottom: 16 }}>
          {['BUYER', 'SELLER', 'JOINT'].filter(p => p !== 'SELLER' || user?.id === order.sellerId).filter(p => p !== 'BUYER' || user?.id === order.buyerId).map(p => (
            <button key={p} type="button" className={`choice ${party === p ? 'selected' : ''}`} onClick={() => { setParty(p); if (p === 'JOINT') setMethod('HIRE_TRANSPORTER'); }}>
              <b>{p === 'BUYER' ? 'Buyer arranges' : p === 'SELLER' ? 'Seller arranges' : 'Joint arrangement'}</b>
              <span>{p === 'JOINT' ? 'Buyer and seller agree together; use a hired transporter.' : `The ${p.toLowerCase()} controls the transport arrangement.`}</span>
            </button>
          ))}
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="choice-grid">
          <button type="button" disabled={party === 'JOINT'} className={`choice ${method === 'OWN_TRUCK' ? 'selected' : ''}`} onClick={() => setMethod('OWN_TRUCK')}><b>🚚 Use my own truck</b><span>Record your own legally permitted vehicle and pickup details. No transport-hiring commission.</span></button>
          <button type="button" className={`choice ${method === 'HIRE_TRANSPORTER' ? 'selected' : ''}`} onClick={() => setMethod('HIRE_TRANSPORTER')}><b>Hire a registered transporter</b><span>MarketBridge matches by capacity, area, route, availability, rating and verification.</span></button>
        </div>
        <form className="card form-card" onSubmit={submit}>
          <div className="notice"><strong>Role separation:</strong> Inspectors verify produce and evidence; they do not arrange trucks.</div>
          <div className="form-grid">
            <div><label>Pickup farm / location</label><input required value={form.pickupLocation} onChange={e => setForm({ ...form, pickupLocation: e.target.value })} /></div>
            <div><label>Destination</label><input required value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })} /></div>
            <div><label>Load</label><input required value={form.load} onChange={e => setForm({ ...form, load: e.target.value })} /></div>
            <div><label>Required capacity (tons)</label><input type="number" value={form.requiredCapacity} onChange={e => setForm({ ...form, requiredCapacity: e.target.value })} /></div>
            <div><label>Loading date/time</label><input type="datetime-local" value={form.loadingAt} onChange={e => setForm({ ...form, loadingAt: e.target.value })} /></div>
            <div><label>Special requirements</label><input value={form.specialRequirements} onChange={e => setForm({ ...form, specialRequirements: e.target.value })} placeholder="Access, loading, route..." /></div>
          </div>
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
