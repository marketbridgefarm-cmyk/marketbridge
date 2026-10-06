import React, { useCallback, useEffect, useState } from 'react';
import AmountPicker from './AmountPicker.jsx';
import EvidenceUploader from './EvidenceUploader.jsx';
import api from '../api/client';

// ============================================================================
// TRANSPORT LOADING REPORT
// ----------------------------------------------------------------------------
// The truck owner's structured record captured at the pickup site, submitted
// before the truck may leave. Only reachable after every payment on the order
// is settled — that gate is enforced on the server and mirrored here so the
// form never opens when it cannot succeed.
//
// Every field is a dropdown, checkbox list, or AmountPicker. There is no
// free-text numeric input anywhere, so a phone number cannot be smuggled into
// a price or quantity field. Notes are the only free text and are passed
// through the same noContactInfo guard the rest of the platform uses.
// ============================================================================

const WHAT_LOADED_OPTIONS = [
  ['AS_LISTED', 'As listed'],
  ['SAME_PRODUCT_DIFFERENT_VARIETY', 'Same product, different variety'],
  ['PARTIAL_OF_LISTED', 'Partial of listed product'],
  ['DIFFERENT_PRODUCT', 'Different product'],
  ['REFUSED_TO_LOAD', 'Refused to load'],
];

const QUALITY_OPTIONS = [
  ['AS_INSPECTED', 'As inspected'],
  ['MINOR_VARIANCE', 'Minor variance'],
  ['MAJOR_VARIANCE', 'Major variance'],
  ['DAMAGED', 'Damaged'],
  ['NOT_INSPECTED', 'Not inspected'],
];

const ISSUE_OPTIONS = [
  ['NONE', 'No visible issues'],
  ['FRESHNESS_CONCERN', 'Freshness concern'],
  ['PHYSICAL_DAMAGE', 'Physical damage'],
  ['PACKAGING_DAMAGE', 'Packaging damage'],
  ['QUANTITY_SHORTFALL', 'Quantity shortfall'],
  ['WRONG_PRODUCT', 'Wrong product'],
  ['CONTAMINATION', 'Contamination'],
  ['WEATHER_EXPOSURE', 'Weather exposure'],
];

const UNIT_OPTIONS = ['kg', 'quintal', 'ton', 'crate', 'bag', 'piece'];

const EMPTY_FORM = {
  whatLoaded: 'AS_LISTED',
  quantityLoaded: '',
  quantityUnit: 'quintal',
  qualityAtLoading: 'AS_INSPECTED',
  visibleIssues: [],
  arrivedAt: '',
  loadingStartedAt: '',
  loadingFinishedAt: '',
  gpsLocation: '',
  notes: '',
};

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" (local, no seconds).
function toLocalInput(dateLike) {
  if (!dateLike) return '';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtMoney(v) {
  return Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ============================================================================
// READ-ONLY SUMMARY (buyer / seller / admin)
// ============================================================================

export function TransportLoadingReportSummary({ loadingReport, evidence }) {
  if (!loadingReport) return null;

  const issues = Array.isArray(loadingReport.visibleIssues)
    ? loadingReport.visibleIssues.filter((v) => v && v !== 'NONE')
    : [];

  const whatLabel =
    WHAT_LOADED_OPTIONS.find(([v]) => v === loadingReport.whatLoaded)?.[1] ||
    loadingReport.whatLoaded;
  const qualityLabel =
    QUALITY_OPTIONS.find(([v]) => v === loadingReport.qualityAtLoading)?.[1] ||
    loadingReport.qualityAtLoading ||
    '—';

  return (
    <div className="od-card-section tlr-summary">
      <div className="od-card-section-head">
        <h3 className="od-card-section-title">Loading report</h3>
        <div className="od-card-section-meta">
          {loadingReport.submittedBy?.name
            ? `Submitted by ${loadingReport.submittedBy.name}`
            : 'Submitted by the transporter'}
        </div>
      </div>

      <div className="od-detail-facts">
        <div>
          <span>What loaded</span>
          <strong>{whatLabel}</strong>
        </div>
        <div>
          <span>Quantity loaded</span>
          <strong>
            {fmtMoney(loadingReport.quantityLoaded)} {loadingReport.quantityUnit || ''}
          </strong>
        </div>
        <div>
          <span>Quality at loading</span>
          <strong>{qualityLabel}</strong>
        </div>
        {loadingReport.gpsLocation && (
          <div>
            <span>GPS</span>
            <strong>{loadingReport.gpsLocation}</strong>
          </div>
        )}
        {loadingReport.arrivedAt && (
          <div>
            <span>Arrived at site</span>
            <strong>{fmtDateTime(loadingReport.arrivedAt)}</strong>
          </div>
        )}
        {loadingReport.loadingStartedAt && (
          <div>
            <span>Loading started</span>
            <strong>{fmtDateTime(loadingReport.loadingStartedAt)}</strong>
          </div>
        )}
        {loadingReport.loadingFinishedAt && (
          <div>
            <span>Loading finished</span>
            <strong>{fmtDateTime(loadingReport.loadingFinishedAt)}</strong>
          </div>
        )}
      </div>

      {issues.length > 0 ? (
        <div className="tlr-issues">
          <span className="tlr-issues-label">Reported issues</span>
          <div className="tlr-issues-chips">
            {issues.map((code) => (
              <span key={code} className="tlr-issues-chip">
                {ISSUE_OPTIONS.find(([v]) => v === code)?.[1] || code}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted small">No issues reported at loading.</p>
      )}

      {loadingReport.notes && (
        <div className="tlr-notes">
          <span className="tlr-issues-label">Driver notes</span>
          <p className="muted small">{loadingReport.notes}</p>
        </div>
      )}

      {evidence && (evidence.photos?.length > 0 || evidence.videos?.length > 0) && (
        <p className="muted small">
          {evidence.photos?.length || 0} photo(s), {evidence.videos?.length || 0} video(s)
          attached. Use the evidence gallery below to view them.
        </p>
      )}
    </div>
  );
}

// ============================================================================
// THE FORM (driver only)
// ============================================================================

export default function TransportLoadingReport({
  transportJobId,
  jobStatus,
  sellerConfirmed,
  paymentsReady,
  missingPayments,
  onSubmitted,
}) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState(null);
  const [existingEvidence, setExistingEvidence] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [photos, setPhotos] = useState([]);
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.get(`/transport/${transportJobId}/loading-report`);
      setExisting(res.data?.loadingReport || null);
      setExistingEvidence(res.data?.evidence || null);
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Could not load loading report');
    } finally {
      setLoading(false);
    }
  }, [transportJobId]);

  useEffect(() => { load(); }, [load]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  function toggleIssue(code) {
    setForm((f) => {
      const current = Array.isArray(f.visibleIssues) ? f.visibleIssues : [];
      const withoutNone = current.filter((c) => c !== 'NONE');
      if (code === 'NONE') {
        return { ...f, visibleIssues: current.includes('NONE') ? [] : ['NONE'] };
      }
      const has = withoutNone.includes(code);
      const next = has
        ? withoutNone.filter((c) => c !== code)
        : [...withoutNone, code];
      return { ...f, visibleIssues: next.length ? next : [] };
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');

    if (form.whatLoaded === 'REFUSED_TO_LOAD') {
      const ok = window.confirm(
        'You are reporting REFUSED TO LOAD. This will be recorded as a loading report where nothing was loaded. Continue?'
      );
      if (!ok) return;
    }

    if (!form.quantityLoaded || Number(form.quantityLoaded) <= 0) {
      setError('Enter the quantity loaded.');
      return;
    }
    if (!photos.length && !videos.length) {
      setError('At least one photo or video of the loaded goods is required.');
      return;
    }

    const arrivedAt = toIso(form.arrivedAt);
    const loadingStartedAt = toIso(form.loadingStartedAt);
    const loadingFinishedAt = toIso(form.loadingFinishedAt);

    if (arrivedAt && loadingStartedAt && new Date(arrivedAt) > new Date(loadingStartedAt)) {
      setError('Arrival time cannot be later than the loading start time.');
      return;
    }
    if (loadingStartedAt && loadingFinishedAt && new Date(loadingStartedAt) > new Date(loadingFinishedAt)) {
      setError('Loading start time cannot be later than the loading finish time.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post(`/transport/${transportJobId}/loading-report`, {
        whatLoaded: form.whatLoaded,
        quantityLoaded: Number(form.quantityLoaded),
        quantityUnit: form.quantityUnit || undefined,
        qualityAtLoading: form.qualityAtLoading || undefined,
        visibleIssues: form.visibleIssues,
        arrivedAt: arrivedAt || undefined,
        loadingStartedAt: loadingStartedAt || undefined,
        loadingFinishedAt: loadingFinishedAt || undefined,
        gpsLocation: form.gpsLocation?.trim() || undefined,
        notes: form.notes?.trim() || undefined,
        photos,
        videos,
      });
      await load();
      if (onSubmitted) onSubmitted();
    } catch (err) {
      const data = err.response?.data;
      setError(
        data?.code === 'PAYMENTS_REQUIRED_BEFORE_LOADING'
          ? `Payments still outstanding: ${(data.missingPayments || []).join(', ')}`
          : data?.error || 'Could not submit loading report'
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---- loading / error ---------------------------------------------------

  if (loading) {
    return (
      <div className="od-card-section tlr-root">
        <p className="muted small">Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="od-card-section tlr-root">
        <div className="alert error">{loadError}</div>
      </div>
    );
  }

  // ---- already submitted -------------------------------------------------

  if (existing) {
    return (
      <div className="od-card-section tlr-root">
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">Loading report submitted</h3>
          <div className="od-card-section-meta">
            {fmtDateTime(existing.createdAt)}
          </div>
        </div>
        <p className="muted small">
          The truck has left the pickup site. The report is immutable; corrections
          must go through the dispute workflow.
        </p>
        <TransportLoadingReportSummary
          loadingReport={existing}
          evidence={existingEvidence}
        />
      </div>
    );
  }

  // ---- gates (mirror server) ---------------------------------------------

  if (jobStatus !== 'ACCEPTED') {
    return null; // Form is only shown when the job is awaiting pickup.
  }

  if (!sellerConfirmed) {
    return (
      <div className="od-card-section tlr-root">
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">Loading report</h3>
        </div>
        <p className="muted small">
          Waiting for the seller to confirm that the goods are ready for pickup.
          The loading report cannot be submitted until then.
        </p>
      </div>
    );
  }

  if (!paymentsReady) {
    const missing = Array.isArray(missingPayments) && missingPayments.length
      ? ` (outstanding: ${missingPayments.join(', ')})`
      : '';
    return (
      <div className="od-card-section tlr-root">
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">Loading report</h3>
        </div>
        <p className="muted small">
          Every payment on this order must be settled before loading begins —
          goods, all inspection fees, and transport{missing}.
        </p>
      </div>
    );
  }

  // ---- the form ----------------------------------------------------------

  return (
    <div className="od-card-section tlr-root">
      <div className="od-card-section-head">
        <h3 className="od-card-section-title">Loading report</h3>
        <div className="od-card-section-meta">
          At the pickup site
        </div>
      </div>

      <p className="muted small">
        Record what actually loaded, when, and in what condition. This becomes
        the transporter's evidentiary record for the pickup. Once submitted it
        is immutable.
      </p>

      {error && <div className="alert error">{error}</div>}

      <form className="tlr-form" onSubmit={submit}>
        {/* ── What loaded ───────────────────────────────────────── */}
        <label className="tlr-field">
          <span>What loaded</span>
          <select
            value={form.whatLoaded}
            onChange={(e) => set('whatLoaded')(e.target.value)}
          >
            {WHAT_LOADED_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        </label>

        {/* ── Quantity + unit ───────────────────────────────────── */}
        <div className="tlr-row">
          <label className="tlr-field">
            <span>Quantity loaded</span>
            <AmountPicker
              reference={1}
              min={0.01}
              placeholder="Select the loaded quantity"
              value={form.quantityLoaded}
              onChange={set('quantityLoaded')}
              ariaLabel="Quantity loaded"
            />
          </label>
          <label className="tlr-field">
            <span>Unit</span>
            <select
              value={form.quantityUnit}
              onChange={(e) => set('quantityUnit')(e.target.value)}
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
        </div>

        {/* ── Quality ───────────────────────────────────────────── */}
        <label className="tlr-field">
          <span>Quality at loading</span>
          <select
            value={form.qualityAtLoading}
            onChange={(e) => set('qualityAtLoading')(e.target.value)}
          >
            {QUALITY_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        </label>

        {/* ── Visible issues ────────────────────────────────────── */}
        <fieldset className="tlr-fieldset">
          <legend>Visible issues at loading</legend>
          <div className="tlr-check-grid">
            {ISSUE_OPTIONS.map(([code, text]) => (
              <label key={code} className="tlr-check">
                <input
                  type="checkbox"
                  checked={
                    code === 'NONE'
                      ? (form.visibleIssues || []).includes('NONE')
                      : (form.visibleIssues || []).includes(code)
                  }
                  onChange={() => toggleIssue(code)}
                />
                <span>{text}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* ── Times ─────────────────────────────────────────────── */}
        <div className="tlr-row">
          <label className="tlr-field">
            <span>Arrived at site</span>
            <input
              type="datetime-local"
              value={form.arrivedAt}
              onChange={(e) => set('arrivedAt')(e.target.value)}
            />
          </label>
          <label className="tlr-field">
            <span>Loading started</span>
            <input
              type="datetime-local"
              value={form.loadingStartedAt}
              onChange={(e) => set('loadingStartedAt')(e.target.value)}
            />
          </label>
          <label className="tlr-field">
            <span>Loading finished</span>
            <input
              type="datetime-local"
              value={form.loadingFinishedAt}
              onChange={(e) => set('loadingFinishedAt')(e.target.value)}
            />
          </label>
        </div>

        {/* ── GPS ───────────────────────────────────────────────── */}
        <label className="tlr-field">
          <span>GPS at pickup site (optional)</span>
          <input
            type="text"
            value={form.gpsLocation}
            onChange={(e) => set('gpsLocation')(e.target.value)}
            placeholder="e.g. 8.9806, 38.7578"
          />
        </label>

        {/* ── Notes ─────────────────────────────────────────────── */}
        <label className="tlr-field tlr-field--full">
          <span>Driver notes (optional)</span>
          <textarea
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Loaded as inspected. No concerns on arrival."
          />
          <small className="muted">
            Do not include phone numbers, email addresses, or links. Those are
            rejected by the platform.
          </small>
        </label>

        {/* ── Media ─────────────────────────────────────────────── */}
        <div className="tlr-field tlr-field--full">
          <span>Photos / videos of the loaded goods</span>
          <EvidenceUploader
            uploadUrl={`/transport/${transportJobId}/evidence/media`}
            disabled={submitting}
            onUploaded={({ photoKeys, videoKeys }) => {
              setPhotos((prev) => [...prev, ...photoKeys]);
              setVideos((prev) => [...prev, ...videoKeys]);
            }}
          />
          {(photos.length > 0 || videos.length > 0) && (
            <p className="muted small">
              {photos.length} photo(s), {videos.length} video(s) attached.
              At least one is required.
            </p>
          )}
        </div>

        <div className="tlr-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit loading report & mark picked up'}
          </button>
        </div>
      </form>
    </div>
  );
}
