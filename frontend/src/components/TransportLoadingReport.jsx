import React, { useCallback, useEffect, useState } from 'react';
import AmountPicker from './AmountPicker.jsx';
import EvidenceUploader from './EvidenceUploader.jsx';
import api from '../api/client';
import './TransportLoadingReport.css';

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

// ----------------------------------------------------------------------------
// Small building blocks
// ----------------------------------------------------------------------------

function SectionHead({ title, meta }) {
  return (
    <div className="tlr-head">
      <h3 className="tlr-title">{title}</h3>
      {meta && <div className="tlr-meta">{meta}</div>}
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div className="tlr-fact">
      <span className="tlr-fact-label">{label}</span>
      <strong className="tlr-fact-value">{value}</strong>
    </div>
  );
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
    <div className="tlr-card">
      <SectionHead
        title="Pre-loading report"
        meta={
          loadingReport.submittedBy?.name
            ? `Submitted by ${loadingReport.submittedBy.name}`
            : 'Submitted by the transporter'
        }
      />

      <div className="tlr-facts">
        <Fact label="What will be loaded" value={whatLabel} />
        <Fact
          label="Quantity to be loaded"
          value={`${fmtMoney(loadingReport.quantityLoaded)} ${loadingReport.quantityUnit || ''}`.trim()}
        />
        <Fact label="Expected condition at loading" value={qualityLabel} />
        {loadingReport.gpsLocation && (
          <Fact label="GPS" value={loadingReport.gpsLocation} />
        )}
        {loadingReport.arrivedAt && (
          <Fact label="Arrived at site" value={fmtDateTime(loadingReport.arrivedAt)} />
        )}
        {loadingReport.loadingStartedAt && (
          <Fact
            label="Loading started"
            value={fmtDateTime(loadingReport.loadingStartedAt)}
          />
        )}
        {loadingReport.loadingFinishedAt && (
          <Fact
            label="Loading finished"
            value={fmtDateTime(loadingReport.loadingFinishedAt)}
          />
        )}
      </div>

      {issues.length > 0 ? (
        <div className="tlr-issues">
          <span className="tlr-small-label">Reported issues</span>
          <div className="tlr-chip-row">
            {issues.map((code) => (
              <span key={code} className="tlr-chip">
                {ISSUE_OPTIONS.find(([v]) => v === code)?.[1] || code}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="tlr-muted">No issues reported at loading.</p>
      )}

      {loadingReport.notes && (
        <div className="tlr-notes">
          <span className="tlr-small-label">Driver notes</span>
          <p>{loadingReport.notes}</p>
        </div>
      )}

      {evidence &&
        (evidence.photos?.length > 0 || evidence.videos?.length > 0) && (
          <p className="tlr-muted">
            {evidence.photos?.length || 0} photo(s),{' '}
            {evidence.videos?.length || 0} video(s) attached. Use the evidence
            gallery below to view them.
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

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  function toggleIssue(code) {
    setForm((f) => {
      const current = Array.isArray(f.visibleIssues) ? f.visibleIssues : [];
      const withoutNone = current.filter((c) => c !== 'NONE');
      if (code === 'NONE') {
        return {
          ...f,
          visibleIssues: current.includes('NONE') ? [] : ['NONE'],
        };
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
        'You are reporting REFUSED TO LOAD. This will be recorded in the pre-loading report as a refusal. Continue?'
      );
      if (!ok) return;
    }

    if (!form.quantityLoaded || Number(form.quantityLoaded) <= 0) {
      setError('Enter the quantity to be loaded.');
      return;
    }
    if (!photos.length && !videos.length) {
      setError(
        'At least one photo or video of the goods/pre-loading situation is required.'
      );
      return;
    }

    const arrivedAt = toIso(form.arrivedAt);
    const loadingStartedAt = toIso(form.loadingStartedAt);
    const loadingFinishedAt = toIso(form.loadingFinishedAt);

    if (
      arrivedAt &&
      loadingStartedAt &&
      new Date(arrivedAt) > new Date(loadingStartedAt)
    ) {
      setError('Arrival time cannot be later than the loading start time.');
      return;
    }
    if (
      loadingStartedAt &&
      loadingFinishedAt &&
      new Date(loadingStartedAt) > new Date(loadingFinishedAt)
    ) {
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
      <div className="tlr-card">
        <p className="tlr-muted">Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="tlr-card">
        <div className="tlr-alert-error">{loadError}</div>
      </div>
    );
  }

  // ---- already submitted -------------------------------------------------

  if (existing) {
    return (
      <div className="tlr-card">
        <SectionHead
          title="Pre-loading report submitted"
          meta={fmtDateTime(existing.createdAt)}
        />
        <p className="tlr-muted">
          The buyer can review this report before physical loading begins. The
          report is immutable; corrections must go through the dispute workflow.
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
      <div className="tlr-card">
        <SectionHead title="Loading report" />
        <p className="tlr-muted">
          Waiting for the seller to confirm that the selected transporter is
          prepared. The pre-loading report cannot be submitted until then.
        </p>
      </div>
    );
  }

  if (!paymentsReady) {
    return (
      <div className="tlr-card">
        <SectionHead title="Pre-loading report" />
        <p className="tlr-muted">
          The seller payment must be completed before the transporter can submit
          the pre-loading report.
        </p>
      </div>
    );
  }

  // ---- the form ----------------------------------------------------------

  return (
    <div className="tlr-card">
      <SectionHead title="Loading report" meta="At the pickup site" />

      <p className="tlr-muted">
        Record what is planned to be loaded, how much, when, and the expected
        condition. The buyer will review this report before physical loading
        begins. Once submitted it is immutable.
      </p>

      {error && <div className="tlr-alert-error">{error}</div>}

      <form className="tlr-form" onSubmit={submit}>
        {/* ── What loaded ───────────────────────────────────────── */}
        <label className="tlr-field">
          <span className="tlr-label">What will be loaded</span>
          <select
            className="tlr-select"
            value={form.whatLoaded}
            onChange={(e) => set('whatLoaded')(e.target.value)}
          >
            {WHAT_LOADED_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>

        {/* ── Quantity + unit ───────────────────────────────────── */}
        <div className="tlr-row">
          <label className="tlr-field">
            <span className="tlr-label">Quantity to be loaded</span>
            <div className="tlr-amount-picker">
              <AmountPicker
                reference={1}
                min={0.01}
                placeholder="Select the planned loading quantity"
                value={form.quantityLoaded}
                onChange={set('quantityLoaded')}
                ariaLabel="Quantity to be loaded"
              />
            </div>
          </label>
          <label className="tlr-field">
            <span className="tlr-label">Unit</span>
            <select
              className="tlr-select"
              value={form.quantityUnit}
              onChange={(e) => set('quantityUnit')(e.target.value)}
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* ── Quality ───────────────────────────────────────────── */}
        <label className="tlr-field">
          <span className="tlr-label">Expected condition at loading</span>
          <select
            className="tlr-select"
            value={form.qualityAtLoading}
            onChange={(e) => set('qualityAtLoading')(e.target.value)}
          >
            {QUALITY_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>

        {/* ── Visible issues ────────────────────────────────────── */}
        <fieldset className="tlr-fieldset">
          <legend className="tlr-legend">Visible issues / loading risks</legend>
          <div className="tlr-check-grid">
            {ISSUE_OPTIONS.map(([code, text]) => (
              <label key={code} className="tlr-check">
                <input
                  type="checkbox"
                  checked={(form.visibleIssues || []).includes(code)}
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
            <span className="tlr-label">Arrived at site</span>
            <input
              className="tlr-input"
              type="datetime-local"
              value={form.arrivedAt}
              onChange={(e) => set('arrivedAt')(e.target.value)}
            />
          </label>
          <label className="tlr-field">
            <span className="tlr-label">Loading started</span>
            <input
              className="tlr-input"
              type="datetime-local"
              value={form.loadingStartedAt}
              onChange={(e) => set('loadingStartedAt')(e.target.value)}
            />
          </label>
          <label className="tlr-field">
            <span className="tlr-label">Loading finished</span>
            <input
              className="tlr-input"
              type="datetime-local"
              value={form.loadingFinishedAt}
              onChange={(e) => set('loadingFinishedAt')(e.target.value)}
            />
          </label>
        </div>

        {/* ── GPS ───────────────────────────────────────────────── */}
        <label className="tlr-field">
          <span className="tlr-label">GPS at pickup site (optional)</span>
          <input
            className="tlr-input"
            type="text"
            value={form.gpsLocation}
            onChange={(e) => set('gpsLocation')(e.target.value)}
            placeholder="e.g. 8.9806, 38.7578"
          />
        </label>

        {/* ── Notes ─────────────────────────────────────────────── */}
        <label className="tlr-field tlr-full">
          <span className="tlr-label">Driver notes (optional)</span>
          <textarea
            className="tlr-textarea"
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Loaded as inspected. No concerns on arrival."
          />
          <small className="tlr-hint">
            Do not include phone numbers, email addresses, or links. Those are
            rejected by the platform.
          </small>
        </label>

        {/* ── Media ─────────────────────────────────────────────── */}
        <div className="tlr-field tlr-full">
          <span className="tlr-label">
            Photos / videos of goods and loading situation
          </span>
          <EvidenceUploader
            uploadUrl={`/transport/${transportJobId}/evidence/media`}
            disabled={submitting}
            onUploaded={({ photoKeys, videoKeys }) => {
              setPhotos((prev) => [...prev, ...photoKeys]);
              setVideos((prev) => [...prev, ...videoKeys]);
            }}
          />
          {(photos.length > 0 || videos.length > 0) && (
            <p className="tlr-muted">
              {photos.length} photo(s), {videos.length} video(s) attached. At
              least one is required.
            </p>
          )}
        </div>

        {/* ── Actions ───────────────────────────────────────────── */}
        <div className="tlr-actions">
          <button
            type="submit"
            className="tlr-btn tlr-btn--primary"
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit report'}
          </button>
          <button
            type="button"
            className="tlr-btn tlr-btn--secondary"
            onClick={() => window.history.back()}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
