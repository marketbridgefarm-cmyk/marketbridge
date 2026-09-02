import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

export default function ArrangeTransport() {
  const { orderId } = useParams();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [method, setMethod] = useState('HIRE_TRANSPORTER');
  const [form, setForm] = useState({
    pickupLocation: '',
    destination: '',
    load: '',
    requiredCapacity: '',
    specialRequirements: '',
    loadingAt: '',
  });
  const [matches, setMatches] = useState([]);
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [truck, setTruck] = useState('');
  const [loadingOrder, setLoadingOrder] = useState(true);
  const [matching, setMatching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoadingOrder(true);
      setError('');

      try {
        const [orderResponse, trucksResponse] = await Promise.all([
          api.get(`/orders/${orderId}`),
          api.get('/transport/trucks/mine').catch(() => ({ data: { trucks: [] } })),
        ]);

        if (!mounted) return;

        const loadedOrder = orderResponse.data.order;
        setOrder(loadedOrder);
        setOwnTrucks(trucksResponse.data.trucks || []);

        setForm((current) => ({
          ...current,
          pickupLocation: current.pickupLocation || loadedOrder.listing?.location || '',
          destination: current.destination || loadedOrder.buyer?.location || '',
        }));
      } catch (e) {
        if (mounted) {
          setError(e.response?.data?.error || 'Failed to load order');
        }
      } finally {
        if (mounted) setLoadingOrder(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [orderId]);

  const party = useMemo(() => {
    if (!order || !user) return null;
    if (user.id === order.sellerId) return 'SELLER';
    if (user.id === order.buyerId) return 'BUYER';
    return null;
  }, [order, user]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
    setSuccess('');
  }

  async function findMatches() {
    setMatching(true);
    setError('');
    setSuccess('');
    setMatches([]);

    try {
      const params = {};
      const area = form.pickupLocation.trim();
      const capacity = form.requiredCapacity.trim();

      if (area) params.area = area;
      if (capacity) params.minCapacity = capacity;

      const response = await api.get('/transport/match', { params });
      const trucks = response.data.trucks || [];
      setMatches(trucks);

      if (trucks.length) {
        setSuccess(`${trucks.length} available transport option${trucks.length === 1 ? '' : 's'} found.`);
      } else {
        setSuccess('No exact matches found. Try a broader pickup area or lower capacity requirement.');
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Could not find available transport options.');
    } finally {
      setMatching(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!party) {
      setError('Only the buyer or seller on this order can arrange transport.');
      return;
    }

    if (method === 'OWN_TRUCK' && !truck) {
      setError('Select one of your available trucks.');
      return;
    }

    setSubmitting(true);

    try {
      const response = await api.post('/transport', {
        orderId,
        arrangingParty: party,
        method,
        truckId: method === 'OWN_TRUCK' ? truck : undefined,
        pickupLocation: form.pickupLocation.trim(),
        destination: form.destination.trim(),
        load: form.load.trim(),
        requiredCapacity: form.requiredCapacity
          ? Number(form.requiredCapacity)
          : undefined,
        specialRequirements: form.specialRequirements.trim() || undefined,
      });

      const createdJob = response.data.transportJob;

      // Stay on this page. The new transport job is displayed immediately
      // instead of navigating to OrderDetail, which avoids losing the user
      // when the order detail endpoint is temporarily unavailable.
      setOrder((current) => ({
        ...current,
        status: 'TRANSPORT_ARRANGED',
        transportJob: {
          ...createdJob,
          quotes: [],
        },
      }));

      setSuccess(
        method === 'HIRE_TRANSPORTER'
          ? 'Transport request created successfully. Available registered transporters can now submit quotes.'
          : 'Your own-truck transport arrangement was created successfully.'
      );
    } catch (e) {
      setError(e.response?.data?.error || 'Could not arrange transport');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingOrder) {
    return (
      <main className="section">
        <div className="container-narrow loading">Loading order…</div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="section">
        <div className="container-narrow">
          <div className="alert error">{error || 'Failed to load order'}</div>
          <Link className="btn btn-light" to="/orders">Back to Orders</Link>
        </div>
      </main>
    );
  }

  const availableOwnTrucks = ownTrucks.filter(
    (item) => item.availability === 'AVAILABLE'
  );
  const requestCreated = Boolean(order.transportJob);

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">TRANSPORT</span>
        <h1>Choose how transport is handled.</h1>
        <p className="lead">
          Arranging party: <strong>{party || '—'}</strong>. Transport is not automatically assigned.
        </p>

        {error && <div className="alert error">{error}</div>}
        {success && <div className="alert success">{success}</div>}

        {requestCreated ? (
          <div className="card">
            <div className="notice">
              <strong>Transport request is active.</strong>{' '}
              {order.transportJob.method === 'HIRE_TRANSPORTER'
                ? 'Registered transporters can now submit quotes.'
                : 'Your own truck has been assigned to this order.'}
            </div>

            <div className="detail-facts">
              <div>
                <span>Method</span>
                <strong>{order.transportJob.method}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{order.transportJob.status}</strong>
              </div>
              <div>
                <span>Route</span>
                <strong>
                  {order.transportJob.pickupLocation} → {order.transportJob.destination}
                </strong>
              </div>
            </div>

            <div className="row-between" style={{ marginTop: 16 }}>
              <span className="muted">
                You can stay here to monitor the transport arrangement.
              </span>
              <Link className="btn btn-primary" to={`/orders/${order.id}`}>
                View Order
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="choice-grid">
              <button
                type="button"
                className={`choice ${method === 'OWN_TRUCK' ? 'selected' : ''}`}
                onClick={() => {
                  setMethod('OWN_TRUCK');
                  setError('');
                  setSuccess('');
                }}
              >
                <b>🚚 Use my own truck</b>
                <span>
                  Record your own legally permitted vehicle and pickup details. No transport-hiring commission.
                </span>
              </button>

              <button
                type="button"
                className={`choice ${method === 'HIRE_TRANSPORTER' ? 'selected' : ''}`}
                onClick={() => {
                  setMethod('HIRE_TRANSPORTER');
                  setError('');
                  setSuccess('');
                }}
              >
                <b>Hire a registered transporter</b>
                <span>
                  MarketBridge matches by capacity, area, route, availability, rating and verification.
                </span>
              </button>
            </div>

            <form className="card form-card" onSubmit={submit}>
              <div className="notice">
                <strong>Role separation:</strong> Inspectors verify produce and evidence; they do not arrange trucks.
              </div>

              <div className="form-grid">
                <div>
                  <label>Pickup farm / location</label>
                  <input
                    required
                    value={form.pickupLocation}
                    onChange={(e) => updateField('pickupLocation', e.target.value)}
                  />
                </div>

                <div>
                  <label>Destination</label>
                  <input
                    required
                    value={form.destination}
                    onChange={(e) => updateField('destination', e.target.value)}
                  />
                </div>

                <div>
                  <label>Load</label>
                  <input
                    required
                    value={form.load}
                    onChange={(e) => updateField('load', e.target.value)}
                    placeholder="e.g. 18 tons wheat"
                  />
                </div>

                <div>
                  <label>Required capacity (tons)</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={form.requiredCapacity}
                    onChange={(e) => updateField('requiredCapacity', e.target.value)}
                  />
                </div>

                <div>
                  <label>Loading date/time</label>
                  <input
                    type="datetime-local"
                    value={form.loadingAt}
                    onChange={(e) => updateField('loadingAt', e.target.value)}
                  />
                </div>

                <div>
                  <label>Special requirements</label>
                  <input
                    value={form.specialRequirements}
                    onChange={(e) => updateField('specialRequirements', e.target.value)}
                    placeholder="Access, loading, route..."
                  />
                </div>
              </div>

              {method === 'OWN_TRUCK' && (
                <div className="match-box">
                  <div className="row-between">
                    <h3>My available trucks</h3>
                  </div>

                  {availableOwnTrucks.map((item) => (
                    <div
                      className={`transporter ${truck === item.id ? 'chosen' : ''}`}
                      key={item.id}
                    >
                      <div>
                        <strong>{item.registration}</strong>
                        <p>
                          {item.truckType} · {item.capacity}t · {item.operatingArea}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setTruck(item.id)}
                      >
                        {truck === item.id ? 'Selected' : 'Select'}
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
                    <div>
                      <h3>Available transport options</h3>
                      <p className="muted">
                        Matching stays on this page. Transporters submit quotes after you create the request.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={findMatches}
                      disabled={matching}
                    >
                      {matching ? 'Matching…' : 'Find matches'}
                    </button>
                  </div>

                  {matches.map((item) => (
                    <div className="transporter" key={item.id}>
                      <div>
                        <strong>{item.owner?.name || 'Registered transporter'}</strong>
                        <p>
                          {item.truckType} · {item.capacity}t · {item.operatingArea}
                          {item.owner?.rating != null
                            ? ` · ★ ${Number(item.owner.rating).toFixed(1)}`
                            : ''}
                        </p>
                        <p className="muted">
                          {item.verificationStatus === 'VERIFIED'
                            ? 'Verified truck'
                            : 'Registered truck'}
                        </p>
                      </div>
                      <span className="sd-badge sd-blue">Available</span>
                    </div>
                  ))}

                  {!matches.length && (
                    <p className="muted">
                      Enter your pickup area and required capacity, then select “Find matches”.
                    </p>
                  )}
                </div>
              )}

              <button
                className="btn btn-primary btn-lg full"
                type="submit"
                disabled={submitting}
              >
                {submitting
                  ? 'Creating…'
                  : method === 'HIRE_TRANSPORTER'
                    ? 'Create transport request'
                    : 'Confirm own-truck arrangement'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
