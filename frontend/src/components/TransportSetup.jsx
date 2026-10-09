import React, { useEffect, useState } from 'react';
import api from '../api/client';

// ============================================================================
// TRANSPORT SETUP
// ============================================================================
// Initial "create the transport job" form — who arranges it, own truck vs.
// hire, pickup/destination, structured load details, and special requirements.
//
// Either the buyer or the seller may initiate transport, but once one has
// created a job, the other cannot create a competing one (enforced by the
// single-transport-job-per-order rule on the server).
//
// SECURITY: Load details and special requirements are structured enums and
// numbers. No free text is allowed in fields visible to bidders.
// ============================================================================

const CARGO_TYPES = [
  ['PRODUCE', 'Produce / Grains / Vegetables'],
  ['LIVESTOCK', 'Livestock'],
  ['GENERAL', 'General Goods'],
  ['OTHER', 'Other'],
];

const CARGO_UNITS = [
  ['tons', 'tons'],
  ['kg', 'kg'],
  ['quintals', 'quintals'],
  ['units', 'units'],
];

const SPECIAL_OPTIONS = [
  ['TARPAULIN', 'Tarpaulin / cover'],
  ['STRAPS_ROPES', 'Straps / ropes'],
  ['REFRIGERATION', 'Refrigeration needed'],
  ['LIVE_ANIMAL_RAMP', 'Livestock ramp'],
  ['LIFTING_GEAR', 'Crane / lifting gear'],
  ['ACCESS_RESTRICTED', 'Restricted access / small gate'],
];

const emptyForm = {
  pickupLocation: '',
  destination: '',
  cargoType: 'PRODUCE',
  cargoQuantityValue: '',
  cargoQuantityUnit: 'tons',
  requiredCapacity: '',
  specialRequirements: [],
};

/* ── Inline style tokens ─────────────────────────────────── */

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
    // A non-truck-owner will get a 403 here; that's expected and just means
    // no own-truck option is offered.
    api
      .get('/transport/trucks/mine')
      .then((r) => setOwnTrucks(Array.isArray(r.data?.trucks) ? r.data.trucks : []))
      .catch(() => {});
  }, []);

  const party = arrangingParty || (canBuyer ? 'BUYER' : canSeller ? 'SELLER' : '');

  // ── Who-arranges options ────────────────────────────────────
  // Buyer-only competitions hide the seller/joint options entirely.
  // Otherwise each option is shown only for the roles that are allowed.
  const arrangerOptions = (() => {
    const opts = [];
    if (buyerOnlyCompetition) {
      if (canBuyer) {
        opts.push({
          value: 'BUYER',
          label: 'Buyer arranges',
          hint: 'You control the transporter request and quote selection.',
        });
      }
    } else {
      if (canBuyer) {
        opts.push({
          value: 'BUYER',
          label: 'Buyer arranges',
          hint: canSeller
            ? 'Buyer controls the request and quote selection.'
            : 'You control the request and quote selection.',
        });
      }
      if (canSeller) {
        opts.push({
          value: 'SELLER',
          label: 'Seller arranges',
          hint: canBuyer
            ? 'Seller controls the request and quote selection.'
            : 'You control the request and quote selection.',
        });
      }
      if (canBuyer && canSeller) {
        opts.push({
          value: 'JOINT',
          label: 'Joint arrangement',
          hint: 'Buyer and seller agree together; hired transporter only.',
        });
      }
    }
    return opts;
  })();

  const toggleSpecial = (value) => {
    setForm((prev) => {
      const current = prev.specialRequirements || [];
      const has = current.includes(value);
      const next = has ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, specialRequirements: next };
    });
  };

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
        cargoType: form.cargoType,
        cargoQuantityValue: form.cargoQuantityValue ? Number(form.cargoQuantityValue) : undefined,
        cargoQuantityUnit: form.cargoQuantityUnit,
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
          ? 'The buyer controls the transporter competition. Registered truck owners submit sealed quotes, then the buyer selects and negotiates one.'
          : 'Either you or the counterparty may initiate transport. Once one of you does, the other cannot create a competing arrangement. The buyer remains responsible for paying a hired transporter.'}
      </p>

      {/* ── Who arranges ─────────────────────────────────── */}
      <div className="od-card-section" style={{ marginBottom: 18 }}>
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Who arranges transport</h3>
        </div>

        {arrangerOptions.length === 0 ? (
          <p style={truckMeta}>
            Only the listing buyer or seller can arrange transport for this order.
          </p>
        ) : (
          <div style={choiceGrid}>
            {arrangerOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                style={party === opt.value ? choiceSelected : choiceBase}
                onClick={() => {
                  setArrangingParty(opt.value);
                  if (opt.value === 'JOINT' && method === 'OWN_TRUCK') {
                    setMethod('HIRE_TRANSPORTER');
                  }
                }}
              >
                <span style={party === opt.value ? choiceLabelSelected : choiceLabel}>
                  {opt.label}
                </span>
                <span style={choiceHint}>{opt.hint}</span>
              </button>
            ))}
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
              style={
                party === 'JOINT'
                  ? choiceDisabled
                  : method === 'OWN_TRUCK'
                    ? choiceSelected
                    : choiceBase
              }
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
              placeholder="e.g. Bahirdar, Lot B warehouse"
            />
          </div>
          <div className="field">
            <label htmlFor="ts-destination">Destination</label>
            <input
              id="ts-destination"
              required
              value={form.destination}
              onChange={(e) => setForm({ ...form, destination: e.target.value })}
              placeholder="e.g. Addis Ababa, Merkato"
            />
          </div>

          <div className="field">
            <label htmlFor="ts-cargo-type">Cargo type</label>
            <select
              id="ts-cargo-type"
              value={form.cargoType}
              onChange={(e) => setForm({ ...form, cargoType: e.target.value })}
            >
              {CARGO_TYPES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Cargo quantity</label>
            <div className="od-quantity-row">
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 500"
                value={form.cargoQuantityValue}
                onChange={(e) => setForm({ ...form, cargoQuantityValue: e.target.value })}
                required
              />
              <select
                value={form.cargoQuantityUnit}
                onChange={(e) => setForm({ ...form, cargoQuantityUnit: e.target.value })}
              >
                {CARGO_UNITS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="ts-capacity">Required vehicle capacity (tons)</label>
            <input
              id="ts-capacity"
              type="number"
              min="0"
              step="0.1"
              value={form.requiredCapacity}
              onChange={(e) => setForm({ ...form, requiredCapacity: e.target.value })}
              placeholder="e.g. 10"
            />
          </div>

          <div className="field field-span">
            <label>Special requirements (select all that apply)</label>
            <div className="od-check-grid">
              {SPECIAL_OPTIONS.map(([value, label]) => (
                <label key={value} className="od-check-option">
                  <input
                    type="checkbox"
                    checked={form.specialRequirements.includes(value)}
                    onChange={() => toggleSpecial(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
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
