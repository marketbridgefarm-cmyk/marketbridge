import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import './ProvidersCoordination.css'; // <--- Add this line

// ============================================================================
// TRANSPORT COORDINATION — TRANSPORTER VIEW
// ============================================================================
//
// Appears only when this viewer is the assigned truck owner on a transport
// job that is ACCEPTED or later. Shares one coordination row with the seller:
// each party writes only their own field prefix, enforced server-side.
//
// The seller's half is shown read-only and only after they have submitted it.
// The driver's half is editable until the loading report is filed.
//
// The buyer NEVER sees this component or its data. Access is enforced
// server-side by transportCoordinationService.viewerRoleFor.
// ============================================================================

const PREFERRED_CONTACT_OPTIONS = ['PHONE', 'EMAIL', 'IN_APP'];

const EQUIPMENT_OPTIONS = [
  ['STRAPS_ROPES', 'Straps / ropes'],
  ['TARPAULIN', 'Tarpaulin / cover'],
  ['SACK_TRUCK', 'Sack truck / hand trolley'],
  ['FORKLIFT', 'Forklift'],
  ['CRANE', 'Crane / lifting gear'],
  ['REFRIGERATION', 'Refrigeration running'],
  ['LIVE_ANIMAL_RAMP', 'Livestock ramp'],
  ['SPARE_TYRE', 'Spare tyre / tools'],
  ['OTHER', 'Other equipment'],
];

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSlot(slot) {
  return `${fmtDate(slot.date)} · ${slot.startTime} – ${slot.endTime}`;
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" (local, no seconds).
function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const EMPTY_FORM = {
  driverContactName: '',
  driverPhone: '',
  driverAlternativePhone: '',
  driverEmail: '',
  driverPreferredContact: 'PHONE',
  driverArrivalEta: '',
  driverArrivalNotes: '',
  driverEquipment: [],
  driverNotes: '',
};

export default function TransportCoordinationTransporter({ transportJobId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [submittedAt, setSubmittedAt] = useState(null);

  const [sellerSide, setSellerSide] = useState(null);
  const [availability, setAvailability] = useState([]);

  const [slotDate, setSlotDate] = useState('');
  const [slotStart, setSlotStart] = useState('');
  const [slotEnd, setSlotEnd] = useState('');
  const [slotBusy, setSlotBusy] = useState(false);
  const [slotError, setSlotError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/transport/${transportJobId}/coordination`);
      const row = res.data?.coordination || {};

      setForm({
        driverContactName: row.driverContactName || '',
        driverPhone: row.driverPhone || '',
        driverAlternativePhone: row.driverAlternativePhone || '',
        driverEmail: row.driverEmail || '',
        driverPreferredContact: row.driverPreferredContact || 'PHONE',
        driverArrivalEta: toLocalInput(row.driverArrivalEta),
        driverArrivalNotes: row.driverArrivalNotes || '',
        driverEquipment: Array.isArray(row.driverEquipment) ? row.driverEquipment : [],
        driverNotes: row.driverNotes || '',
      });
      setSubmittedAt(row.driverSubmittedAt || null);

      const sellerHasSubmitted = Boolean(row.sellerSubmittedAt);
      setSellerSide(sellerHasSubmitted ? {
        sellerContactName: row.sellerContactName || null,
        sellerPhone: row.sellerPhone || null,
        sellerAlternativePhone: row.sellerAlternativePhone || null,
        sellerEmail: row.sellerEmail || null,
        sellerPreferredContact: row.sellerPreferredContact || null,
        pickupSite: row.pickupSite || null,
        meetingPoint: row.meetingPoint || null,
        accessInstructions: row.accessInstructions || null,
        sellerPrepNotes: row.sellerPrepNotes || null,
        sellerSitePhotos: Array.isArray(row.sellerSitePhotos) ? row.sellerSitePhotos : [],
        sellerPrepPhotos: Array.isArray(row.sellerPrepPhotos) ? row.sellerPrepPhotos : [],
        sellerSubmittedAt: row.sellerSubmittedAt,
      } : null);

      setAvailability(
        (res.data?.availability || []).filter((s) => s.party === 'TRANSPORTER')
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load coordination details');
    } finally {
      setLoading(false);
    }
  }, [transportJobId]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function toggleEquipment(code) {
    setForm((f) => {
      const current = Array.isArray(f.driverEquipment) ? f.driverEquipment : [];
      const has = current.includes(code);
      const withoutOther = code === 'OTHER' ? current.filter((c) => c !== 'OTHER') : current;
      const next = has
        ? withoutOther.filter((c) => c !== code)
        : [...withoutOther, code];
      return { ...f, driverEquipment: next };
    });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/transport/${transportJobId}/coordination`, {
        ...form,
        driverArrivalEta: toIso(form.driverArrivalEta),
      });
      setNotice('Your handoff details have been saved. The seller can now see them.');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save coordination details');
    } finally {
      setSaving(false);
    }
  }

  async function addSlot(e) {
    e.preventDefault();
    if (!slotDate || !slotStart || !slotEnd) {
      setSlotError('Date, start time, and end time are required.');
      return;
    }
    if (slotStart >= slotEnd) {
      setSlotError('Start time must be before end time.');
      return;
    }
    setSlotBusy(true);
    setSlotError('');
    try {
      await api.post(`/transport/${transportJobId}/coordination/availability`, {
        date: slotDate,
        startTime: slotStart,
        endTime: slotEnd,
      });
      setSlotDate('');
      setSlotStart('');
      setSlotEnd('');
      await load();
    } catch (err) {
      setSlotError(err.response?.data?.error || 'Could not add availability slot');
    } finally {
      setSlotBusy(false);
    }
  }

  async function removeSlot(id) {
    setSlotBusy(true);
    setSlotError('');
    try {
      await api.delete(`/transport/${transportJobId}/coordination/availability/${id}`);
      await load();
    } catch (err) {
      setSlotError(err.response?.data?.error || 'Could not remove availability slot');
    } finally {
      setSlotBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="inspection-coordination inspection-coordination--inspector">
        <div className="ic-loading">Loading pickup handoff…</div>
      </section>
    );
  }

  return (
    <section className="inspection-coordination inspection-coordination--inspector">
      <header className="ic-header">
        <div>
          <span className="ic-eyebrow">PICKUP HANDOFF</span>
          <h4>Coordination with the seller</h4>
          <p className="ic-sub">
            Share your contact, arrival plan, and the times you can reach the
            pickup site. Visible only to the seller of this listing.
          </p>
        </div>
        {submittedAt && (
          <span className="ic-status ic-status--sent">
            Sent {fmtDate(submittedAt)}
          </span>
        )}
      </header>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      {/* ── Seller's submitted site information ─────────────────────────── */}
      <div className="ic-inspector-side">
        <h4>Site information from the seller</h4>
        {sellerSide ? (
          <>
            <div className="ic-inspector-details">
              {sellerSide.pickupSite && (
                <div><span>Site</span><strong>{sellerSide.pickupSite}</strong></div>
              )}
              {sellerSide.meetingPoint && (
                <div><span>Meeting point</span><strong>{sellerSide.meetingPoint}</strong></div>
              )}
              {sellerSide.sellerContactName && (
                <div><span>Contact person</span><strong>{sellerSide.sellerContactName}</strong></div>
              )}
              {sellerSide.sellerPhone && (
                <div><span>Primary phone</span><strong>{sellerSide.sellerPhone}</strong></div>
              )}
              {sellerSide.sellerAlternativePhone && (
                <div><span>Alternative</span><strong>{sellerSide.sellerAlternativePhone}</strong></div>
              )}
              {sellerSide.sellerEmail && (
                <div><span>Email</span><strong>{sellerSide.sellerEmail}</strong></div>
              )}
              {sellerSide.sellerPreferredContact && (
                <div><span>Preferred contact</span><strong>{sellerSide.sellerPreferredContact}</strong></div>
              )}
              {sellerSide.accessInstructions && (
                <div className="ic-full">
                  <span>Access instructions</span>
                  <strong>{sellerSide.accessInstructions}</strong>
                </div>
              )}
              {sellerSide.sellerPrepNotes && (
                <div className="ic-full">
                  <span>Seller notes</span>
                  <strong>{sellerSide.sellerPrepNotes}</strong>
                </div>
              )}
            </div>

            {sellerSide.sellerSitePhotos.length > 0 && (
              <div className="ic-full" style={{ marginTop: 10 }}>
                <span className="ic-inspector-side-label">Site photos</span>
                <p className="muted small">
                  {sellerSide.sellerSitePhotos.length} photo(s) — open the
                  transport evidence gallery below to view.
                </p>
              </div>
            )}
            {sellerSide.sellerPrepPhotos.length > 0 && (
              <div className="ic-full" style={{ marginTop: 10 }}>
                <span className="ic-inspector-side-label">Goods preparation photos</span>
                <p className="muted small">
                  {sellerSide.sellerPrepPhotos.length} photo(s) — open the
                  transport evidence gallery below to view.
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="ic-sub">
            Waiting for the seller to share the pickup site details. You can
            still save your own handoff below.
          </p>
        )}
      </div>

      {/* ── Driver's own handoff ────────────────────────────────────────── */}
      <form onSubmit={save} className="ic-form">
        <fieldset>
          <legend>Your contact</legend>
          <div className="ic-grid">
            <label>
              Driver name
              <input
                value={form.driverContactName}
                onChange={set('driverContactName')}
                placeholder="Your name"
              />
            </label>
            <label>
              Primary phone
              <input
                value={form.driverPhone}
                onChange={set('driverPhone')}
                placeholder="+251 ..."
              />
            </label>
            <label>
              Alternative phone
              <input
                value={form.driverAlternativePhone}
                onChange={set('driverAlternativePhone')}
                placeholder="Optional"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={form.driverEmail}
                onChange={set('driverEmail')}
                placeholder="Optional"
              />
            </label>
            <label>
              Preferred contact method
              <select value={form.driverPreferredContact} onChange={set('driverPreferredContact')}>
                {PREFERRED_CONTACT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt.replace('_', ' ')}</option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Arrival</legend>
          <label>
            Estimated arrival at the pickup site
            <input
              type="datetime-local"
              value={form.driverArrivalEta}
              onChange={set('driverArrivalEta')}
            />
          </label>
          <label>
            Arrival notes
            <textarea
              value={form.driverArrivalNotes}
              onChange={set('driverArrivalNotes')}
              rows={2}
              placeholder="e.g. Arriving around 10:30 AM. Will call when 15 minutes away."
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Equipment on truck</legend>
          <div className="ic-check-grid">
            {EQUIPMENT_OPTIONS.map(([code, text]) => (
              <label key={code}>
                <input
                  type="checkbox"
                  checked={(form.driverEquipment || []).includes(code)}
                  onChange={() => toggleEquipment(code)}
                />
                {text}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Driver notes / questions</legend>
          <textarea
            value={form.driverNotes}
            onChange={set('driverNotes')}
            rows={3}
            placeholder="e.g. Please confirm whether the entire lot will be accessible when I arrive."
          />
        </fieldset>

        <div className="ic-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save my handoff'}
          </button>
        </div>
      </form>

      {/* ── Transporter availability ────────────────────────────────────── */}
      <section className="ic-availability">
        <header>
          <h4>My availability</h4>
          <p className="ic-sub">
            Add the date/time windows when you can reach the pickup site. You
            can add more than one.
          </p>
        </header>

        {availability.length > 0 ? (
          <ul className="ic-slot-list">
            {availability.map((slot) => (
              <li key={slot.id} className="ic-slot">
                <span>{fmtSlot(slot)}</span>
                <button
                  type="button"
                  className="ic-slot-remove"
                  onClick={() => removeSlot(slot.id)}
                  disabled={slotBusy}
                  aria-label="Remove availability slot"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ic-sub">No availability slots added yet.</p>
        )}

        <form onSubmit={addSlot} className="ic-slot-form">
          <input type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} required />
          <input type="time" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} required />
          <span className="ic-slot-dash">–</span>
          <input type="time" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} required />
          <button type="submit" className="btn btn-light" disabled={slotBusy}>
            {slotBusy ? 'Adding…' : '+ Add'}
          </button>
        </form>
        {slotError && <div className="alert error">{slotError}</div>}
      </section>

      <p className="ic-footnote">
        Only the seller of this listing can see these details. The buyer does
        not see your contact information.
      </p>
    </section>
  );
}
