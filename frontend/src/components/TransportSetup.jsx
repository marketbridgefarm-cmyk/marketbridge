import React, { useEffect, useState } from 'react';
import api from '../api/client';
import {
  ACCESS_NOTES, CAPACITY_TONS, DEADLINE_WINDOWS, PACKAGE_COUNTS, WEIGHT_OPTIONS, deadlineFromWindow,
} from './RequestOptions.js';

// ============================================================================
// TRANSPORT SETUP
// ============================================================================
// Initial "create the transport job" form — who arranges it, own truck vs.
// hire, pickup/destination/load details, and (for hired transport) the
// matcher UI.
//
// Visual note: this renders INSIDE the Transport card on OrderDetail. It no
// longer draws its own outer .card — the enclosing card already provides
// the frame. Sections are flat blocks separated by hairlines; buttons and
// inputs reuse the classes the surrounding page already styles.
// ============================================================================

const emptyForm = {
  requiredCapacity: '',
  weight: '',
  packageCount: '',
  vehicleType: '',
  deliveryWindow: '',
  accessNotes: [],
  handling: [],
};

const VEHICLE_TYPES = ['Pickup', 'Small truck', 'Medium truck', 'Large truck', 'Refrigerated truck', 'Flatbed'];
const HANDLING_OPTIONS = [
  ['FRAGILE', 'Fragile'],
  ['KEEP_COOL', 'Keep cool'],
  ['KEEP_DRY', 'Keep dry'],
  ['THIS_SIDE_UP', 'This side up'],
  ['VENTILATED', 'Ventilated'],
  ['COVERED', 'Covered load'],
];

/* ── Small inline style tokens ────────────────────────────── */

const eyebrow = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  color: '#12734a',
  fontFamily: "'DM Sans', system-ui, sans-serif",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.16em',
  textTransform: 'uppercase',
  margin: '0 0 6px',
};

const eyebrowLine = {
  display: 'inline-block',
  width: 18,
  height: 2,
  borderRadius: 2,
  background: 'currentColor',
};

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

const truckRow = (isChosen) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  padding: '14px 0',
  borderBottom: '1px solid #eef1f5',
  background: 'transparent',
  border: 'none',
  borderTop: '1px solid #eef1f5',
  borderBottomWidth: 1,
});

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
  loadDefault,
  canBuyer,
  canSeller,
  buyerOnlyCompetition = false,
  onCreated,
}) {
  const [method, setMethod] = useState(buyerOnlyCompetition ? 'HIRE_TRANSPORTER' : 'OWN_TRUCK');
  const [form, setForm] = useState({ ...emptyForm });
  // Route and load are fixed by the order — not typed.
  const pickupLocation = pickupDefault || '';
  const destination = destinationDefault || '';
  const load = loadDefault || '';
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

  const findMatches = async () => {
    try {
      const response = await api.get('/transport/match', {
        params: { minCapacity: form.requiredCapacity, area: pickupLocation },
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

    if (!pickupLocation || !destination || !load) {
      setError('This order is missing a pickup location, destination or load. Update the listing or your profile location first.');
      return;
    }
    if (method === 'HIRE_TRANSPORTER' && !form.weight) {
      setError('Select the total weight.');
      return;
    }

    const workDetails = {};
    if (form.weight) workDetails.weight = form.weight;
    if (form.packageCount) workDetails.packageCount = Number(form.packageCount);
    if (form.vehicleType) workDetails.vehicleType = form.vehicleType;
    if (form.deliveryWindow) workDetails.deliveryDeadline = deadlineFromWindow(form.deliveryWindow);
    if (form.handling.length) workDetails.handling = form.handling;

    setSubmitting(true);
    try {
      await api.post('/transport', {
        orderId,
        arrangingParty: party,
        method,
        truckId: method === 'OWN_TRUCK' ? truck : undefined,
        pickupLocation,
        destination,
        load,
        requiredCapacity: form.requiredCapacity ? Number(form.requiredCapacity) : undefined,
        specialRequirements: form.accessNotes.length ? form.accessNotes.join('; ') : undefined,
        workDetails: Object.keys(workDetails).length ? workDetails : undefined,
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
          : 'Choose who controls the transport arrangement. The buyer remains responsible for paying a hired transporter.'}
      </p>

      {/* ── Who arranges ─────────────────────────────────── */}
      <div className="od-card-section" style={{ marginBottom: 18 }}>
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Who arranges transport</h3>
        </div>

        <div style={choiceGrid}>
          {canBuyer && (
            <button
              type="button"
              style={party === 'BUYER' ? choiceSelected : choiceBase}
              onClick={() => setArrangingParty('BUYER')}
            >
              <span style={party === 'BUYER' ? choiceLabelSelected : choiceLabel}>Buyer arranges</span>
              <span style={choiceHint}>Buyer controls the request and quote selection.</span>
            </button>
          )}
          {canSeller && !buyerOnlyCompetition && (
            <button
              type="button"
              style={party === 'SELLER' ? choiceSelected : choiceBase}
              onClick={() => setArrangingParty('SELLER')}
            >
              <span style={party === 'SELLER' ? choiceLabelSelected : choiceLabel}>Seller arranges</span>
              <span style={choiceHint}>Seller controls the request and quote selection.</span>
            </button>
          )}
          {canBuyer && canSeller && !buyerOnlyCompetition && (
            <button
              type="button"
              style={party === 'JOINT' ? choiceSelected : choiceBase}
              onClick={() => {
                setArrangingParty('JOINT');
                if (method === 'OWN_TRUCK') setMethod('HIRE_TRANSPORTER');
              }}
            >
              <span style={party === 'JOINT' ? choiceLabelSelected : choiceLabel}>Joint arrangement</span>
              <span style={choiceHint}>Buyer and seller agree together; hired transporter only.</span>
            </button>
          )}
        </div>
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

      {/* ── Trip details (closed fields only) ────────────── */}
      <div className="od-card-section">
        <div style={sectionHead}>
          <h3 style={sectionTitle}>Trip details</h3>
        </div>

        <div className="od-form-grid">
          <div className="od-tf od-tf-span">
            <label>Route (from the order)</label>
            <p style={{ ...truckMeta, color: '#0d1b2a', fontWeight: 700, margin: 0 }}>
              {pickupLocation || 'Not set'} → {destination || 'Not set'}
            </p>
          </div>
          <div className="od-tf od-tf-span">
            <label>Load (from the listing)</label>
            <p style={{ ...truckMeta, color: '#0d1b2a', fontWeight: 700, margin: 0 }}>{load || 'Not set'}</p>
          </div>
          <div className="od-tf">
            <label htmlFor="ts-capacity">Minimum truck capacity</label>
            <select
              id="ts-capacity"
              className="field"
              value={form.requiredCapacity}
              onChange={(e) => setForm({ ...form, requiredCapacity: e.target.value })}
            >
              <option value="">Any capacity</option>
              {CAPACITY_TONS.map((t) => (
                <option key={t} value={t}>{t} t or more</option>
              ))}
            </select>
          </div>
          <div className="od-tf">
            <label htmlFor="ts-weight">Total weight{method === 'HIRE_TRANSPORTER' ? '' : ' (optional)'}</label>
            <select
              id="ts-weight"
              className="field"
              value={form.weight}
              onChange={(e) => setForm({ ...form, weight: e.target.value })}
            >
              <option value="">Select weight…</option>
              {WEIGHT_OPTIONS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>
          <div className="od-tf">
            <label htmlFor="ts-packages">Number of packages</label>
            <select
              id="ts-packages"
              className="field"
              value={form.packageCount}
              onChange={(e) => setForm({ ...form, packageCount: e.target.value })}
            >
              <option value="">Select…</option>
              {PACKAGE_COUNTS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="od-tf">
            <label htmlFor="ts-vehicle">Vehicle type</label>
            <select
              id="ts-vehicle"
              className="field"
              value={form.vehicleType}
              onChange={(e) => setForm({ ...form, vehicleType: e.target.value })}
            >
              <option value="">Any suitable vehicle</option>
              {VEHICLE_TYPES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="od-tf od-tf-span">
            <label htmlFor="ts-deadline">Delivery deadline</label>
            <select
              id="ts-deadline"
              className="field"
              value={form.deliveryWindow}
              onChange={(e) => setForm({ ...form, deliveryWindow: e.target.value })}
            >
              <option value="">No deadline</option>
              {DEADLINE_WINDOWS.map((w) => (
                <option key={w.key} value={w.key}>{w.label}</option>
              ))}
            </select>
          </div>
          <div className="od-tf od-tf-span">
            <label>Handling needs</label>
            <div className="od-chip-row">
              {HANDLING_OPTIONS.map(([value, text]) => {
                const on = form.handling.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    className={on ? 'btn btn-primary btn-sm' : 'btn btn-light btn-sm'}
                    onClick={() =>
                      setForm({
                        ...form,
                        handling: on ? form.handling.filter((h) => h !== value) : [...form.handling, value],
                      })
                    }
                  >
                    {text}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="od-tf od-tf-span">
            <label>Access and loading</label>
            <div className="od-chip-row">
              {ACCESS_NOTES.map((note) => {
                const on = form.accessNotes.includes(note);
                return (
                  <button
                    key={note}
                    type="button"
                    aria-pressed={on}
                    className={on ? 'btn btn-primary btn-sm' : 'btn btn-light btn-sm'}
                    onClick={() =>
                      setForm({
                        ...form,
                        accessNotes: on ? form.accessNotes.filter((n) => n !== note) : [...form.accessNotes, note],
                      })
                    }
                  >
                    {note}
                  </button>
                );
              })}
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
