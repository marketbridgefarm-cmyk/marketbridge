import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import EvidenceUploader from './EvidenceUploader.jsx';

// ============================================================================
// TRANSPORT COORDINATION — SELLER VIEW
// ============================================================================
//
// Appears only when the transport job is ACCEPTED or later and the viewer is
// the seller of the listing. The seller fills in pickup site details, contact,
// availability, and prep photos for the driver. The driver sees the same row
// from their own card. The two parties share one coordination record, but each
// can only write their own prefix.
//
// The buyer NEVER sees this component or its data. Access is enforced
// server-side by transportCoordinationService.viewerRoleFor.
// ============================================================================

const PREFERRED_CONTACT_OPTIONS = ['PHONE', 'EMAIL', 'IN_APP'];

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

const EMPTY_FORM = {
  sellerContactName: '',
  sellerPhone: '',
  sellerAlternativePhone: '',
  sellerEmail: '',
  sellerPreferredContact: 'PHONE',
  pickupSite: '',
  meetingPoint: '',
  accessInstructions: '',
  sellerPrepNotes: '',
};

export default function TransportCoordinationSeller({ transportJobId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [sitePhotos, setSitePhotos] = useState([]);
  const [prepPhotos, setPrepPhotos] = useState([]);
  const [submittedAt, setSubmittedAt] = useState(null);

  const [driverSide, setDriverSide] = useState(null);
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
        sellerContactName: row.sellerContactName || '',
        sellerPhone: row.sellerPhone || '',
        sellerAlternativePhone: row.sellerAlternativePhone || '',
        sellerEmail: row.sellerEmail || '',
        sellerPreferredContact: row.sellerPreferredContact || 'PHONE',
        pickupSite: row.pickupSite || '',
        meetingPoint: row.meetingPoint || '',
        accessInstructions: row.accessInstructions || '',
        sellerPrepNotes: row.sellerPrepNotes || '',
      });
      setSitePhotos(Array.isArray(row.sellerSitePhotos) ? row.sellerSitePhotos : []);
      setPrepPhotos(Array.isArray(row.sellerPrepPhotos) ? row.sellerPrepPhotos : []);
      setSubmittedAt(row.sellerSubmittedAt || null);

      const driverHasSubmitted = Boolean(row.driverSubmittedAt);
      setDriverSide(driverHasSubmitted ? {
        driverContactName: row.driverContactName || null,
        driverPhone: row.driverPhone || null,
        driverAlternativePhone: row.driverAlternativePhone || null,
        driverEmail: row.driverEmail || null,
        driverPreferredContact: row.driverPreferredContact || null,
        driverArrivalEta: row.driverArrivalEta || null,
        driverArrivalNotes: row.driverArrivalNotes || null,
        driverEquipment: Array.isArray(row.driverEquipment) ? row.driverEquipment : [],
        driverNotes: row.driverNotes || null,
        driverSubmittedAt: row.driverSubmittedAt,
      } : null);

      setAvailability(
        (res.data?.availability || []).filter((s) => s.party === 'SELLER')
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load coordination details');
    } finally {
      setLoading(false);
    }
  }, [transportJobId]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/transport/${transportJobId}/coordination`, {
        ...form,
        sellerSitePhotos: sitePhotos,
        sellerPrepPhotos: prepPhotos,
      });
      setNotice('Coordination details saved. The driver will see them immediately.');
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
      <section className="card inspection-coordination">
        <div className="ic-loading">Loading transport coordination…</div>
      </section>
    );
  }

  return (
    <section className="card inspection-coordination" id="transport-coordination">
      <header className="ic-header">
        <div>
          <span className="ic-eyebrow">TRANSPORT COORDINATION</span>
          <h2>Pickup handoff</h2>
          <p className="ic-sub">
            Tell the driver where to come, who to ask for, when you are available,
            and what to expect at the pickup site. Visible only to the assigned
            transporter.
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
          <legend>Pickup site</legend>
          <div className="ic-grid">
            <label>
              Site / farm / warehouse
              <input
                value={form.pickupSite}
                onChange={set('pickupSite')}
                placeholder="e.g. ABC Farm main warehouse"
              />
            </label>
            <label>
              Specific meeting point
              <input
                value={form.meetingPoint}
                onChange={set('meetingPoint')}
                placeholder="e.g. Main gate, Lot B loading bay"
              />
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
              <input
                value={form.sellerContactName}
                onChange={set('sellerContactName')}
                placeholder="e.g. Warehouse supervisor"
              />
            </label>
            <label>
              Primary phone
              <input
                value={form.sellerPhone}
                onChange={set('sellerPhone')}
                placeholder="+251 ..."
              />
            </label>
            <label>
              Alternative phone
              <input
                value={form.sellerAlternativePhone}
                onChange={set('sellerAlternativePhone')}
                placeholder="Optional"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={form.sellerEmail}
                onChange={set('sellerEmail')}
                placeholder="Optional"
              />
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
          <legend>Seller preparation notes</legend>
          <textarea
            value={form.sellerPrepNotes}
            onChange={set('sellerPrepNotes')}
            rows={3}
            placeholder="Anything the driver should know before arriving."
          />
        </fieldset>

        <fieldset>
          <legend>Site photo</legend>
          <p className="ic-sub">
            Optional photo of the gate, entrance, or warehouse exterior so the
            driver recognises the site.
          </p>
          <EvidenceUploader
            uploadUrl={`/transport/${transportJobId}/evidence/media`}
            disabled={saving}
            onUploaded={({ photoKeys }) =>
              setSitePhotos((prev) => [...prev, ...photoKeys])
            }
          />
          {sitePhotos.length > 0 && (
            <ul className="ic-slot-list">
              {sitePhotos.map((key, i) => (
                <li key={key} className="ic-slot">
                  <span>Site photo {i + 1}</span>
                  <button
                    type="button"
                    className="ic-slot-remove"
                    onClick={() => setSitePhotos((prev) => prev.filter((k) => k !== key))}
                    aria-label="Remove site photo"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset>
          <legend>Goods preparation photos</legend>
          <p className="ic-sub">
            Optional photos of the goods ready for loading — packaging, lots,
            weight tags. The driver will see these before arrival.
          </p>
          <EvidenceUploader
            uploadUrl={`/transport/${transportJobId}/evidence/media`}
            disabled={saving}
            onUploaded={({ photoKeys }) =>
              setPrepPhotos((prev) => [...prev, ...photoKeys])
            }
          />
          {prepPhotos.length > 0 && (
            <ul className="ic-slot-list">
              {prepPhotos.map((key, i) => (
                <li key={key} className="ic-slot">
                  <span>Prep photo {i + 1}</span>
                  <button
                    type="button"
                    className="ic-slot-remove"
                    onClick={() => setPrepPhotos((prev) => prev.filter((k) => k !== key))}
                    aria-label="Remove prep photo"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
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
            Add the date/time windows when the goods can be loaded. You can add
            several.
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
        <h3>Driver's handoff</h3>
        {driverSide ? (
          <div className="ic-inspector-details">
            {driverSide.driverContactName && (
              <div><span>Driver</span><strong>{driverSide.driverContactName}</strong></div>
            )}
            {driverSide.driverPhone && (
              <div><span>Primary phone</span><strong>{driverSide.driverPhone}</strong></div>
            )}
            {driverSide.driverAlternativePhone && (
              <div><span>Alternative</span><strong>{driverSide.driverAlternativePhone}</strong></div>
            )}
            {driverSide.driverEmail && (
              <div><span>Email</span><strong>{driverSide.driverEmail}</strong></div>
            )}
            {driverSide.driverPreferredContact && (
              <div><span>Preferred contact</span><strong>{driverSide.driverPreferredContact}</strong></div>
            )}
            {driverSide.driverArrivalEta && (
              <div><span>Estimated arrival</span><strong>{fmtDateTime(driverSide.driverArrivalEta)}</strong></div>
            )}
            {driverSide.driverArrivalNotes && (
              <div className="ic-full"><span>Arrival notes</span><strong>{driverSide.driverArrivalNotes}</strong></div>
            )}
            {Array.isArray(driverSide.driverEquipment) && driverSide.driverEquipment.length > 0 && (
              <div className="ic-full">
                <span>Equipment on truck</span>
                <div className="ic-slot-list" style={{ marginTop: 4 }}>
                  {driverSide.driverEquipment.map((item) => (
                    <span key={item} className="ic-slot">{item.replaceAll('_', ' ').toLowerCase()}</span>
                  ))}
                </div>
              </div>
            )}
            {driverSide.driverNotes && (
              <div className="ic-full"><span>Driver notes</span><strong>{driverSide.driverNotes}</strong></div>
            )}
          </div>
        ) : (
          <p className="ic-sub">
            Waiting for the driver to share their contact and arrival details.
          </p>
        )}
      </section>

      <p className="ic-footnote">
        Contact information here is visible only to you and the assigned
        transporter. The buyer does not see these details.
      </p>
    </section>
  );
}
