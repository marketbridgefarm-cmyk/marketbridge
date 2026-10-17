import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import './InspectionArrivalPanel.css';

// ============================================================================
// Inspector arrival: check-in, handshake code, seller answer, dispute.
//
//   inspector: "Check in on site"  -> GPS + photo (+ optional 4-digit code)
//   seller:    reads the code to the inspector, or answers "Yes, they're here"
//              / "No, they're not here" (closed reasons only, no typing)
//   buyer:     sees the status
//
// variant="summary" renders only the fee, inspector and visit date.
// ============================================================================

const DISPUTE_REASONS = [
  { code: 'NOT_PRESENT', label: 'Nobody has come' },
  { code: 'WRONG_PERSON', label: 'Someone else came' },
  { code: 'WRONG_PLACE', label: 'They are not at my location' },
];

const TIER_LABEL = {
  HIGHLY_RELIABLE: 'Highly reliable',
  RELIABLE: 'Reliable',
  NEEDS_IMPROVEMENT: 'Needs improvement',
  NEW: 'New inspector',
};

export function ReliabilityBadge({ reliability }) {
  if (!reliability) return null;
  const tier = reliability.tier || 'NEW';
  const title = [
    `${reliability.score}/100`,
    `${reliability.onTimeArrivals} on time`,
    `${reliability.lateArrivals} late`,
    `${reliability.noShows} no-show${reliability.noShows === 1 ? '' : 's'}`,
    reliability.avgReportHours != null ? `reports in ~${reliability.avgReportHours} h` : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`iap-badge iap-badge--${tier.toLowerCase()}`} title={title}>
      {TIER_LABEL[tier] || tier} · {reliability.score}
    </span>
  );
}

/** Inspector's own record: shown on their dashboard so they know how bids rank them. */
export function MyReliability() {
  const [rel, setRel] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/inspections/reliability/me')
      .then((res) => { if (alive) setRel(res.data?.reliability || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!rel) return null;
  return (
    <p className="muted small">
      Your reliability: <ReliabilityBadge reliability={rel} />
      {' '}Arriving on time, turning up, and submitting reports quickly moves you up the bid ranking.
      {rel.noShows > 0 ? ` No-shows on record: ${rel.noShows}.` : ''}
    </p>
  );
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtVisit(scheduled) {
  if (!scheduled) return 'To be arranged';
  const d = new Date(`${scheduled.date}T00:00:00`);
  const day = Number.isNaN(d.getTime()) ? scheduled.date : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${scheduled.startTime}–${scheduled.endTime}`;
}

function minutesLeft(iso, now) {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60000));
}

function fmtLeft(mins) {
  if (mins == null) return '';
  if (mins >= 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${mins} min`;
}

function errorText(error, fallback) {
  return error?.response?.data?.error || fallback;
}

export default function InspectionArrivalPanel({ requestId, variant = 'full', onChanged }) {
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [disputing, setDisputing] = useState(false);
  const [photoUrl, setPhotoUrl] = useState('');

  // inspector check-in form
  const [coords, setCoords] = useState(null);
  const [gpsState, setGpsState] = useState('idle'); // idle | locating | ok | error
  const [photoFile, setPhotoFile] = useState(null);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/inspections/${requestId}/arrival`);
      setView(res.data);
      setLoadError('');
    } catch (e) {
      setLoadError(errorText(e, 'Could not load arrival details'));
    }
  }, [requestId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  if (loadError) return variant === 'summary' ? null : <p className="muted small">{loadError}</p>;
  if (!view) return variant === 'summary' ? null : <p className="muted small">Loading…</p>;

  const arrival = view.arrival;
  const summary = (
    <dl className="iap-summary">
      <div><dt>Inspector</dt><dd>{view.inspector?.name || '—'} <ReliabilityBadge reliability={view.inspector?.reliability} /></dd></div>
      <div><dt>Inspection fee</dt><dd>{view.fee != null ? `${Number(view.fee).toLocaleString()} ETB` : '—'}</dd></div>
      <div><dt>Visit</dt><dd>{fmtVisit(view.scheduled)}</dd></div>
    </dl>
  );
  if (variant === 'summary') return view.inspector ? summary : null;

  const left = minutesLeft(arrival?.disputeWindowEndsAt, now);

  async function act(key, fn, okMessage) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const res = await fn();
      setNotice(res?.data?.message || okMessage);
      setDisputing(false);
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setError(errorText(e, 'Something went wrong. Please try again.'));
      await load();
    } finally {
      setBusy('');
    }
  }

  function locate() {
    if (!navigator.geolocation) {
      setGpsState('error');
      return;
    }
    setGpsState('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsState('ok');
      },
      () => setGpsState('error'),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  function checkIn(e) {
    e.preventDefault();
    if (!coords || !photoFile) return;
    const fd = new FormData();
    fd.append('files', photoFile);
    fd.append('latitude', String(coords.latitude));
    fd.append('longitude', String(coords.longitude));
    if (coords.accuracy != null) fd.append('accuracy', String(coords.accuracy));
    if (code) fd.append('code', code);
    act('checkin', () => api.post(`/inspections/${requestId}/arrival/check-in`, fd), 'Checked in.');
  }

  async function showPhoto() {
    setError('');
    try {
      const res = await api.get(`/inspections/${requestId}/arrival/photo`);
      setPhotoUrl(res.data?.photos?.[0]?.url || '');
    } catch (e) {
      setError(errorText(e, 'Could not load the photo'));
    }
  }

  const how = (() => {
    if (!view.onSiteConfirmedAt || !arrival) return null;
    if (arrival.status === 'AUTO_CONFIRMED') return 'confirmed automatically because no answer came in time';
    if (arrival.status === 'RESOLVED_ARRIVED') return 'confirmed by MarketBridge after review';
    if (arrival.codeVerified) return 'confirmed with the handshake code';
    return 'confirmed by the seller';
  })();

  return (
    <div className="iap">
      {summary}

      {notice && <p className="iap-notice">{notice}</p>}
      {error && <p className="iap-error">{error}</p>}

      {/* ── Arrival confirmed ─────────────────────────────────────── */}
      {view.onSiteConfirmedAt && (
        <p className="iap-state iap-state--ok">
          ✓ Inspector arrival {how || 'confirmed'} ({fmtDateTime(view.onSiteConfirmedAt)}).
          {arrival?.late ? ' The inspector arrived after the agreed time.' : ''}
        </p>
      )}

      {/* ── Waiting for the inspector ─────────────────────────────── */}
      {view.awaitingArrival && !arrival && (
        <>
          {view.handshakeCode ? (
            <div className="iap-code">
              <span className="iap-code-label">Your handshake code</span>
              <strong className="iap-code-value" aria-label={`Handshake code ${view.handshakeCode.split('').join(' ')}`}>
                {view.handshakeCode}
              </strong>
              <span className="muted small">
                Read this to the inspector when they arrive. It proves they were really there, and the arrival is then confirmed at once.
              </span>
            </div>
          ) : view.codeLocked ? (
            <p className="muted small">The handshake code is locked after too many wrong tries. You will be asked to confirm the arrival instead.</p>
          ) : null}
          <p className="muted small">
            Waiting for the inspector to check in on site.
            {view.arrivalDueAt ? ` They must arrive by ${fmtDateTime(view.arrivalDueAt)}; if they do not, the inspection reopens for new bids and your purchase stays as it is.` : ''}
          </p>
        </>
      )}

      {/* ── Inspector: check-in form ──────────────────────────────── */}
      {view.viewerCan.checkIn && (
        <form className="iap-form" onSubmit={checkIn}>
          <h4>Check in on site</h4>
          <p className="muted small">
            Capture your location and a photo of the goods or the site. Ask the seller for their 4-digit code to be confirmed instantly; without it the seller is asked to confirm.
          </p>

          <div className="iap-row">
            <button type="button" className="btn" onClick={locate} disabled={gpsState === 'locating'}>
              {gpsState === 'locating' ? 'Finding location…' : coords ? 'Update my location' : 'Use my location'}
            </button>
            <span className={`small ${gpsState === 'error' ? 'iap-error' : 'muted'}`}>
              {gpsState === 'ok' && coords ? `Location captured (±${Math.round(coords.accuracy || 0)} m)` : null}
              {gpsState === 'error' ? 'Location unavailable. Allow location access and try again.' : null}
            </span>
          </div>

          <div className="iap-row">
            <label className="btn iap-file">
              {photoFile ? 'Retake photo' : 'Take a photo'}
              <input type="file" accept="image/*" capture="environment" onChange={(e) => setPhotoFile(e.target.files?.[0] || null)} hidden />
            </label>
            <span className="muted small">{photoFile ? photoFile.name : 'A photo is required'}</span>
          </div>

          <div className="iap-row">
            <label htmlFor="iap-code-input">Seller&apos;s code (optional)</label>
            <input
              id="iap-code-input"
              className="iap-code-input"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="0000"
            />
          </div>

          <button className="btn btn-primary" type="submit" disabled={!coords || !photoFile || busy === 'checkin'}>
            {busy === 'checkin' ? 'Checking in…' : 'Check in'}
          </button>
        </form>
      )}

      {/* ── Checked in: waiting for the seller ───────────────────── */}
      {arrival?.status === 'PENDING_SELLER' && (
        <div className="iap-pending">
          <p className="iap-state">
            The inspector says they have arrived ({fmtDateTime(arrival.checkedInAt)}).
            {left != null ? ` If the seller does not answer within ${fmtLeft(left)}, it is confirmed automatically.` : ''}
          </p>
          <ul className="iap-chips">
            {arrival.distanceKm != null && (
              <li className={arrival.flagged ? 'iap-chip iap-chip--warn' : 'iap-chip'}>
                {arrival.flagged ? `Checked in ${arrival.distanceKm} km from the listing` : `${arrival.distanceKm} km from the listing`}
              </li>
            )}
            {arrival.late && <li className="iap-chip iap-chip--warn">After the agreed time</li>}
            <li className="iap-chip">{arrival.photoCount} photo</li>
          </ul>

          {view.viewerCan.confirm && arrival.photoCount > 0 && (
            <>
              {photoUrl
                ? <img className="iap-photo" src={photoUrl} alt="Inspector check-in" />
                : <button type="button" className="btn btn-light" onClick={showPhoto}>View the check-in photo</button>}
            </>
          )}

          {view.viewerCan.confirm && !disputing && (
            <div className="iap-row">
              <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => act('confirm', () => api.post(`/inspections/${requestId}/arrival/confirm`), 'Arrival confirmed.')}>
                {busy === 'confirm' ? 'Confirming…' : 'Yes, they are here'}
              </button>
              <button className="btn btn-light" disabled={Boolean(busy)} onClick={() => setDisputing(true)}>
                No, they are not here
              </button>
            </div>
          )}

          {view.viewerCan.dispute && disputing && (
            <div className="iap-dispute">
              <p className="small">What is wrong?</p>
              {DISPUTE_REASONS.map((r) => (
                <button
                  key={r.code}
                  className="btn btn-light"
                  disabled={Boolean(busy)}
                  onClick={() => act('dispute', () => api.post(`/inspections/${requestId}/arrival/dispute`, { reason: r.code }), 'Dispute recorded.')}
                >
                  {r.label}
                </button>
              ))}
              <button className="btn btn-link" onClick={() => setDisputing(false)}>Back</button>
            </div>
          )}
        </div>
      )}

      {/* ── Disputed ──────────────────────────────────────────────── */}
      {arrival?.status === 'DISPUTED' && (
        <p className="iap-state iap-state--warn">
          The seller says the inspector was not on site. MarketBridge is reviewing the inspector&apos;s GPS location and photo and will decide.
        </p>
      )}
    </div>
  );
}
