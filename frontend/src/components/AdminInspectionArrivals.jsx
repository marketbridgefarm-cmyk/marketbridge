import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { ReliabilityBadge } from './InspectionArrivalPanel.jsx';
import FilterFab from './FilterFab.jsx';

// Admin queue for disputed inspector arrivals. The seller said "the inspector
// is not here"; the inspector's check-in (GPS + photo) says otherwise. The
// admin sees both and rules ARRIVED or NO_SHOW.

const REASON_LABEL = {
  NOT_PRESENT: 'Nobody has come',
  WRONG_PERSON: 'Someone else came',
  WRONG_PLACE: 'Not at the seller\'s location',
};

const STATUS_FILTERS = [
  { value: 'DISPUTED', label: 'Needs a ruling' },
  { value: 'PENDING_SELLER', label: 'Waiting for seller' },
  { value: 'RESOLVED_ARRIVED', label: 'Ruled: arrived' },
  { value: 'RESOLVED_NO_SHOW', label: 'Ruled: no-show' },
];

const fmt = (v) => (v ? new Date(v).toLocaleString() : '—');
const mapLink = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

export default function AdminInspectionArrivals({ onCount }) {
  const [status, setStatus] = useState('DISPUTED');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [photos, setPhotos] = useState({});
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/admin/inspection-arrivals', { params: { status } });
      setRows(res.data.arrivals || []);
      if (status === 'DISPUTED' && onCount) onCount((res.data.arrivals || []).length);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not load arrivals');
    } finally {
      setLoading(false);
    }
  }, [status, onCount]);

  useEffect(() => { load(); }, [load]);

  async function showPhoto(id) {
    try {
      const res = await api.get(`/admin/inspection-arrivals/${id}/photo`);
      setPhotos((p) => ({ ...p, [id]: res.data.photos?.[0]?.url || '' }));
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not load the photo');
    }
  }

  async function resolve(id, outcome) {
    if (outcome === 'NO_SHOW' && !window.confirm('Rule NO-SHOW? Bidding reopens and the inspector receives a standing penalty.')) return;
    setBusy(`${id}:${outcome}`);
    setError('');
    setMessage('');
    try {
      const res = await api.post(`/admin/inspection-arrivals/${id}/resolve`, { outcome, note: notes[id] || undefined });
      setMessage(res.data?.message || 'Ruling saved.');
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save the ruling (admin MFA is required).');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="ac-panel">
      <div className="ac-toolbar">
        <div>
          <span className="ac-section-label">INSPECTOR ARRIVALS</span>
          <h2>Disputed arrivals</h2>
          <p>The seller says the inspector was not there. Compare the inspector&apos;s GPS fix and photo, then rule.</p>
        </div>
        <button type="button" className="sd-btn sd-btn-outline" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <FilterFab
        label="Filter arrivals"
        stacked
        groups={[{
          title: 'Status',
          value: status,
          defaultValue: 'DISPUTED',
          onChange: setStatus,
          options: STATUS_FILTERS.map((f) => ({ id: f.value, label: f.label })),
        }]}
      />

      {message && <p className="ac-success">{message}</p>}
      {error && <p className="ac-error">{error}</p>}
      {!loading && rows.length === 0 && <p className="muted">Nothing here.</p>}

      {rows.map((r) => (
        <article key={r.id} className="ac-card" style={{ marginBottom: 14 }}>
          <header>
            <strong>{r.listing?.title || 'Listing'}</strong>
            <span className="muted small"> · order {String(r.orderId || '').slice(0, 8)} · {r.status.replace(/_/g, ' ').toLowerCase()}</span>
          </header>
          <p className="small">
            Inspector <strong>{r.inspector?.name}</strong> <ReliabilityBadge reliability={r.inspector?.reliability} />
            {' · '}Seller <strong>{r.seller?.name || '—'}</strong>
          </p>
          <ul className="small">
            <li>Checked in: {fmt(r.checkedInAt)}{r.late ? ' (after the agreed time)' : ''}</li>
            <li>
              GPS: <a href={mapLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer">{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}</a>
              {r.accuracyMeters != null ? ` (±${Math.round(r.accuracyMeters)} m)` : ''}
              {r.distanceKm != null ? ` · ${(Math.round(r.distanceKm * 10) / 10)} km from the listing${r.flagged ? ' (FAR)' : ''}` : ' · listing has no coordinates'}
            </li>
            <li>Handshake code: {r.codeVerified ? 'entered correctly' : 'not used'}</li>
            {r.disputeReason && <li>Seller says: <strong>{REASON_LABEL[r.disputeReason] || r.disputeReason}</strong> ({fmt(r.disputedAt)})</li>}
            {r.adminNote && <li>Admin note: {r.adminNote}</li>}
          </ul>

          {r.photoCount > 0 && (photos[r.id]
            ? <img src={photos[r.id]} alt="Inspector check-in" style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 12 }} />
            : <button type="button" className="sd-btn sd-btn-outline" onClick={() => showPhoto(r.id)}>View check-in photo</button>)}

          {r.status === 'DISPUTED' && (
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              <textarea
                rows={2}
                maxLength={1000}
                placeholder="Optional note for the record"
                value={notes[r.id] || ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="sd-btn sd-btn-primary" disabled={Boolean(busy)} onClick={() => resolve(r.id, 'ARRIVED')}>
                  Ruling: inspector was there
                </button>
                <button type="button" className="sd-btn sd-btn-danger" disabled={Boolean(busy)} onClick={() => resolve(r.id, 'NO_SHOW')}>
                  Ruling: no-show
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
