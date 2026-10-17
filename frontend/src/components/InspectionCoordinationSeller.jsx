import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import './ProvidersCoordination.css';

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
//
// FIXED: this component now:
//   • shows a live countdown for the inspector's 3-hour handoff window
//   • owns the "Accept inspector and fee" action (merged from the
//     old arrival + fee-lock steps)
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

// ── Countdown hook ──────────────────────────────────────────────────────────
// Ticks every second until the target passes. Returns formatted components
// ready for a `<HH>:<MM>:<SS>` display plus an `expired` flag. If `targetMs`
// is null or undefined, the hook is inert (active: false).
function useCountdown(targetMs) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetMs) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [targetMs]);

  if (!targetMs) {
    return { active: false, expired: false, hours: '00', minutes: '00', seconds: '00' };
  }

  const remaining = Math.max(0, targetMs - now);
  const totalSecs = Math.floor(remaining / 1000);
  const hh = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSecs % 60).padStart(2, '0');

  return {
    active: true,
    expired: remaining <= 0,
    hours: hh,
    minutes: mm,
    seconds: ss,
  };
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

  // Confirmation + countdown state
  const [status, setStatus] = useState(null);
  const [sellerConfirmedAt, setSellerConfirmedAt] = useState(null);
  const [inspectorOnSiteConfirmedAt, setInspectorOnSiteConfirmedAt] = useState(null);
  const [coordinationDueAt, setCoordinationDueAt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [confirmNotice, setConfirmNotice] = useState('');

  const countdown = useCountdown(coordinationDueAt ? new Date(coordinationDueAt).getTime() : null);
  const inspectorHandoffSubmitted = Boolean(inspectorSide?.inspectorSubmittedAt);
  const countdownTone =
    inspectorHandoffSubmitted ? 'done'
    : countdown.expired ? 'expired'
    : (countdown.hours === '00' && Number(countdown.minutes) < 15) ? 'danger'
    : (countdown.hours === '00' && Number(countdown.minutes) < 60) ? 'warn'
    : 'safe';

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

      setStatus(res.data?.status || null);
      setSellerConfirmedAt(res.data?.sellerConfirmedAt || null);
      setInspectorOnSiteConfirmedAt(res.data?.inspectorOnSiteConfirmedAt || null);
      setCoordinationDueAt(res.data?.coordinationDueAt || null);
    } catch (err) {
      // A 409 with COORDINATION_WINDOW_EXPIRED means the server has already
      // lapsed the agreement when we asked for the state. Show it cleanly
      // rather than a raw error string.
      if (err.response?.data?.code === 'COORDINATION_WINDOW_EXPIRED') {
        setError(err.response?.data?.error || 'The inspector\'s handoff window has expired.');
      } else {
        setError(err.response?.data?.error || 'Could not load coordination details');
      }
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
        <div className="ic-header-main">
          <span className="ic-eyebrow">INSPECTION COORDINATION</span>
          <h2>Site handoff</h2>
        </div>
        {submittedAt && (
          <span className="ic-status ic-status--sent">
            Sent {fmtDate(submittedAt)}
          </span>
        )}
      </header>

      <p className="ic-header-text">
        Tell the inspector where to come, who to ask for, when you are
        available, and any site preparation. This is visible to the assigned
        inspector only.
      </p>

      {/* ── Inspector handoff countdown ─────────────────────────────────
             Shown while the inspector has a live 3-hour window to submit
             their arrival details. Disappears once they have submitted or
             once the agreement is confirmed. ─────────────────────────── */}
      {coordinationDueAt && !sellerConfirmedAt && (
        <div className={`ic-countdown ic-countdown--${countdownTone}`} role="status" aria-live="polite">
          <div className="ic-countdown-label">
            {inspectorHandoffSubmitted
              ? 'Inspector handoff received'
              : 'Waiting for inspector handoff'}
          </div>

          <div className="ic-countdown-clock">
            {inspectorHandoffSubmitted ? (
              <span className="ic-countdown-num">Submitted</span>
            ) : countdown.expired ? (
              <span className="ic-countdown-num">Expired</span>
            ) : (
              <>
                <span className="ic-countdown-num">{countdown.hours}</span>
                <span className="ic-countdown-sep">:</span>
                <span className="ic-countdown-num">{countdown.minutes}</span>
                <span className="ic-countdown-sep">:</span>
                <span className="ic-countdown-num">{countdown.seconds}</span>
                <span className="ic-countdown-unit">left</span>
              </>
            )}
          </div>

          <p className="ic-countdown-text">
            {inspectorHandoffSubmitted
              ? 'The inspector has shared their arrival details. You can now accept the inspector and fee below.'
              : countdown.expired
                ? 'The window has closed without a handoff. The provisional agreement has lapsed and the request returns to bidding.'
                : 'The inspector has 3 hours from acceptance to share their arrival details. If they do not, the agreement lapses and the request returns to bidding.'}
          </p>
        </div>
      )}

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
          <>
            <div className="ic-inspector-details ic-inspector-details--cols">
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
            </div>

            {(inspectorSide.inspectorArrivalNotes || inspectorSide.inspectorNotes) && (
              <div className="ic-inspector-blocks">
                {inspectorSide.inspectorArrivalNotes && (
                  <div className="ic-inspector-block">
                    <span>Arrival notes</span>
                    <strong>{inspectorSide.inspectorArrivalNotes}</strong>
                  </div>
                )}
                {inspectorSide.inspectorNotes && (
                  <div className="ic-inspector-block">
                    <span>Inspector notes</span>
                    <strong>{inspectorSide.inspectorNotes}</strong>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="ic-sub">
            Waiting for the inspector to share their contact and arrival details.
          </p>
        )}
      </section>

      {/* ── "Accept inspector and fee" action (arrival is proven later by the inspector's check-in) ── */}
      <section className="ic-confirm">
        <header>
          <h3>Accept inspector and fee</h3>
          <p className="ic-sub">
            Accept the selected inspector and the agreed fee. This is not the
            on-site confirmation: when the inspector arrives they check in with
            their location and a photo, and you will get a 4-digit code to read
            out to them. The fee is paid only after their arrival is confirmed.
            Only available after you and the inspector have both submitted
            your coordination handoffs.
          </p>
        </header>

        {sellerConfirmedAt ? (
          <p className="ic-sub">
            <strong>✓ Inspector and fee accepted on {fmtDate(sellerConfirmedAt)}.</strong>
            {inspectorOnSiteConfirmedAt
              ? ' The inspector\'s arrival is confirmed and the agreed fee can now be paid.'
              : ' Waiting for the inspector to check in on site.'}
          </p>
        ) : status !== 'ACCEPTED' ? (
          <p className="ic-sub">
            Confirmation is available only while the inspection is awaiting
            the seller. Current status: {status || '—'}.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                confirming ||
                !submittedAt ||
                !inspectorHandoffSubmitted
              }
              onClick={async () => {
                setConfirming(true);
                setConfirmError('');
                setConfirmNotice('');
                try {
                  await api.post(`/inspections/${inspectionRequestId}/seller-confirm`);
                  setConfirmNotice('Inspector and fee accepted. The inspector checks in when they arrive; the fee is paid after that.');
                  await load();
                } catch (err) {
                  setConfirmError(
                    err.response?.data?.error ||
                    'Could not accept the inspector and fee'
                  );
                } finally {
                  setConfirming(false);
                }
              }}
            >
              {confirming ? 'Accepting…' : 'Accept inspector and fee'}
            </button>

            {(!submittedAt || !inspectorHandoffSubmitted) && (
              <p className="ic-sub">
                {!submittedAt
                  ? 'Save your site handoff details above first.'
                  : 'Waiting for the inspector to submit their arrival details.'}
              </p>
            )}
          </>
        )}

        {confirmError && <div className="alert error">{confirmError}</div>}
        {confirmNotice && <div className="alert success">{confirmNotice}</div>}
      </section>

      <p className="ic-footnote">
        Contact information here is visible only to you and the assigned inspector.
        The buyer does not see these details.
      </p>
    </section>
  );
}
