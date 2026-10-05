import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

// ============================================================================
// INSPECTION COORDINATION — INSPECTOR VIEW
// ============================================================================
//
// Appears only when this inspector is the assigned inspector on an inspection
// that is ACCEPTED or later. Shares one coordination row with the seller:
// each party writes only their own field prefix, enforced server-side.
//
// The seller's half is shown read-only and only after they have submitted it.
// The inspector's half is editable until the report is submitted.
// ============================================================================

const PREFERRED_CONTACT_OPTIONS = ['PHONE', 'EMAIL', 'IN_APP'];

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function fmtSlot(slot) {
  return `${fmtDate(slot.date)} · ${slot.startTime} – ${slot.endTime}`;
}

const EMPTY_FORM = {
  inspectorContactName: '',
  inspectorPhone: '',
  inspectorAlternativePhone: '',
  inspectorEmail: '',
  inspectorPreferredContact: 'PHONE',
  inspectorArrivalNotes: '',
  inspectorNotes: '',
};

export default function InspectionCoordinationInspector({ inspectionRequestId }) {
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
      const res = await api.get(`/inspections/${inspectionRequestId}/coordination`);
      const row = res.data?.coordination || {};
      setForm({
        inspectorContactName: row.inspectorContactName || '',
        inspectorPhone: row.inspectorPhone || '',
        inspectorAlternativePhone: row.inspectorAlternativePhone || '',
        inspectorEmail: row.inspectorEmail || '',
        inspectorPreferredContact: row.inspectorPreferredContact || 'PHONE',
        inspectorArrivalNotes: row.inspectorArrivalNotes || '',
        inspectorNotes: row.inspectorNotes || '',
      });
      setSubmittedAt(row.inspectorSubmittedAt || null);

      // Only surface the seller's half once they have submitted it.
      const sellerHasSubmitted = Boolean(row.sellerSubmittedAt);
      setSellerSide(sellerHasSubmitted ? {
        sellerContactName: row.sellerContactName || null,
        sellerPhone: row.sellerPhone || null,
        sellerAlternativePhone: row.sellerAlternativePhone || null,
        sellerEmail: row.sellerEmail || null,
        sellerPreferredContact: row.sellerPreferredContact || null,
        inspectionSite: row.inspectionSite || null,
        meetingPoint: row.meetingPoint || null,
        accessInstructions: row.accessInstructions || null,
        sellerNotes: row.sellerNotes || null,
        sellerSubmittedAt: row.sellerSubmittedAt,
      } : null);

      setAvailability(
        (res.data?.availability || []).filter((s) => s.party === 'INSPECTOR')
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load coordination details');
    } finally {
      setLoading(false);
    }
  }, [inspectionRequestId]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/inspections/${inspectionRequestId}/coordination`, form);
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
      await api.post(`/inspections/${inspectionRequestId}/coordination/availability`, {
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
      await api.delete(`/inspections/${inspectionRequestId}/coordination/availability/${id}`);
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
        <div className="ic-loading">Loading site handoff…</div>
      </section>
    );
  }

  return (
    <section className="inspection-coordination inspection-coordination--inspector">
      <header className="ic-header">
        <div>
          <span className="ic-eyebrow">SITE HANDOFF</span>
          <h4>Coordination with the seller</h4>
          <p className="ic-sub">
            Share your contact, arrival plan, and the times you can visit.
            Visible only to the seller of this listing.
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

      {/* ── Seller's submitted site information ───────────────────── */}
      <div className="ic-inspector-side">
        <h4>Site information from the seller</h4>
        {sellerSide ? (
          <div className="ic-inspector-details">
            {sellerSide.inspectionSite && (
              <div><span>Site</span><strong>{sellerSide.inspectionSite}</strong></div>
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
            {sellerSide.sellerNotes && (
              <div className="ic-full">
                <span>Seller notes</span>
                <strong>{sellerSide.sellerNotes}</strong>
              </div>
            )}
          </div>
        ) : (
          <p className="ic-sub">
            Waiting for the seller to share the site details. You can still save
            your own handoff below.
          </p>
        )}
      </div>

      {/* ── Inspector's own handoff ───────────────────────────────── */}
      <form onSubmit={save} className="ic-form">
        <fieldset>
          <legend>Your contact</legend>
          <div className="ic-grid">
            <label>
              Contact person
              <input value={form.inspectorContactName} onChange={set('inspectorContactName')} placeholder="Your name" />
            </label>
            <label>
              Primary phone
              <input value={form.inspectorPhone} onChange={set('inspectorPhone')} placeholder="+251 ..." />
            </label>
            <label>
              Alternative phone
              <input value={form.inspectorAlternativePhone} onChange={set('inspectorAlternativePhone')} placeholder="Optional" />
            </label>
            <label>
              Email
              <input type="email" value={form.inspectorEmail} onChange={set('inspectorEmail')} placeholder="Optional" />
            </label>
            <label>
              Preferred contact method
              <select value={form.inspectorPreferredContact} onChange={set('inspectorPreferredContact')}>
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
            Estimated arrival notes
            <textarea
              value={form.inspectorArrivalNotes}
              onChange={set('inspectorArrivalNotes')}
              rows={2}
              placeholder="e.g. Arriving around 10:30 AM by taxi. Will call when 15 minutes away."
            />
          </label>
          <label>
            Inspector notes / questions
            <textarea
              value={form.inspectorNotes}
              onChange={set('inspectorNotes')}
              rows={3}
              placeholder="e.g. Please confirm that the entire lot will be accessible when I arrive."
            />
          </label>
        </fieldset>

        <div className="ic-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save my handoff'}
          </button>
        </div>
      </form>

      {/* ── Inspector availability ────────────────────────────────── */}
      <section className="ic-availability">
        <header>
          <h4>My availability</h4>
          <p className="ic-sub">
            Add the date/time windows when you can visit the site. You can add
            more than one.
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
