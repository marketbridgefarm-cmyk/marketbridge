import React, { useEffect, useState } from 'react';
import api from '../api/client';

// ============================================================================
// TRANSPORT SETUP
// ============================================================================
// Initial "create the transport job" form — who arranges it, own truck vs.
// hire, pickup/destination/load details, and (for hired transport) the
// matcher UI.
//
// Either the buyer or the seller may initiate transport. Once one of them
// creates a job, the other cannot create a competing one — that is enforced
// server-side by the single-transport-job-per-order rule.
// ============================================================================

const emptyForm = {
  pickupLocation: '',
  destination: '',
  load: '',
  requiredCapacity: '',
  specialRequirements: '',
};

/* ── Small inline style tokens ────────────────────────────── */

const lead = {
  margin: '0 0 14px',
  fontFamily: "'DM Sans', system-ui, sans-serif",
  fontSize: 13.5,
  lineHeight: 1.6,
  color: '#64748b',
};

const sectionHead = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  paddingBottom: 10,
  marginBottom: 14,
  borderBottom: '1px solid #eef1f5',
};

const sectionTitle = {
  margin: 0,
  fontFamily: "'Manrope', system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: '-.1px',
  color: '#0f7a44',
};

const choiceGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 10,
  margin: '0 0 16px',
};

const choiceBase = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  textAlign: 'left',
  width: '100%',
  padding: '14px 16px',
  borderRadius: 12,
  border: '1px solid #e5e9ef',
  background: '#fff',
  color: '#0d1b2a',
  fontFamily: "'DM Sans', system-ui, sans-serif",
  cursor: 'pointer',
  transition: 'border-color .15s, background .15s',
};

const choiceSelected = {
  ...choiceBase,
  borderColor: '#1e9e5a',
  background: '#ecfdf3',
};

const choiceDisabled = {
  ...choiceBase,
  opacity: .5,
  cursor: 'not-allowed',
};

const choiceLabel = {
  fontFamily: "'Manrope', system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: '-.15px',
  color: '#0d1b2a',
};

const choiceLabelSelected = {
  ...choiceLabel,
  color: '#12734a',
};

const choiceHint = {
  fontSize: 12.5,
  lineHeight: 1.5,
  color: '#64748b',
};

const truckInfo = {
  minWidth: 0,
  flex: '1 1 auto',
};

const truckName = {
  display: 'block',
  fontFamily: "'Manrope', system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: '-.15px',
  color: '#0d1b2a',
  marginBottom: 2,
};

const truckMeta = {
  margin: 0,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: '#64748b',
};

const noticeBox = {
  margin: '0 0 16px',
  padding: '4px 0 4px 14px',
  borderLeft: '3px solid #c6eccf',
  fontFamily: "'DM Sans', system-ui, sans-serif",
  fontSize: 12.5,
  lineHeight: 1.55,
  color: '#2c3a4a',
};

const noticeStrong = {
  color: '#0d1b2a',
  fontWeight: 700,
};

const submitRow = {
  marginTop: 18,
  paddingTop: 16,
  borderTop: '1px solid #eef1f5',
};

export default function TransportSetup({
  orderId,
  pickupDefault,
  destinationDefault,
  canBuyer,
  canSeller,
  buyerOnlyCompetition = false,
  onCreated,
}) {
  const [method, setMethod] = useState(buyerOnlyCompetition ? 'HIRE_TRANSPORTER' : 'OWN_TRUCK');
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
    api
      .get('/transport/trucks/mine')
      .then((r) => setOwnTrucks(Array.isArray(r.data?.trucks) ? r.data.trucks : []))
      .catch(() => {});
  }, []);

  const party = arrangingParty || (canBuyer ? 'BUYER' : canSeller ? 'SELLER' : '');

  const findMatches = async () => {
    try {
      const response = await api.get('/transport/match', {
        params: { minCapacity: form.requiredCapacity, area: form.pickupLocation },
      });
      setMatches(Array.isArray(response.data?.trucks) ? response.data.trucks : []);
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
    <form className="mb-transport-setup" onSubmit={submit}>
      <p style={lead}>
        {buyerOnlyCompetition
          ? 'Either you or the counterparty may initiate transport. Once one of you does, the other cannot create a competing arrangement. Registered truck owners submit sealed quotes, and the arranging party selects and negotiates one.'
          : 'Either you or the counterparty may initiate transport. Once one of you does, the other cannot create a competing arrangement. The buyer remains responsible for paying a hired transporter.'}
      </p>

      {/* ── Who arranges ─────────────────────────────────── */}
      <div className="od-card-section" style={{ marginBottom: 18 }}>
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Who arranges transport</h3>
        </div>

        {!canBuyer && !canSeller ? (
          <p style={truckMeta}>
            Only the listing buyer or seller can arrange transport for this order.
          </p>
        ) : (
          <div style={choiceGrid}>
            {canBuyer && (
              <button
                type="button"
                style={party === 'BUYER' ? choiceSelected : choiceBase}
                onClick={() => setArrangingParty('BUYER')}
              >
                <span style={party === 'BUYER' ? choiceLabelSelected : choiceLabel}>
                  Buyer arranges
                </span>
                <span style={choiceHint}>
                  Buyer controls the request and quote selection.
                </span>
              </button>
            )}

            {canSeller && (
              <button
                type="button"
                style={party === 'SELLER' ? choiceSelected : choiceBase}
                onClick={() => setArrangingParty('SELLER')}
              >
                <span style={party === 'SELLER' ? choiceLabelSelected : choiceLabel}>
                  Seller arranges
                </span>
                <span style={choiceHint}>
                  Seller controls the request and quote selection.
                </span>
              </button>
            )}

            {canBuyer && canSeller && (
              <button
                type="button"
                style={party === 'JOINT' ? choiceSelected : choiceBase}
                onClick={() => {
                  setArrangingParty('JOINT');
                  if (method === 'OWN_TRUCK') setMethod('HIRE_TRANSPORTER');
                }}
              >
                <span style={party === 'JOINT' ? choiceLabelSelected : choiceLabel}>
                  Joint arrangement
                </span>
                <span style={choiceHint}>
                  Buyer and seller agree together; hired transporter only.
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Method ───────────────────────────────────────── */}
      <div className="od-card-section" style={{ marginBottom: 18 }}>
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Method</h3>
        </div>

        <div style={choiceGrid}>
          {!buyerOnlyCompetition && (
            <button
              type="button"
              disabled={party === 'JOINT'}
              style={party === 'JOINT' ? choiceDisabled : (method === 'OWN_TRUCK' ? choiceSelected : choiceBase)}
              onClick={() => setMethod('OWN_TRUCK')}
            >
              <span style={method === 'OWN_TRUCK' && party !== 'JOINT' ? choiceLabelSelected : choiceLabel}>
                🚚 Use my own truck
              </span>
              <span style={choiceHint}>
                Record your own legally permitted vehicle. No transport-hiring commission.
              </span>
            </button>
          )}

          <button
            type="button"
            style={method === 'HIRE_TRANSPORTER' ? choiceSelected : choiceBase}
            onClick={() => setMethod('HIRE_TRANSPORTER')}
          >
            <span style={method === 'HIRE_TRANSPORTER' ? choiceLabelSelected : choiceLabel}>
              Hire a registered transporter
            </span>
            <span style={choiceHint}>
              MarketBridge matches by capacity, area, route, availability, rating and verification.
            </span>
          </button>
        </div>

        <div style={noticeBox}>
          <strong style={noticeStrong}>Role separation:</strong> Inspectors verify produce and
          evidence; they do not arrange trucks.
        </div>
      </div>

      {error && <div className="alert error" style={{ marginTop: 0 }}>{error}</div>}

      {/* ── Trip details ─────────────────────────────────── */}
      <div className="od-card-section">
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Trip details</h3>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="ts-pickup">Pickup farm / location</label>
            <input
              id="ts-pickup"
              required
              value={form.pickupLocation}
              onChange={(e) => setForm({ ...form, pickupLocation: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ts-destination">Destination</label>
            <input
              id="ts-destination"
              required
              value={form.destination}
              onChange={(e) => setForm({ ...form, destination: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ts-load">Load</label>
            <input
              id="ts-load"
              required
              value={form.load}
              onChange={(e) => setForm({ ...form, load: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ts-capacity">Required capacity (tons)</label>
            <input
              id="ts-capacity"
              type="number"
              value={form.requiredCapacity}
              onChange={(e) => setForm({ ...form, requiredCapacity: e.target.value })}
            />
          </div>
          <div className="field field-span">
            <label htmlFor="ts-requirements">Special requirements</label>
            <input
              id="ts-requirements"
              value={form.specialRequirements}
              onChange={(e) => setForm({ ...form, specialRequirements: e.target.value })}
              placeholder="Access, loading, route…"
            />
          </div>
        </div>
      </div>

      {/* ── Own trucks ───────────────────────────────────── */}
      {method === 'OWN_TRUCK' && (
        <div className="od-card-section">
          <div style={sectionHead}>
            <h3 style={sectionTitle}>My available trucks</h3>
            <span
              style={{
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                color: '#64748b',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {availableOwnTrucks.length}
            </span>
          </div>

          {availableOwnTrucks.map((t, i) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                padding: '14px 0',
                borderTop: i === 0 ? 'none' : '1px solid #eef1f5',
                borderBottom: i === availableOwnTrucks.length - 1 ? 'none' : '1px solid #eef1f5',
              }}
            >
              <div style={truckInfo}>
                <strong style={truckName}>{t.registration}</strong>
                <p style={truckMeta}>
                  {t.truckType} · {t.capacity}t · {t.operatingArea}
                </p>
              </div>
              <button
                type="button"
                className={truck === t.id ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                onClick={() => setTruck(t.id)}
              >
                {truck === t.id ? 'Selected' : 'Select'}
              </button>
            </div>
          ))}

          {!availableOwnTrucks.length && (
            <p style={lead}>No available truck is registered to your account.</p>
          )}
        </div>
      )}

      {/* ── Registered transporters ──────────────────────── */}
      {method === 'HIRE_TRANSPORTER' && (
        <div className="od-card-section">
          <div style={sectionHead}>
            <h3 style={sectionTitle}>Registered transporters</h3>
            <button type="button" className="btn btn-light btn-sm" onClick={findMatches}>
              Find matches
            </button>
          </div>

          {matches.map((t, i) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                padding: '14px 0',
                borderTop: i === 0 ? 'none' : '1px solid #eef1f5',
                borderBottom: i === matches.length - 1 ? 'none' : '1px solid #eef1f5',
              }}
            >
              <div style={truckInfo}>
                <strong style={truckName}>{t.owner.name}</strong>
                <p style={truckMeta}>
                  {t.truckType} · {t.capacity}t · {t.operatingArea} · ★{' '}
                  {t.owner.rating?.toFixed?.(1) || '—'}
                </p>
              </div>
              <span className="od-status-pill od-tone-info">Quote later</span>
            </div>
          ))}

          {!matches.length && (
            <p style={lead}>Enter your details and select "Find matches".</p>
          )}
        </div>
      )}

      {/* ── Submit ──────────────────────────────────────── */}
      <div style={submitRow}>
        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting
            ? 'Submitting…'
            : method === 'HIRE_TRANSPORTER'
              ? 'Create transport request'
              : 'Confirm own-truck arrangement'}
        </button>
      </div>
    </form>
  );
}
