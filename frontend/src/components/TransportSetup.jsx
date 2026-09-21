import React, { useEffect, useState } from 'react';
import api from '../api/client';

// ============================================================================
// TRANSPORT SETUP
// ============================================================================
// The initial "create the transport job" form — who arranges it, own truck
// vs. hire, pickup/destination/load details, and (for hired transport) the
// matcher UI. This used to live on its own route (/orders/:id/transport,
// pages/ArrangeTransport.jsx) while the rest of the transport lifecycle
// (quotes, evidence, payment, pickup/in-transit/delivered) was already
// inline on OrderDetail.jsx. Moved here so transport now follows the same
// "everything happens on the order page" pattern inspection already used —
// no more navigating away mid-task.
//
// This is intentionally its own file rather than inline JSX in
// OrderDetail.jsx: it's the single biggest chunk of new markup this change
// adds, and OrderDetail.jsx is already the largest file flagged for the
// separate large-file refactor.
// ============================================================================

const emptyForm = {
  pickupLocation: '',
  destination: '',
  load: '',
  requiredCapacity: '',
  specialRequirements: '',
};

export default function TransportSetup({
  orderId,
  pickupDefault,
  destinationDefault,
  canBuyer,
  canSeller,
  onCreated,
}) {
  const [method, setMethod] = useState('OWN_TRUCK');
  const [form, setForm] = useState({
    ...emptyForm,
    pickupLocation: pickupDefault || '',
    destination: destinationDefault || '',
  });
  const [matches, setMatches] = useState([]);
  const [truck, setTruck] = useState('');
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [error, setError] = useState('');
  const [arrangingParty, setArrangingParty] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // A non-truck-owner will get a 403 here; that's expected and just means
    // no own-truck option is offered — same as the page this replaces.
    api
      .get('/transport/trucks/mine')
      .then((r) => setOwnTrucks(r.data.trucks || []))
      .catch(() => {});
  }, []);

  const party = arrangingParty || (canSeller ? 'SELLER' : canBuyer ? 'BUYER' : '');

  const findMatches = async () => {
    try {
      const response = await api.get('/transport/match', {
        params: { minCapacity: form.requiredCapacity, area: form.pickupLocation },
      });
      setMatches(response.data.trucks || []);
    } catch (err) {
      setError('Could not find matching transporters.');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    if (!party) {
      setError('Select who will arrange transport.');
      return;
    }
    if (method === 'OWN_TRUCK' && party === 'JOINT') {
      setError('Joint arrangements must use a hired transporter.');
      return;
    }
    if (method === 'OWN_TRUCK' && !truck) {
      setError('Select one of your available trucks.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/transport', {
        orderId,
        arrangingParty: party,
        method,
        truckId: method === 'OWN_TRUCK' ? truck : undefined,
        pickupLocation: form.pickupLocation,
        destination: form.destination,
        load: form.load,
        requiredCapacity: form.requiredCapacity ? Number(form.requiredCapacity) : undefined,
        specialRequirements: form.specialRequirements,
      });
      await onCreated?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not arrange transport');
    } finally {
      setSubmitting(false);
    }
  };

  const availableOwnTrucks = ownTrucks.filter((t) => t.availability === 'AVAILABLE');

  return (
    <form className="card form-card" onSubmit={submit} style={{ marginTop: 12 }}>
      <p className="lead" style={{ marginTop: 0 }}>
        Choose who controls the transport arrangement. The buyer remains responsible for paying
        a hired transporter.
      </p>

      <div className="choice-grid" style={{ marginBottom: 16 }}>
        {canBuyer && (
          <button
            type="button"
            className={`choice ${party === 'BUYER' ? 'selected' : ''}`}
            onClick={() => setArrangingParty('BUYER')}
          >
            <b>Buyer arranges</b>
            <span>Buyer controls the transport request and quote selection.</span>
          </button>
        )}
        {canSeller && (
          <button
            type="button"
            className={`choice ${party === 'SELLER' ? 'selected' : ''}`}
            onClick={() => setArrangingParty('SELLER')}
          >
            <b>Seller arranges</b>
            <span>Seller controls the transport request and quote selection.</span>
          </button>
        )}
        {canBuyer && canSeller && (
          <button
            type="button"
            className={`choice ${party === 'JOINT' ? 'selected' : ''}`}
            onClick={() => {
              setArrangingParty('JOINT');
              if (method === 'OWN_TRUCK') setMethod('HIRE_TRANSPORTER');
            }}
          >
            <b>Joint arrangement</b>
            <span>Buyer and seller jointly agree; hired transporter only.</span>
          </button>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="choice-grid">
        <button
          type="button"
          disabled={party === 'JOINT'}
          className={`choice ${method === 'OWN_TRUCK' ? 'selected' : ''}`}
          onClick={() => setMethod('OWN_TRUCK')}
        >
          <b>🚚 Use my own truck</b>
          <span>Record your own legally permitted vehicle and pickup details. No
            transport-hiring commission.</span>
        </button>
        <button
          type="button"
          className={`choice ${method === 'HIRE_TRANSPORTER' ? 'selected' : ''}`}
          onClick={() => setMethod('HIRE_TRANSPORTER')}
        >
          <b>Hire a registered transporter</b>
          <span>MarketBridge matches by capacity, area, route, availability, rating and
            verification.</span>
        </button>
      </div>

      <div className="notice">
        <strong>Role separation:</strong> Inspectors verify produce and evidence; they do not
        arrange trucks.
      </div>

      <div className="form-grid">
        <div>
          <label>Pickup farm / location</label>
          <input
            required
            value={form.pickupLocation}
            onChange={(e) => setForm({ ...form, pickupLocation: e.target.value })}
          />
        </div>
        <div>
          <label>Destination</label>
          <input
            required
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value })}
          />
        </div>
        <div>
          <label>Load</label>
          <input
            required
            value={form.load}
            onChange={(e) => setForm({ ...form, load: e.target.value })}
          />
        </div>
        <div>
          <label>Required capacity (tons)</label>
          <input
            type="number"
            value={form.requiredCapacity}
            onChange={(e) => setForm({ ...form, requiredCapacity: e.target.value })}
          />
        </div>
        <div>
          <label>Special requirements</label>
          <input
            value={form.specialRequirements}
            onChange={(e) => setForm({ ...form, specialRequirements: e.target.value })}
            placeholder="Access, loading, route..."
          />
        </div>
      </div>

      {method === 'OWN_TRUCK' && (
        <div className="match-box">
          <div className="row-between">
            <h3>My available trucks</h3>
          </div>
          {availableOwnTrucks.map((t) => (
            <div className={`transporter ${truck === t.id ? 'chosen' : ''}`} key={t.id}>
              <div>
                <strong>{t.registration}</strong>
                <p>
                  {t.truckType} · {t.capacity}t · {t.operatingArea}
                </p>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setTruck(t.id)}>
                {truck === t.id ? 'Selected' : 'Select'}
              </button>
            </div>
          ))}
          {!availableOwnTrucks.length && (
            <p className="muted">No available truck is registered to your account.</p>
          )}
        </div>
      )}

      {method === 'HIRE_TRANSPORTER' && (
        <div className="match-box">
          <div className="row-between">
            <h3>Registered transporters</h3>
            <button type="button" className="btn btn-light" onClick={findMatches}>
              Find matches
            </button>
          </div>
          {matches.map((t) => (
            <div className={`transporter ${truck === t.owner.id ? 'chosen' : ''}`} key={t.id}>
              <div>
                <strong>{t.owner.name}</strong>
                <p>
                  {t.truckType} · {t.capacity}t · {t.operatingArea} · ★{' '}
                  {t.owner.rating?.toFixed?.(1) || '—'}
                </p>
              </div>
              <span className="sd-badge sd-blue">Quote later</span>
            </div>
          ))}
          {!matches.length && <p className="muted">Enter your details and select "Find matches".</p>}
        </div>
      )}

      <button className="btn btn-primary btn-lg full" type="submit" disabled={submitting}>
        {submitting
          ? 'Submitting…'
          : method === 'HIRE_TRANSPORTER'
            ? 'Create transport request'
            : 'Confirm own-truck arrangement'}
      </button>
    </form>
  );
}
