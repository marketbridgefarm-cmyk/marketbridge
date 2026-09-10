import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const PARTY_OPTIONS = [
  { value: 'BUYER', label: 'Buyer arranges' },
  { value: 'SELLER', label: 'Seller arranges' },
  { value: 'JOINT', label: 'Buyer + Seller jointly arrange' },
];

export default function ArrangeTransport() {
  const { orderId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [order, setOrder] = useState(null);
  const [arrangingParty, setArrangingParty] = useState('BUYER');
  const [method, setMethod] = useState('HIRE_TRANSPORTER');
  const [form, setForm] = useState({
    pickupLocation: '',
    destination: '',
    load: '',
    requiredCapacity: '',
    specialRequirements: '',
  });
  const [matches, setMatches] = useState([]);
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [selectedTruck, setSelectedTruck] = useState('');
  const [loading, setLoading] = useState(true);
  const [finding, setFinding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isBuyer = user?.id === order?.buyerId;
  const isSeller = user?.id === order?.sellerId;

  const allowedParties = useMemo(
    () => PARTY_OPTIONS.filter((party) =>
      party.value === 'BUYER'
        ? isBuyer
        : party.value === 'SELLER'
          ? isSeller
          : isBuyer || isSeller
    ),
    [isBuyer, isSeller]
  );

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const orderResponse = await api.get(`/orders/${orderId}`);
        if (!active) return;
        const nextOrder = orderResponse.data?.order;
        setOrder(nextOrder);

        if (nextOrder?.transportJob) {
          navigate(`/orders/${orderId}`, { replace: true });
          return;
        }

        const nextParty =
          nextOrder?.buyerId === user?.id ? 'BUYER' :
          nextOrder?.sellerId === user?.id ? 'SELLER' : 'BUYER';
        setArrangingParty(nextParty);

        setForm((previous) => ({
          ...previous,
          pickupLocation: nextOrder?.listing?.location || '',
          destination: nextOrder?.buyer?.location || '',
          load: nextOrder?.listing
            ? `${nextOrder.listing.cropType || 'Produce'} — ${nextOrder.listing.quantity || ''} ${nextOrder.listing.unit || ''}`
            : '',
          requiredCapacity: nextOrder?.listing?.quantity || '',
        }));

        if (nextParty === 'BUYER' || nextParty === 'SELLER') {
          try {
            const trucksResponse = await api.get('/transport/trucks/mine');
            if (active) setOwnTrucks(trucksResponse.data?.trucks || []);
          } catch (_) {
            // A normal buyer/seller may not have the TRUCK_OWNER capability.
          }
        }
      } catch (err) {
        if (active) {
          setError(
            err?.response?.data?.error ||
            'Could not load the order.'
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => { active = false; };
  }, [orderId, user?.id, navigate]);

  useEffect(() => {
    if (!allowedParties.some((party) => party.value === arrangingParty)) {
      setArrangingParty(allowedParties[0]?.value || 'BUYER');
    }
  }, [allowedParties, arrangingParty]);

  useEffect(() => {
    if (arrangingParty === 'JOINT') {
      setMethod('HIRE_TRANSPORTER');
      setSelectedTruck('');
    }
  }, [arrangingParty]);

  const availableOwnTrucks = ownTrucks.filter(
    (truck) => truck.availability === 'AVAILABLE'
  );

  async function findMatches() {
    setFinding(true);
    setError('');
    try {
      const params = {};
      if (form.requiredCapacity) params.minCapacity = Number(form.requiredCapacity);
      if (form.pickupLocation.trim()) params.area = form.pickupLocation.trim();
      const response = await api.get('/transport/match', { params });
      setMatches(response.data?.trucks || []);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
        'Could not find matching transporters.'
      );
    } finally {
      setFinding(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    if (!allowedParties.some((party) => party.value === arrangingParty)) {
      setError('You cannot arrange transport for the selected party.');
      setSubmitting(false);
      return;
    }

    if (arrangingParty === 'JOINT' && method === 'OWN_TRUCK') {
      setError('Joint arrangements must use a hired transporter.');
      setSubmitting(false);
      return;
    }

    if (method === 'OWN_TRUCK' && !selectedTruck) {
      setError('Select one of your available trucks.');
      setSubmitting(false);
      return;
    }

    try {
      await api.post('/transport', {
        orderId,
        arrangingParty,
        method,
        truckId: method === 'OWN_TRUCK' ? selectedTruck : undefined,
        pickupLocation: form.pickupLocation.trim(),
        destination: form.destination.trim(),
        load: form.load.trim(),
        requiredCapacity: form.requiredCapacity
          ? Number(form.requiredCapacity)
          : undefined,
        specialRequirements: form.specialRequirements.trim() || undefined,
      });

      navigate(`/orders/${orderId}`);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
        'Could not create the transport arrangement.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="section">
        <div className="container-narrow loading">Loading transport options…</div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="section">
        <div className="container-narrow">
          <div className="alert error">{error || 'Order not found.'}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">TRANSPORT</span>
        <h1>Choose how transport is handled.</h1>
        <p className="lead">
          The seller, buyer, or both may arrange transport. MarketBridge does not automatically assign a transporter.
        </p>

        {error && <div className="alert error">{error}</div>}

        <div className="card" style={{ marginBottom: 18 }}>
          <h2>1. Arranging party</h2>
          <div className="choice-grid">
            {allowedParties.map((party) => (
              <button
                key={party.value}
                type="button"
                className={`choice ${arrangingParty === party.value ? 'selected' : ''}`}
                onClick={() => setArrangingParty(party.value)}
              >
                <b>{party.label}</b>
                <span>
                  {party.value === 'JOINT'
                    ? 'Buyer and seller coordinate the transport decision together.'
                    : `${party.label.replace(' arranges', '')} controls the transport arrangement.`}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h2>2. Transport method</h2>
          <div className="choice-grid">
            <button
              type="button"
              disabled={arrangingParty === 'JOINT'}
              className={`choice ${method === 'OWN_TRUCK' ? 'selected' : ''}`}
              onClick={() => setMethod('OWN_TRUCK')}
            >
              <b>🚛 Use own truck</b>
              <span>
                No transporter-hiring payment or commission. The selected truck must belong to the arranging user.
              </span>
            </button>

            <button
              type="button"
              className={`choice ${method === 'HIRE_TRANSPORTER' ? 'selected' : ''}`}
              onClick={() => setMethod('HIRE_TRANSPORTER')}
            >
              <b>🚚 Hire a registered transporter</b>
              <span>
                Registered truck owners submit quotes. The selected quote is accepted before payment.
              </span>
            </button>
          </div>
        </div>

        <form className="card form-card" onSubmit={submit}>
          <h2>3. Transport details</h2>
          <div className="notice">
            <strong>Payment rule:</strong> after a hired quote is accepted, the buyer is taken to the payment center. IN_TRANSIT remains locked until all required payments are confirmed.
          </div>

          <div className="form-grid">
            <div>
              <label>Pickup farm / location</label>
              <input required value={form.pickupLocation} onChange={(e) => setForm({ ...form, pickupLocation: e.target.value })} />
            </div>
            <div>
              <label>Destination</label>
              <input required value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
            </div>
            <div>
              <label>Load</label>
              <input required value={form.load} onChange={(e) => setForm({ ...form, load: e.target.value })} />
            </div>
            <div>
              <label>Required capacity (tons)</label>
              <input type="number" min="0" value={form.requiredCapacity} onChange={(e) => setForm({ ...form, requiredCapacity: e.target.value })} />
            </div>
            <div>
              <label>Loading date/time</label>
              <input type="datetime-local" value={form.loadingAt || ''} onChange={(e) => setForm({ ...form, loadingAt: e.target.value })} />
            </div>
            <div>
              <label>Special requirements</label>
              <input value={form.specialRequirements} onChange={(e) => setForm({ ...form, specialRequirements: e.target.value })} placeholder="Access, loading, route…" />
            </div>
          </div>

          {method === 'OWN_TRUCK' && (
            <div className="match-box">
              <div className="row-between"><h3>My available trucks</h3></div>
              {availableOwnTrucks.map((truckItem) => (
                <div className={`transporter ${selectedTruck === truckItem.id ? 'chosen' : ''}`} key={truckItem.id}>
                  <div>
                    <strong>{truckItem.registration}</strong>
                    <p>{truckItem.truckType} · {truckItem.capacity}t · {truckItem.operatingArea}</p>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => setSelectedTruck(truckItem.id)}>
                    {selectedTruck === truckItem.id ? 'Selected' : 'Select'}
                  </button>
                </div>
              ))}
              {!availableOwnTrucks.length && <p className="muted">No available truck is registered to your account.</p>}
            </div>
          )}

          {method === 'HIRE_TRANSPORTER' && (
            <div className="match-box">
              <div className="row-between">
                <h3>Registered transporters</h3>
                <button type="button" className="btn btn-light" disabled={finding} onClick={findMatches}>
                  {finding ? 'Finding…' : 'Find matches'}
                </button>
              </div>
              {matches.map((truckItem) => (
                <div className="transporter" key={truckItem.id}>
                  <div>
                    <strong>{truckItem.owner?.name || 'Transporter'}</strong>
                    <p>{truckItem.truckType} · {truckItem.capacity}t · {truckItem.operatingArea} · ★ {truckItem.owner?.rating?.toFixed?.(1) || '—'}</p>
                  </div>
                  <span className="sd-badge sd-blue">Quote later</span>
                </div>
              ))}
              {!matches.length && <p className="muted">Find matches to preview suitable registered trucks. The final transporter is selected from submitted quotes.</p>}
            </div>
          )}

          <button className="btn btn-primary btn-lg full" type="submit" disabled={submitting}>
            {submitting
              ? 'Saving…'
              : method === 'HIRE_TRANSPORTER'
                ? 'Create transport request'
                : 'Confirm own-truck arrangement'}
          </button>
        </form>
      </div>
    </main>
  );
}
