import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

// ============================================================================
// INSPECTION COORDINATION — SELLER VIEW
// ============================================================================
//
// Appears only when the assigned inspection request is ACCEPTED or later.
// The seller fills in site details, contact info, and availability slots.
// The inspector sees the same row from their own dashboard — the two parties
// share one coordination record, but each can only write their own prefix.
//
// The buyer NEVER sees this component or its data. Access is enforced
// server-side; this UI simply does not exist for non-participants.
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
  sellerContactName: '',
  sellerPhone: '',
  sellerAlternativePhone: '',
  sellerEmail: '',
  sellerPreferredContact: 'PHONE',
  inspectionSite: '',
  meetingPoint: '',
  accessInstructions: '',
  sellerNotes: '',
};

export default function InspectionCoordinationSeller({ inspectionRequestId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [submittedAt, setSubmittedAt] = useState(null);
  const [inspectorSide, setInspectorSide] = useState(null);
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
        sellerContactName: row.sellerContactName || '',
        sellerPhone: row.sellerPhone || '',
        sellerAlternativePhone: row.sellerAlternativePhone || '',
        sellerEmail: row.sellerEmail || '',
        sellerPreferredContact: row.sellerPreferredContact || 'PHONE',
        inspectionSite: row.inspectionSite || '',
        meetingPoint: row.meetingPoint || '',
        accessInstructions: row.accessInstructions || '',
        sellerNotes: row.sellerNotes || '',
      });
      setSubmittedAt(row.sellerSubmittedAt || null);

      // Only surface the inspector's half once they have submitted it —
      // otherwise show a "waiting" state so the seller knows the field exists
      // but is not yet filled.
      const inspectorHasSubmitted = Boolean(row.inspectorSubmittedAt);
      setInspectorSide(inspectorHasSubmitted ? {
        inspectorContactName: row.inspectorContactName || null,
        inspectorPhone: row.inspectorPhone || null,
        inspectorAlternativePhone: row.inspectorAlternativePhone || null,
        inspectorEmail: row.inspectorEmail || null,
        inspectorPreferredContact: row.inspectorPreferredContact || null,
        inspectorArrivalNotes: row.inspectorArrivalNotes || null,
        inspectorNotes: row.inspectorNotes || null,
        inspectorSubmittedAt: row.inspectorSubmittedAt,
      } : null);

      setAvailability(
        (res.data?.availability || []).filter((s) => s.party === 'SELLER')
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
      setNotice('Coordination details saved. The inspector will see them immediately.');
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
      <section className="card inspection-coordination">
        <div className="ic-loading">Loading coordination details…</div>
      </section>
    );
  }

  return (
    <section className="card inspection-coordination" id="inspection-coordination">
      <header className="ic-header">
        <div>
          <span className="ic-eyebrow">INSPECTION COORDINATION</span>
          <h2>Site handoff</h2>
          <p className="ic-sub">
            Tell the inspector where to come, who to ask for, when you are
            available, and any site preparation. This is visible to the
            assigned inspector only.
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

      <form onSubmit={save} className="ic-form">
        <fieldset>
          <legend>Inspection site</legend>
          <div className="ic-grid">
            <label>
              Site / warehouse name
              <input value={form.inspectionSite} onChange={set('inspectionSite')} placeholder="e.g. ABC Farm Main Warehouse" />
            </label>
            <label>
              Specific meeting point
              <input value={form.meetingPoint} onChange={set('meetingPoint')} placeholder="e.g. Main gate, Lot B loading bay" />
            </label>
            <label className="ic-full">
              Access instructions
              <textarea
                value={form.accessInstructions}
                onChange={set('accessInstructions')}
                rows={3}
                placeholder="e.g. Report to the main warehouse gate. Ask for the warehouse supervisor. Bring ID."
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>On-site contact</legend>
          <div className="ic-grid">
            <label>
              Contact person
              <input value={form.sellerContactName} onChange={set('sellerContactName')} placeholder="e.g. Warehouse supervisor" />
            </label>
            <label>
              Primary phone
              <input value={form.sellerPhone} onChange={set('sellerPhone')} placeholder="+251 ..." />
            </label>
            <label>
              Alternative phone
              <input value={form.sellerAlternativePhone} onChange={set('sellerAlternativePhone')} placeholder="Optional" />
            </label>
            <label>
              Email
              <input type="email" value={form.sellerEmail} onChange={set('sellerEmail')} placeholder="Optional" />
            </label>
            <label>
              Preferred contact method
              <select value={form.sellerPreferredContact} onChange={set('sellerPreferredContact')}>
                {PREFERRED_CONTACT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt.replace('_', ' ')}</option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Seller notes</legend>
          <textarea
            value={form.sellerNotes}
            onChange={set('sellerNotes')}
            rows={3}
            placeholder="Anything else the inspector should know before arriving."
          />
        </fieldset>

        <div className="ic-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save coordination details'}
          </button>
        </div>
      </form>

      <section className="ic-availability">
        <header>
          <h3>Availability</h3>
          <p className="ic-sub">
            Add the date/time windows when the site can receive an inspector.
            You can add several.
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

      <section className="ic-inspector-side">
        <h3>Inspector's handoff</h3>
        {inspectorSide ? (
          <div className="ic-inspector-details">
            {inspectorSide.inspectorContactName && (
              <div><span>Contact</span><strong>{inspectorSide.inspectorContactName}</strong></div>
            )}
            {inspectorSide.inspectorPhone && (
              <div><span>Primary phone</span><strong>{inspectorSide.inspectorPhone}</strong></div>
            )}
            {inspectorSide.inspectorAlternativePhone && (
              <div><span>Alternative</span><strong>{inspectorSide.inspectorAlternativePhone}</strong></div>
            )}
            {inspectorSide.inspectorEmail && (
              <div><span>Email</span><strong>{inspectorSide.inspectorEmail}</strong></div>
            )}
            {inspectorSide.inspectorPreferredContact && (
              <div><span>Preferred contact</span><strong>{inspectorSide.inspectorPreferredContact}</strong></div>
            )}
            {inspectorSide.inspectorArrivalNotes && (
              <div className="ic-full"><span>Arrival notes</span><strong>{inspectorSide.inspectorArrivalNotes}</strong></div>
            )}
            {inspectorSide.inspectorNotes && (
              <div className="ic-full"><span>Inspector notes</span><strong>{inspectorSide.inspectorNotes}</strong></div>
            )}
          </div>
        ) : (
          <p className="ic-sub">
            Waiting for the inspector to share their contact and arrival details.
          </p>
        )}
      </section>

      <p className="ic-footnote">
        Contact information here is visible only to you and the assigned inspector.
        The buyer does not see these details.
      </p>
    </section>
  );
}
