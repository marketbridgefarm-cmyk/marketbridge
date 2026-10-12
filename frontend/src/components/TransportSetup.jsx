import React, { useEffect, useState } from 'react';
import api from '../api/client';
import {
  ACCESS_NOTES, CAPACITY_TONS, DEADLINE_WINDOWS, PACKAGE_COUNTS, WEIGHT_OPTIONS, deadlineFromWindow,
} from './RequestOptions.js';
import './TransportSetup.css';

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
// All visual styling lives in TransportSetup.css.
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

const emptyTruckForm = {
  registration: '',
  truckType: '',
  capacity: '',
  operatingArea: '',
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
  const pickupLocation = pickupDefault || '';
  const destination = destinationDefault || '';
  const load = loadDefault || '';
  const [matches, setMatches] = useState([]);
  const [truck, setTruck] = useState('');
  const [ownTrucks, setOwnTrucks] = useState([]);
  const [error, setError] = useState('');
  const [arrangingParty, setArrangingParty] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // FIXED: Inline truck registration state. Buyers and sellers who want to
  // use their own vehicle must register it on the platform first.
  const [showTruckModal, setShowTruckModal] = useState(false);
  const [truckForm, setTruckForm] = useState({ ...emptyTruckForm });
  const [truckSubmitting, setTruckSubmitting] = useState(false);
  const [truckError, setTruckError] = useState('');

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

  // FIXED: Register a truck inline. After success, the new truck is
  // immediately selected for this arrangement.
  const registerTruck = async (event) => {
    event.preventDefault();
    setTruckError('');

    if (!truckForm.registration.trim()) {
      setTruckError('Registration plate is required.');
      return;
    }
    if (!truckForm.truckType.trim()) {
      setTruckError('Truck type is required.');
      return;
    }
    if (!truckForm.capacity || Number(truckForm.capacity) <= 0) {
      setTruckError('Enter a valid capacity (tons) greater than zero.');
      return;
    }

    setTruckSubmitting(true);
    try {
      const res = await api.post('/transport/trucks', {
        registration: truckForm.registration.trim(),
        truckType: truckForm.truckType.trim(),
        capacity: Number(truckForm.capacity),
        operatingArea: truckForm.operatingArea.trim(),
      });

      const listRes = await api.get('/transport/trucks/mine');
      setOwnTrucks(Array.isArray(listRes.data?.trucks) ? listRes.data.trucks : []);

      if (res.data?.truck?.id) {
        setTruck(res.data.truck.id);
      }

      setTruckForm({ ...emptyTruckForm });
      setShowTruckModal(false);
    } catch (err) {
      setTruckError(err?.response?.data?.error || 'Could not register truck');
    } finally {
      setTruckSubmitting(false);
    }
  };

  const availableOwnTrucks = ownTrucks.filter((t) => t.availability === 'AVAILABLE');

  return (
    <form className="ts-setup" onSubmit={submit}>
      <p className="ts-lead">
        {buyerOnlyCompetition
          ? 'The buyer controls the transporter competition. Registered truck owners submit sealed quotes, then the buyer selects and negotiates one.'
          : 'Choose who controls the transport arrangement. The buyer remains responsible for paying a hired transporter.'}
      </p>

      {/* ── Who arranges ─────────────────────────────────── */}
      <section className="ts-section">
        <header className="ts-section-head">
          <h3 className="ts-section-title">Who arranges transport</h3>
        </header>

        <div className="ts-choice-grid">
          {canBuyer && (
            <button
              type="button"
              className={`ts-choice${party === 'BUYER' ? ' is-selected' : ''}`}
              onClick={() => setArrangingParty('BUYER')}
            >
              <span className="ts-choice-label">Buyer arranges</span>
              <span className="ts-choice-hint">Buyer controls the request and quote selection.</span>
            </button>
          )}
          {canSeller && !buyerOnlyCompetition && (
            <button
              type="button"
              className={`ts-choice${party === 'SELLER' ? ' is-selected' : ''}`}
              onClick={() => setArrangingParty('SELLER')}
            >
              <span className="ts-choice-label">Seller arranges</span>
              <span className="ts-choice-hint">Seller controls the request and quote selection.</span>
            </button>
          )}
          {canBuyer && canSeller && !buyerOnlyCompetition && (
            <button
              type="button"
              className={`ts-choice${party === 'JOINT' ? ' is-selected' : ''}`}
              onClick={() => {
                setArrangingParty('JOINT');
                if (method === 'OWN_TRUCK') setMethod('HIRE_TRANSPORTER');
              }}
            >
              <span className="ts-choice-label">Joint arrangement</span>
              <span className="ts-choice-hint">Buyer and seller agree together; hired transporter only.</span>
            </button>
          )}
        </div>
      </section>

      {/* ── Method ───────────────────────────────────────── */}
      <section className="ts-section">
        <header className="ts-section-head">
          <h3 className="ts-section-title">Method</h3>
        </header>

        <div className="ts-choice-grid">
          {/* FIXED: Own-truck button is now always shown — buyers and sellers
              both have the option to use their own registered truck. */}
          <button
            type="button"
            disabled={party === 'JOINT'}
            className={`ts-choice${method === 'OWN_TRUCK' && party !== 'JOINT' ? ' is-selected' : ''}`}
            onClick={() => setMethod('OWN_TRUCK')}
          >
            <span className="ts-choice-label">🚚 Use my own truck</span>
            <span className="ts-choice-hint">
              Record your own legally permitted vehicle. No transport-hiring commission.
            </span>
          </button>

          <button
            type="button"
            className={`ts-choice${method === 'HIRE_TRANSPORTER' ? ' is-selected' : ''}`}
            onClick={() => setMethod('HIRE_TRANSPORTER')}
          >
            <span className="ts-choice-label">Hire a registered transporter</span>
            <span className="ts-choice-hint">
              MarketBridge matches by capacity, area, route, availability, rating and verification.
            </span>
          </button>
        </div>

        <p className="ts-notice">
          <strong>Role separation:</strong> Inspectors verify produce and
          evidence; they do not arrange trucks.
        </p>
      </section>

      {error && <div className="alert error ts-alert">{error}</div>}

      {/* ── Trip details ─────────────────────────────────── */}
      <section className="ts-section">
        <header className="ts-section-head">
          <h3 className="ts-section-title">Trip details</h3>
        </header>

        <div className="od-form-grid">
          <div className="od-tf od-tf-span">
            <label>Route (from the order)</label>
            <p className="ts-readonly">
              {pickupLocation || 'Not set'} → {destination || 'Not set'}
            </p>
          </div>
          <div className="od-tf od-tf-span">
            <label>Load (from the listing)</label>
            <p className="ts-readonly">{load || 'Not set'}</p>
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
                    className={`od-chip${on ? ' is-on' : ''}`}
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
                    className={`od-chip${on ? ' is-on' : ''}`}
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
      </section>

      {/* ── Own trucks ───────────────────────────────────── */}
      {method === 'OWN_TRUCK' && (
        <section className="ts-section">
          <header className="ts-section-head">
            <h3 className="ts-section-title">My available trucks</h3>
            <span className="ts-count">{availableOwnTrucks.length}</span>
          </header>

          <div className="ts-rows">
            {availableOwnTrucks.map((t) => (
              <div className="ts-row" key={t.id}>
                <div className="ts-row-info">
                  <strong className="ts-row-name">{t.registration}</strong>
                  <p className="ts-row-meta">
                    {t.truckType} · {t.capacity}t · {t.operatingArea}
                  </p>
                </div>
                <button
                  type="button"
                  className={`od-chip ts-row-btn${truck === t.id ? ' is-on' : ''}`}
                  onClick={() => setTruck(t.id)}
                >
                  {truck === t.id ? 'Selected' : 'Select'}
                </button>
              </div>
            ))}
          </div>

          {/* FIXED: Show a register-a-truck CTA when the user has no available
              trucks. This lets buyers and sellers register their own vehicle
              inline without leaving the transport setup form. */}
          {!availableOwnTrucks.length && (
            <div className="ts-empty-trucks">
              <p className="ts-lead">
                No available truck is registered to your account.
              </p>
              <button
                type="button"
                className="od-chip"
                onClick={() => {
                  setTruckError('');
                  setShowTruckModal(true);
                }}
              >
                + Register a truck
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Registered transporters ──────────────────────── */}
      {method === 'HIRE_TRANSPORTER' && (
        <section className="ts-section">
          <header className="ts-section-head">
            <h3 className="ts-section-title">Registered transporters</h3>
            <button type="button" className="od-chip" onClick={findMatches}>
              Find matches
            </button>
          </header>

          <div className="ts-rows">
            {matches.map((t) => (
              <div className="ts-row" key={t.id}>
                <div className="ts-row-info">
                  <strong className="ts-row-name">{t.owner.name}</strong>
                  <p className="ts-row-meta">
                    {t.truckType} · {t.capacity}t · {t.operatingArea} · ★{' '}
                    {t.owner.rating?.toFixed?.(1) || '—'}
                  </p>
                </div>
                <span className="od-status-pill od-tone-info">Quote later</span>
              </div>
            ))}
          </div>

          {!matches.length && (
            <p className="ts-lead">Enter your details and select "Find matches".</p>
          )}
        </section>
      )}

      {/* ── Submit ──────────────────────────────────────── */}
      <div className="ts-submit">
        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting
            ? 'Submitting…'
            : method === 'HIRE_TRANSPORTER'
              ? 'Create transport request'
              : 'Confirm own-truck arrangement'}
        </button>
      </div>

      {/* ── Inline truck registration modal ─────────────── */}
      {showTruckModal && (
        <div
          className="ts-truck-backdrop"
          role="presentation"
          onClick={() => !truckSubmitting && setShowTruckModal(false)}
        >
          <div
            className="ts-truck-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ts-truck-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="ts-truck-modal-head">
              <h3 id="ts-truck-modal-title">Register a truck</h3>
              <button
                type="button"
                className="od-chip"
                aria-label="Close"
                disabled={truckSubmitting}
                onClick={() => setShowTruckModal(false)}
              >
                Close
              </button>
            </header>

            <p className="ts-lead">
              Once registered, your truck can be used for this delivery and
              becomes available for other jobs on the platform.
            </p>

            {truckError && <div className="alert error ts-alert">{truckError}</div>}

            <form onSubmit={registerTruck}>
              <div className="od-form-grid">
                <div className="od-tf">
                  <label htmlFor="reg-plate">Registration plate</label>
                  <input
                    id="reg-plate"
                    type="text"
                    className="field"
                    required
                    value={truckForm.registration}
                    onChange={(e) => setTruckForm({ ...truckForm, registration: e.target.value })}
                    placeholder="e.g. ET-12345"
                    disabled={truckSubmitting}
                  />
                </div>

                <div className="od-tf">
                  <label htmlFor="reg-type">Truck type</label>
                  <input
                    id="reg-type"
                    type="text"
                    className="field"
                    required
                    value={truckForm.truckType}
                    onChange={(e) => setTruckForm({ ...truckForm, truckType: e.target.value })}
                    placeholder="e.g. Flatbed, Isuzu, FSR"
                    disabled={truckSubmitting}
                  />
                </div>

                <div className="od-tf">
                  <label htmlFor="reg-capacity">Capacity (tons)</label>
                  <input
                    id="reg-capacity"
                    type="number"
                    min="0.1"
                    step="0.1"
                    className="field"
                    required
                    value={truckForm.capacity}
                    onChange={(e) => setTruckForm({ ...truckForm, capacity: e.target.value })}
                    placeholder="e.g. 18"
                    disabled={truckSubmitting}
                  />
                </div>

                <div className="od-tf">
                  <label htmlFor="reg-area">Operating area / routes</label>
                  <input
                    id="reg-area"
                    type="text"
                    className="field"
                    value={truckForm.operatingArea}
                    onChange={(e) => setTruckForm({ ...truckForm, operatingArea: e.target.value })}
                    placeholder="e.g. Addis Ababa – Jimma"
                    disabled={truckSubmitting}
                  />
                </div>
              </div>

              <div className="ts-truck-actions">
                <button
                  type="button"
                  className="od-chip"
                  disabled={truckSubmitting}
                  onClick={() => setShowTruckModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={truckSubmitting}
                >
                  {truckSubmitting ? 'Registering…' : 'Register truck'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </form>
  );
}
