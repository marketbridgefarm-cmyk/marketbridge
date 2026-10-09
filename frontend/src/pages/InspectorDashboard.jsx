import React, { useCallback, useEffect, useState } from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/InspectorDashboard.css';
import ProviderReleaseDialog from '../components/ProviderReleaseDialog.jsx';
import ProviderStandingBanner from '../components/ProviderStandingBanner.jsx';
import InspectionCoordinationInspector from '../components/InspectionCoordinationInspector.jsx';
import { InspectionRequestSummary } from '../components/RequestScopeSummary.jsx';
import { BID_MESSAGES } from '../components/RequestOptions.js';

const EMPTY_REPORT = {
  quantity: '',
  grade: '',
  moisture: '',
  visibleDefects: '',
  damageNotes: '',
  packagingNotes: '',
  assessmentSummary: '',
  qualityFlags: [],
  gpsLocation: '',
};

const CHECKLIST = [
  'Quantity',
  'Grade / quality',
  'Size where applicable',
  'Moisture where applicable',
  'Visible defects / damage',
  'Packaging',
  'Photos / videos',
  'GPS / location',
  'Date, time & inspector identity',
];

/* ── Small presentational helpers (same card system as Transport) ── */

// BUYER_REQUESTED -> "Buyer requested" (sentence case reads better in cards).
function modeLabel(mode) {
  const text = String(mode || '').replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isProductInspection(request) {
  return request?.listing?.category === 'PRODUCT';
}

function initialsOf(name) {
  if (!name) return '??';
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString() : null;
}

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : null;
}

// "ORD 25464DE7" style short reference, matching the Orders cards.
function shortOrder(id) {
  if (!id) return null;
  return `ORD ${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function listingTitle(request) {
  return request?.listing?.cropType || request?.listing?.title || 'Listing';
}

function listingQuantity(request) {
  const { quantity, unit } = request?.listing || {};
  if (quantity == null || quantity === '') return null;
  return `${quantity}${unit ? ` ${unit}` : ''}`;
}

function jobTone(status) {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'IN_PROGRESS':
      return 'info';
    case 'ACCEPTED':
      return 'gold';
    default:
      return 'muted';
  }
}

/*
 * Three-step inspection timeline:
 *   Accepted → In progress → Completed
 * The "current" step is the next thing that still has to happen.
 */
function jobProgress(status) {
  const labels = ['Accepted', 'In progress', 'Completed'];
  const s = String(status || '').toUpperCase();

  let idx = 0;
  if (s === 'ACCEPTED') idx = 1;
  else if (s === 'IN_PROGRESS') idx = 2;
  else if (s === 'COMPLETED') idx = 3;

  return labels.map((label, i) => ({
    label,
    cls: i < idx ? 'done' : i === idx ? 'current' : '',
  }));
}

// The agreed inspection fee, once an inspector has been assigned.
function jobAmount(request) {
  const accepted = (request.quotes || []).find((q) => q.status === 'ACCEPTED');
  const raw = request.fee ?? accepted?.counterAmount ?? accepted?.amount ?? null;
  return raw == null ? null : fmtMoney(raw);
}

function ArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

// Big number + small unit, as on the Orders "Amount" block.
function AmountRow({ value, unit = 'ETB' }) {
  return (
    <div className="sd-amount">
      <b>{value}</b>
      <span>{unit}</span>
    </div>
  );
}

export default function InspectorDashboard() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState('available');

  const [available, setAvailable] = useState([]);
  const [mine, setMine] = useState([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  const [feeInputs] = useState({});
  const [quoteAmountInputs, setQuoteAmountInputs] = useState({});
  const [quoteMessageInputs, setQuoteMessageInputs] = useState({});
  const [submittingQuoteId, setSubmittingQuoteId] = useState('');
  const [quotedRequestIds, setQuotedRequestIds] = useState(() => new Set());
  const [quoteCounterInputs, setQuoteCounterInputs] = useState({});
  const [respondingQuoteId, setRespondingQuoteId] = useState('');
  const [releaseTarget, setReleaseTarget] = useState(null);
  const [activeRequestId, setActiveRequestId] = useState('');
  const [report, setReport] = useState(EMPTY_REPORT);
  const [reportEvidence, setReportEvidence] = useState({ photoKeys: [], videoKeys: [] });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');

    try {
      const [availRes, mineRes] = await Promise.all([
        api.get('/inspections/available'),
        api.get('/inspections/mine'),
      ]);

      setAvailable(availRes.data?.requests || []);
      setMine(mineRes.data?.requests || []);
    } catch (err) {
      setLoadError(
        err.response?.data?.error ||
          'Could not load inspection jobs.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Action feedback is shown as a floating toast (always in view, wherever
  // the person has scrolled) and dismisses itself.
  useEffect(() => {
    if (!msg) return undefined;
    const timer = window.setTimeout(() => setMsg(''), 5000);
    return () => window.clearTimeout(timer);
  }, [msg]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  function dismissToast() {
    setMsg('');
    setError('');
  }

  // Order Action Center can deep-link an inspector directly to the report
  // workspace. This removes the dead-end of being sent to a dashboard and
  // having to find the inspection manually.
  useEffect(() => {
    const requestedId = searchParams.get('inspectionId');
    if (!requestedId || !mine.length) return;
    const request = mine.find((item) => item.id === requestedId);
    if (request?.status === 'IN_PROGRESS') {
      openReportForm(request.id);
      setTab('mine');
    }
  }, [searchParams, mine]);

  // Kept for direct-accept flows; the marketplace now runs on sealed quotes.
  async function accept(id) {
    setError('');
    setMsg('');

    const fee = Number(feeInputs[id]);

    if (!fee || fee <= 0) {
      setError(
        'Enter your fee for this inspection before accepting.'
      );
      return;
    }

    try {
      await api.patch(`/inspections/${id}/accept`, {
        fee,
      });

      setMsg(
        'Job accepted. Start the inspection when you arrive at the inspection location.'
      );

      setTab('mine');

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not accept this job — it may have just been claimed by another inspector.'
      );
    }
  }

  async function submitQuote(id) {
    setError('');
    setMsg('');

    const amount = Number(quoteAmountInputs[id]);

    if (!amount || amount <= 0) {
      setError(
        'Enter your quote amount before submitting.'
      );
      return;
    }

    setSubmittingQuoteId(id);

    try {
      await api.post(`/inspections/${id}/quote`, {
        amount,
        message: quoteMessageInputs[id] || undefined,
      });

      setMsg(
        'Quote submitted. The requester will compare competing inspector quotes and select one for negotiation.'
      );

      setQuotedRequestIds((s) => new Set(s).add(id));

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not submit quote — the job may have just been claimed or already has your quote.'
      );
    } finally {
      setSubmittingQuoteId('');
    }
  }

  // A quote's negotiation thread is only "live" at its leaf: the row that
  // no later counter-quote points back to as a parent.
  function leafInspectionQuote(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    const parentIds = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
    // The inspector can own several chains on one request (e.g. an earlier
    // rejected bid and a newer one). `find` returned the OLDEST leaf, so a
    // rejected bid hid the live one; take the most recent leaf instead.
    return (
      list
        .filter((q) => !parentIds.has(q.id))
        .sort(
          (a, b) =>
            new Date(b.updatedAt || b.createdAt || 0) -
            new Date(a.updatedAt || a.createdAt || 0)
        )[0] || null
    );
  }

  function isInspectionQuoteExpired(quote) {
    return Boolean(quote?.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
  }

  async function acceptInspectionQuote(requestId, quoteId) {
    setError('');
    setMsg('');
    setRespondingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/accept`);
      setMsg('Requester\u2019s price accepted. You have been assigned to this job.');
      setTab('mine');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not accept this negotiation.');
    } finally {
      setRespondingQuoteId('');
    }
  }

  function cancelAcceptedInspection(requestId, quoteId) {
    setReleaseTarget({ requestId, quoteId });
  }

  async function confirmCancelAcceptedInspection({ reason, note }) {
    if (!releaseTarget) return;
    const { requestId, quoteId } = releaseTarget;
    setError('');
    setMsg('');
    setRespondingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/withdraw`, {
        reason,
        note: note || undefined,
      });
      setReleaseTarget(null);
      setMsg('Provisional inspection deal cancelled. The requester can select another inspector bid.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not cancel the provisional inspection deal.');
    } finally {
      setRespondingQuoteId('');
    }
  }

  async function counterInspectionQuote(requestId, quoteId) {
    setError('');
    setMsg('');
    const amount = Number(quoteCounterInputs[quoteId]);
    if (!amount || amount <= 0) {
      setError('Enter a valid counter amount before sending.');
      return;
    }
    setRespondingQuoteId(quoteId);
    try {
      await api.post(`/inspections/${requestId}/quotes/${quoteId}/counter`, { counterAmount: amount });
      setMsg('Counter-offer sent to the requester.');
      setQuoteCounterInputs((q) => ({ ...q, [quoteId]: '' }));
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send counter-offer.');
    } finally {
      setRespondingQuoteId('');
    }
  }

  async function rejectInspectionQuote(requestId, quoteId) {
    setError('');
    setMsg('');
    setRespondingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/reject`);
      setMsg('Negotiation ended.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reject this negotiation.');
    } finally {
      setRespondingQuoteId('');
    }
  }

  async function startInspection(id) {
    setError('');
    setMsg('');

    try {
      await api.post(`/inspections/${id}/start`);

      setMsg(
        'Inspection started. You can now complete the evidence report.'
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not start the inspection.'
      );
    }
  }

  function openReportForm(requestId) {
    setActiveRequestId(requestId);
    setReport(EMPTY_REPORT);
    setReportEvidence({ photoKeys: [], videoKeys: [] });
    setMsg('');
    setError('');
  }

  function closeReportForm() {
    setActiveRequestId('');
    setReport(EMPTY_REPORT);
    setReportEvidence({ photoKeys: [], videoKeys: [] });
  }

  async function addReportAddendum(requestId) {
    const reason = window.prompt('Correction reason', 'Factual correction to completed inspection report');
    if (reason === null) return;
    const notes = window.prompt('Correction details');
    if (!notes || !notes.trim()) return;
    setError('');
    setMsg('');
    try {
      await api.post(`/inspections/${requestId}/report/addenda`, { reason: reason.trim(), notes: notes.trim() });
      setMsg('Report addendum recorded. The original report remains unchanged.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add report correction.');
    }
  }

  async function submitReport(e) {
    e.preventDefault();

    if (!activeRequestId) return;

    setError('');
    setMsg('');

    try {
      await api.post(
        `/inspections/${activeRequestId}/report`,
        {
          ...report,

          quantity: Number(report.quantity),

          moisture:
            report.moisture !== ''
              ? Number(report.moisture)
              : undefined,

          photos: reportEvidence.photoKeys,

          videos: reportEvidence.videoKeys,
        }
      );

      setMsg(
        'Inspection report submitted and inspection marked complete.'
      );

      closeReportForm();

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not submit report.'
      );
    }
  }

  const acceptedMine = mine.filter((r) => r.status === 'ACCEPTED');
  const inProgressMine = mine.filter((r) => r.status === 'IN_PROGRESS');
  const pendingMine = mine.filter(
    (r) => r.status === 'ACCEPTED' || r.status === 'IN_PROGRESS'
  );
  const completedMine = mine.filter((r) => r.status === 'COMPLETED');

  const activeRequest = mine.find((r) => r.id === activeRequestId);
  const productReport = isProductInspection(activeRequest);

  const activityItems = mine.map((r) => ({
    id: `insp-${r.id}`,
    icon: '🔍',
    text: `${r.listing?.cropType || r.listing?.title || 'Inspection'} is ${r.status === 'COMPLETED' ? 'complete' : r.status.toLowerCase().replaceAll('_', ' ')}`,
    time: r.updatedAt || r.createdAt,
    href: `/listings/${r.listing?.id}`,
  }));

  if (loading) {
    return (
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">INSPECTOR DASHBOARD</span>
          <h1>Loading your inspection workspace…</h1>
          <p className="sd-muted">
            Loading available jobs and your accepted inspections.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sd-dashboard">
      <ProviderStandingBanner />

      {/* =========================================================
          HEADER / SUMMARY
      ========================================================= */}

      <section>
        <DashboardWelcome
          user={user}
          subtitle="Verify produce quality independently, document evidence, and get paid for completed inspections."
        />
        <RoleSwitchCTA current="INSPECTOR" />
        <RecentActivity
          items={activityItems}
          emptyText="No inspections accepted yet — check available jobs below."
        />

        <div className="sd-toolbar">
          <div>
            <span className="sd-eyebrow">INSPECTOR DASHBOARD</span>
            <h1>Verify. Document. Report.</h1>
            <p className="sd-muted" style={{ maxWidth: 780 }}>
              Inspectors are independent verifiers. They do not own produce,
              set farmer prices or arrange transport.
            </p>
          </div>

          <span className="sd-badge sd-blue">VERIFICATION ROLE</span>
        </div>

        <div className="sd-stat-grid">
          <div className="sd-stat">
            <span>AVAILABLE JOBS</span>
            <b>{available.length}</b>
          </div>

          <div className="sd-stat">
            <span>ACCEPTED</span>
            <b>{acceptedMine.length}</b>
          </div>

          <div className="sd-stat">
            <span>IN PROGRESS</span>
            <b>{inProgressMine.length}</b>
          </div>

          <div className="sd-stat">
            <span>COMPLETED</span>
            <b>{completedMine.length}</b>
          </div>
        </div>
      </section>

      {/* =========================================================
          MESSAGES
      ========================================================= */}

      {loadError && (
        <section>
          <div className="sd-panel sd-panel--error">
            <strong>Unable to load inspection jobs</strong>
            <p className="sd-muted">{loadError}</p>
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              onClick={loadAll}
            >
              Try again
            </button>
          </div>
        </section>
      )}

      {/* =========================================================
          TABS
      ========================================================= */}

      <section>
        <div className="sd-tabs">
          <button
            type="button"
            className={`sd-tab ${tab === 'available' ? 'sd-active' : ''}`}
            onClick={() => setTab('available')}
          >
            Available Jobs
            {available.length > 0 && <span>({available.length})</span>}
          </button>

          <button
            type="button"
            className={`sd-tab ${tab === 'mine' ? 'sd-active' : ''}`}
            onClick={() => setTab('mine')}
          >
            My Jobs
            {pendingMine.length > 0 && <span>({pendingMine.length})</span>}
          </button>
        </div>

        <div className="sd-workspace">
          <div>

            {/* =====================================================
                AVAILABLE JOBS
            ===================================================== */}

            {tab === 'available' && (
              <div>
                <div className="sd-toolbar">
                  <div>
                    <span className="sd-eyebrow">MARKETPLACE</span>
                    <h2>Open inspection requests</h2>
                    <p className="sd-muted">
                      Requests from sellers or buyers that no inspector has
                      accepted yet.
                    </p>
                  </div>
                </div>

                <div className="sd-cards">
                  {available.map((r) => {
                    const myLeaf = leafInspectionQuote(r.quotes);
                    const hasActiveThread =
                      myLeaf &&
                      !isInspectionQuoteExpired(myLeaf) &&
                      ['PENDING', 'SELECTED', 'COUNTERED'].includes(myLeaf.status);
                    const isMyTurn =
                      hasActiveThread &&
                      myLeaf.status === 'COUNTERED' &&
                      myLeaf.counteredBy === 'REQUESTER';
                    const justQuoted = quotedRequestIds.has(r.id) && !myLeaf;
                    const canQuote = !hasActiveThread && !justQuoted;
                    const responding = myLeaf && respondingQuoteId === myLeaf.id;

                    const displayAmount = myLeaf
                      ? fmtMoney(
                          myLeaf.status === 'COUNTERED'
                            ? (myLeaf.counterAmount ?? myLeaf.amount)
                            : myLeaf.amount
                        )
                      : null;

                    const requesterName = r.requestedBy?.name || 'User';
                    const quantity = listingQuantity(r);
                    const place = r.location || r.listing?.location || 'Location not set';
                    const createdLabel = fmtDate(r.createdAt);

                    return (
                      <article className="sd-card sd-job-card" key={r.id}>
                        {/* Card head */}
                        <div className="sd-card-head">
                          <div className="sd-card-head-text">
                            <span className="sd-eyebrow tone-info">Open request</span>
                            <h3 className="sd-card-title" title={listingTitle(r)}>
                              {listingTitle(r)}
                            </h3>
                            {createdLabel && <p className="sd-card-sub">{createdLabel}</p>}
                          </div>

                          <div className="sd-card-head-party">
                            <div className="sd-party-info">
                              <span className="sd-party-role">Requested by</span>
                              <span className="sd-party-name">{requesterName}</span>
                            </div>
                            <div className="sd-avatar tone-success" aria-hidden="true">
                              {initialsOf(requesterName)}
                            </div>
                          </div>
                        </div>

                        <div className="sd-card-body">
                          {/* Block 1 — Inspection details */}
                          <section className="sd-card-block">
                            <div className="sd-card-block-title">
                              <h4>Inspection details</h4>
                            </div>
                            <div className="sd-card-block-body">
                              <div className="sd-job-meta">
                                {r.mode && (
                                  <div className="sd-job-meta-item">
                                    <span>Mode</span>
                                    <strong>{modeLabel(r.mode)}</strong>
                                  </div>
                                )}
                                {quantity && (
                                  <div className="sd-job-meta-item">
                                    <span>Quantity</span>
                                    <strong>{quantity}</strong>
                                  </div>
                                )}
                                <div className="sd-job-meta-item">
                                  <span>Location</span>
                                  <strong>{place}</strong>
                                </div>
                              </div>
                              <InspectionRequestSummary inspection={r} title="Scope to inspect" />
                            </div>
                          </section>

                          {/* Block 2 — Your quote (whenever a quote exists) */}
                          {myLeaf && displayAmount && (
                            <section className="sd-card-block">
                              <div className="sd-card-block-title">
                                <h4>{isMyTurn ? 'Counter-offer' : 'Your quote'}</h4>
                                <span className="sd-card-block-note">
                                  {isMyTurn ? 'Your turn' : modeLabel(myLeaf.status)}
                                </span>
                              </div>
                              <div className="sd-card-block-body">
                                <AmountRow value={displayAmount} />
                                <p className="sd-amount-note">
                                  {isMyTurn
                                    ? 'The requester countered this price.'
                                    : hasActiveThread || justQuoted
                                      ? 'Waiting on the requester’s decision.'
                                      : 'This quote is no longer active.'}
                                </p>
                                <p className="sd-amount-note">
                                  Quotes are sealed — you won’t see what anyone else bids, and the requester decides.
                                </p>
                              </div>

                              {isMyTurn && (
                                <div className="sd-form-grid sd-form-grid--tight">
                                  <div>
                                    <label htmlFor={`counter-${myLeaf.id}`}>Your counter (ETB)</label>
                                    <AmountPicker
                                      id={`counter-${myLeaf.id}`}
                                      reference={Number(myLeaf.counterAmount ?? myLeaf.amount)}
                                      min={1}
                                      placeholder="Select your counter"
                                      value={quoteCounterInputs[myLeaf.id] || ''}
                                      onChange={(v) =>
                                        setQuoteCounterInputs((q) => ({
                                          ...q,
                                          [myLeaf.id]: v,
                                        }))
                                      }
                                      ariaLabel="Your counter in ETB"
                                    />
                                  </div>
                                </div>
                              )}
                            </section>
                          )}

                          {/* Block 3 — Submit a quote */}
                          {canQuote && (
                            <section className="sd-card-block">
                              <div className="sd-card-block-title">
                                <h4>Submit a quote</h4>
                                <span className="sd-card-block-note">Sealed</span>
                              </div>
                              <div className="sd-card-block-body">
                                <p className="sd-amount-note">
                                  The requester compares all inspector bids and selects one for price negotiation. You can’t claim the job directly or see other inspectors’ amounts.
                                </p>

                                <div className="sd-form-grid sd-form-grid--tight">
                                  <div>
                                    <label htmlFor={`quote-${r.id}`}>Your quote (ETB)</label>
                                    <AmountPicker
                                      id={`quote-${r.id}`}
                                      min={50}
                                      max={100000}
                                      placeholder="Select your quote"
                                      value={quoteAmountInputs[r.id] || ''}
                                      onChange={(v) =>
                                        setQuoteAmountInputs((q) => ({
                                          ...q,
                                          [r.id]: v,
                                        }))
                                      }
                                      ariaLabel="Your quote in ETB"
                                    />
                                  </div>

                                  <div>
                                    <label htmlFor={`quote-msg-${r.id}`}>Message (optional)</label>
                                    <select
                                      id={`quote-msg-${r.id}`}
                                      value={quoteMessageInputs[r.id] || ''}
                                      onChange={(e) =>
                                        setQuoteMessageInputs((q) => ({
                                          ...q,
                                          [r.id]: e.target.value,
                                        }))
                                      }
                                    >
                                      <option value="">No message</option>
                                      {BID_MESSAGES.map((m) => (
                                        <option key={m} value={m}>{m}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              </div>
                            </section>
                          )}

                          {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                          {/* Footer */}
                          {(canQuote || isMyTurn) && (
                            <div className="sd-card-actions">
                              {canQuote && (
                                <button
                                  type="button"
                                  className="sd-btn sd-btn-primary"
                                  disabled={submittingQuoteId === r.id}
                                  onClick={() => submitQuote(r.id)}
                                >
                                  {submittingQuoteId === r.id ? 'Submitting…' : 'Submit quote'}
                                </button>
                              )}

                              {isMyTurn && (
                                <>
                                  <button
                                    type="button"
                                    className="sd-btn sd-btn-primary"
                                    disabled={responding}
                                    onClick={() => acceptInspectionQuote(r.id, myLeaf.id)}
                                  >
                                    {responding ? 'Accepting…' : (myLeaf?.status === 'COUNTERED' && myLeaf?.counteredBy === 'REQUESTER' ? 'Accept buyer counter' : 'Accept quote')}
                                  </button>
                                  <button
                                    type="button"
                                    className="sd-btn sd-btn-outline"
                                    disabled={responding}
                                    onClick={() => counterInspectionQuote(r.id, myLeaf.id)}
                                  >
                                    {responding ? 'Sending…' : (myLeaf?.status === 'COUNTERED' ? 'Counter again' : 'Counter buyer')}
                                  </button>
                                  <button
                                    type="button"
                                    className="sd-btn sd-btn-outline"
                                    disabled={responding}
                                    onClick={() => rejectInspectionQuote(r.id, myLeaf.id)}
                                  >
                                    {responding ? 'Rejecting…' : 'Reject'}
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}

                  {available.length === 0 && (
                    <div className="sd-empty-state">
                      <div className="sd-empty-icon" aria-hidden="true">🔍</div>
                      <h3>No open requests</h3>
                      <p className="sd-muted">
                        New inspection requests will appear here.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* =====================================================
                MY JOBS
            ===================================================== */}

            {tab === 'mine' && (
              <div>
                <div className="sd-toolbar">
                  <div>
                    <span className="sd-eyebrow">MY JOBS</span>
                    <h2>My inspection jobs</h2>
                    <p className="sd-muted">
                      Start an accepted inspection when you arrive at the
                      inspection location. Submit the evidence report after
                      completing the inspection.
                    </p>
                  </div>
                </div>

                {/* ── Active jobs (cards) ─────────────────────── */}

                {pendingMine.length > 0 && (
                  <section className="sd-jobs-section">
                    <div className="sd-jobs-section-head">
                      <span className="sd-eyebrow">IN PROGRESS</span>
                      <h3 className="sd-jobs-section-title">
                        Active inspections
                        <span className="sd-jobs-count">{pendingMine.length}</span>
                      </h3>
                    </div>

                    <div className="sd-cards">
                      {pendingMine.map((r) => {
                        const tone = jobTone(r.status);
                        const steps = jobProgress(r.status);
                        const requesterName = r.requestedBy?.name || 'Requester';
                        const quantity = listingQuantity(r);
                        const place = r.location || r.listing?.location || 'Location not set';
                        const createdLabel = fmtDate(r.createdAt);
                        const orderId = r.listing?.orders?.[0]?.id;
                        const orderRef = shortOrder(orderId);
                        const amount = jobAmount(r);

                        const acceptedQuote = (r.quotes || []).find((q) => q.status === 'ACCEPTED');
                        const paid = (r.payments || []).some(
                          (p) => p.type === 'INSPECTOR' && p.status === 'PAID'
                        );

                        return (
                          <article className="sd-card sd-job-card" key={r.id}>
                            {/* Card head */}
                            <div className="sd-card-head">
                              <div className="sd-card-head-text">
                                <span className={`sd-eyebrow tone-${tone}`}>Inspection</span>
                                <h3 className="sd-card-title" title={listingTitle(r)}>
                                  {listingTitle(r)}
                                </h3>
                                {createdLabel && <p className="sd-card-sub">{createdLabel}</p>}
                              </div>

                              <div className="sd-card-head-party">
                                <div className="sd-party-info">
                                  <span className="sd-party-role">Requested by</span>
                                  <span className="sd-party-name">{requesterName}</span>
                                </div>
                                <div className={`sd-avatar tone-${tone}`} aria-hidden="true">
                                  {initialsOf(requesterName)}
                                </div>
                              </div>
                            </div>

                            <div className="sd-card-body">
                              {/* Block 1 — Inspection status */}
                              <section className="sd-card-block">
                                <div className="sd-card-block-title">
                                  <h4>Inspection status</h4>
                                  {orderRef && <span className="sd-card-block-note">{orderRef}</span>}
                                </div>
                                <div className="sd-card-block-body">
                                  <div className="sd-pills">
                                    <span className={`sd-pill tone-${tone}`}>
                                      <span className="sd-pill-dot" aria-hidden="true" />
                                      {r.status.replaceAll('_', ' ')}
                                    </span>
                                  </div>

                                  <div className="sd-progress sd-progress--3" aria-label="Inspection progress">
                                    {steps.map((step) => (
                                      <div
                                        key={step.label}
                                        className={`sd-progress-step ${step.cls}`}
                                        title={step.label}
                                      >
                                        <span className="sd-progress-dot" aria-hidden="true" />
                                        <span className="sd-progress-label">{step.label}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </section>

                              {r.sellerMessage && <p className="sd-card-foot">Seller instructions: {r.sellerMessage}</p>}

                              {/* Block 2 — Inspection details */}
                              <section className="sd-card-block">
                                <div className="sd-card-block-title">
                                  <h4>Inspection details</h4>
                                </div>
                                <div className="sd-card-block-body">
                                  <div className="sd-job-meta">
                                    {r.mode && (
                                      <div className="sd-job-meta-item">
                                        <span>Mode</span>
                                        <strong>{modeLabel(r.mode)}</strong>
                                      </div>
                                    )}
                                    {quantity && (
                                      <div className="sd-job-meta-item">
                                        <span>Quantity</span>
                                        <strong>{quantity}</strong>
                                      </div>
                                    )}
                                    <div className="sd-job-meta-item">
                                      <span>Location</span>
                                      <strong>{place}</strong>
                                    </div>
                                  </div>
                                  <InspectionRequestSummary inspection={r} title="Scope to inspect" />
                                </div>
                              </section>

                              {/* Block 3 — Amount */}
                              {amount && (
                                <section className="sd-card-block">
                                  <div className="sd-card-block-title">
                                    <h4>Inspection fee</h4>
                                    <span className="sd-card-block-note">{paid ? 'Paid' : 'Provisional'}</span>
                                  </div>
                                  <div className="sd-card-block-body">
                                    <AmountRow value={amount} />
                                  </div>
                                </section>
                              )}

                              {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                              {/* Footer */}
                              <div className="sd-card-actions">
                                {r.status === 'ACCEPTED' && (
                                  <>
                                    {r.sellerConfirmedAt ? (
                                      <button type="button" className="sd-btn sd-btn-primary" onClick={() => startInspection(r.id)}>Start inspection</button>
                                    ) : (
                                      <p role="status">Waiting for seller confirmation. You cannot start or report yet.</p>
                                    )}

                                    {acceptedQuote && !paid && (
                                      <button
                                        type="button"
                                        className="sd-btn sd-btn-outline"
                                        disabled={respondingQuoteId === acceptedQuote.id}
                                        onClick={() => cancelAcceptedInspection(r.id, acceptedQuote.id)}
                                      >
                                        {respondingQuoteId === acceptedQuote.id
                                          ? 'Cancelling…'
                                          : 'Cancel provisional deal'}
                                      </button>
                                    )}
                                  </>
                                )}

                                {r.status === 'IN_PROGRESS' && (
                                  <button
                                    type="button"
                                    className="sd-btn sd-btn-primary"
                                    onClick={() => openReportForm(r.id)}
                                  >
                                    Submit report
                                  </button>
                                )}

                                {orderId && (
                                  <Link to={`/orders/${orderId}`} className="sd-btn sd-btn-outline">
                                    View order
                                    <ArrowIcon />
                                  </Link>
                                )}
                              </div>

                              {/* ★ Site handoff — seller <-> inspector coordination.
                                  Only the assigned inspector and the listing
                                  seller can see this; the buyer never does.
                                  Rendered only on active jobs. The server
                                  gates access by role and inspection status,
                                  so this is a UX guard, not security. */}
                              <InspectionCoordinationInspector
                                inspectionRequestId={r.id}
                              />
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* ── Completed (table) ───────────────────────── */}

                {completedMine.length > 0 && (
                  <section className="sd-jobs-section">
                    <div className="sd-jobs-section-head">
                      <span className="sd-eyebrow">HISTORY</span>
                      <h3 className="sd-jobs-section-title">
                        Completed inspections
                        <span className="sd-jobs-count">{completedMine.length}</span>
                      </h3>
                    </div>

                    <div className="sd-panel sd-table-wrap">
                      <table className="sd-table sd-table--mobile-cards">
                        <thead>
                          <tr>
                            <th>Listing</th>
                            <th>Report</th>
                            <th>Status</th>
                            <th>Action</th>
                          </tr>
                        </thead>

                        <tbody>
                          {completedMine.map((r) => (
                            <tr key={r.id}>
                              <td data-label="Listing">
                                <strong>{listingTitle(r)}</strong>
                              </td>

                              <td data-label="Report">
                                {r.report
                                  ? `Grade: ${r.report.grade || '—'} · Quantity verified: ${r.report.quantity}`
                                  : 'Report on file'}
                              </td>

                              <td data-label="Status">
                                <span className="sd-badge">COMPLETED</span>
                              </td>

                              <td data-label="Action">
                                <Link to={`/listings/${r.listing?.id}`} className="sd-table-action">
                                  View listing
                                  <ArrowIcon />
                                </Link>
                                <button type="button" className="sd-table-action" style={{ marginLeft: 8, border: 0, background: 'none', cursor: 'pointer' }} onClick={() => addReportAddendum(r.id)}>
                                  Add correction
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {/* ── Empty state ─────────────────────────────── */}

                {pendingMine.length === 0 && completedMine.length === 0 && (
                  <div className="sd-empty-state">
                    <div className="sd-empty-icon" aria-hidden="true">📋</div>
                    <h3>No inspection jobs yet</h3>
                    <p className="sd-muted">
                      Once a requester accepts your quote, the job will appear here with the next steps.
                    </p>
                    <button
                      type="button"
                      className="sd-btn sd-btn-primary"
                      onClick={() => setTab('available')}
                    >
                      Browse available jobs
                    </button>
                  </div>
                )}

                {pendingMine.length === 0 && completedMine.length > 0 && (
                  <p className="sd-muted" style={{ marginTop: 4 }}>
                    No accepted or in-progress inspection jobs.
                  </p>
                )}
              </div>
            )}

            {/* =====================================================
                REPORT MODAL
            ===================================================== */}

            {activeRequestId && (
              <div
                className="sd-report-backdrop"
                role="presentation"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) {
                    closeReportForm();
                  }
                }}
              >
                <div
                  className="sd-report-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="inspection-report-title"
                >
                  <div className="sd-report-header">
                    <div>
                      <span className="sd-eyebrow">INSPECTION EVIDENCE</span>

                      <h2 id="inspection-report-title">
                        {productReport
                          ? 'Product inspection report'
                          : 'Agricultural inspection report'}
                      </h2>

                      <p className="sd-muted">
                        {productReport
                          ? 'Verify identity, physical condition, functionality and included items for the product.'
                          : 'Record the verified condition, quantity, quality and supporting evidence for the produce.'}
                      </p>
                    </div>

                    <button
                      type="button"
                      className="btn btn-light btn-sm"
                      onClick={closeReportForm}
                      aria-label="Close report form"
                    >
                      Close
                    </button>
                  </div>

                  <form onSubmit={submitReport}>
                    <div className="sd-form-grid">
                      <div>
                        <label htmlFor="rep-quantity">
                          {productReport ? 'Verified units / quantity' : 'Verified quantity'}
                        </label>
                        <input
                          id="rep-quantity"
                          required
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={report.quantity}
                          onChange={(e) =>
                            setReport({ ...report, quantity: e.target.value })
                          }
                        />
                      </div>

                      <div>
                        <label htmlFor="rep-grade">
                          {productReport ? 'Condition / quality grade' : 'Grade'}
                        </label>
                        <input
                          id="rep-grade"
                          value={report.grade}
                          onChange={(e) =>
                            setReport({ ...report, grade: e.target.value })
                          }
                        />
                      </div>

                      {!productReport && (
                        <div>
                          <label htmlFor="rep-moisture">Moisture (%)</label>
                          <input
                            id="rep-moisture"
                            type="number"
                            min="0"
                            step="0.01"
                            value={report.moisture}
                            onChange={(e) =>
                              setReport({ ...report, moisture: e.target.value })
                            }
                          />
                        </div>
                      )}

                      <div>
                        <label htmlFor="rep-gps">
                          {productReport
                            ? 'Product identifier / model / serial'
                            : 'GPS / location evidence'}
                        </label>
                        <input
                          id="rep-gps"
                          value={report.gpsLocation}
                          placeholder={
                            productReport
                              ? 'Model, serial number, SKU or identifying marks'
                              : 'e.g. 8.9806, 38.7578'
                          }
                          onChange={(e) =>
                            setReport({ ...report, gpsLocation: e.target.value })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label htmlFor="rep-defects">
                          {productReport ? 'Functional / visible condition' : 'Visible defects'}
                        </label>
                        <textarea
                          id="rep-defects"
                          value={report.visibleDefects}
                          placeholder={
                            productReport
                              ? 'Describe operation/function test, visible condition, faults or defects.'
                              : 'Describe visible defects, quality issues or contamination.'
                          }
                          onChange={(e) =>
                            setReport({ ...report, visibleDefects: e.target.value })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label htmlFor="rep-damage">
                          {productReport ? 'Physical damage / wear' : 'Damage notes'}
                        </label>
                        <textarea
                          id="rep-damage"
                          value={report.damageNotes}
                          placeholder={
                            productReport
                              ? 'Describe scratches, dents, wear, missing parts or other physical damage.'
                              : 'Describe physical damage, bruising, broken packaging, etc.'
                          }
                          onChange={(e) =>
                            setReport({ ...report, damageNotes: e.target.value })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label htmlFor="rep-packaging">
                          {productReport
                            ? 'Included items / packaging / accessories'
                            : 'Packaging notes'}
                        </label>
                        <textarea
                          id="rep-packaging"
                          value={report.packagingNotes}
                          placeholder={
                            productReport
                              ? 'List accessories, documents, packaging and included components verified.'
                              : 'Describe packaging condition and quantity of packages inspected.'
                          }
                          onChange={(e) =>
                            setReport({ ...report, packagingNotes: e.target.value })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label htmlFor="rep-assessment">Inspector assessment</label>
                        <textarea
                          id="rep-assessment"
                          value={report.assessmentSummary}
                          placeholder="Summarize the verified condition and the most important findings. Do not set or dictate a sale price."
                          onChange={(e) => setReport({ ...report, assessmentSummary: e.target.value })}
                        />
                      </div>

                      <div className="sd-full">
                        <label>Quality flags</label>
                        <div className="sd-check-grid">
                          {['QUANTITY_VARIANCE','LOW_GRADE','MOISTURE_CONCERN','VISIBLE_DAMAGE','PACKAGING_DAMAGE','FRESHNESS_CONCERN','FUNCTIONAL_ISSUE','SPECIFICATION_MISMATCH'].map((flag) => (
                            <label key={flag}>
                              <input
                                type="checkbox"
                                checked={report.qualityFlags.includes(flag)}
                                onChange={(e) => setReport({ ...report, qualityFlags: e.target.checked ? [...report.qualityFlags, flag] : report.qualityFlags.filter((v) => v !== flag) })}
                              /> {flag.replaceAll('_', ' ').toLowerCase()}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="sd-full sd-photo-evidence">
                        <strong>Photo / video evidence</strong>
                        <EvidenceUploader
                          uploadUrl={`/inspections/${activeRequestId}/evidence/media`}
                          onUploaded={({ photoKeys, videoKeys }) =>
                            setReportEvidence((prev) => ({
                              photoKeys: [...prev.photoKeys, ...photoKeys],
                              videoKeys: [...prev.videoKeys, ...videoKeys],
                            }))
                          }
                        />
                        {(reportEvidence.photoKeys.length > 0 ||
                          reportEvidence.videoKeys.length > 0) && (
                          <p className="muted small">
                            {reportEvidence.photoKeys.length} photo(s),{' '}
                            {reportEvidence.videoKeys.length} video(s) attached
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="sd-modal-actions sd-report-actions">
                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        onClick={closeReportForm}
                      >
                        Cancel
                      </button>
                      <button className="sd-btn sd-btn-primary" type="submit">
                        Publish evidence report
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>

          {/* =====================================================
              EVIDENCE CHECKLIST
          ===================================================== */}

          <aside className="sd-aside">
            <div className="sd-card sd-checklist">
              <div className="sd-card-head">
                <div className="sd-card-head-text">
                  <span className="sd-eyebrow tone-info">Reference</span>
                  <h3 className="sd-card-title">Evidence checklist</h3>
                  <p className="sd-card-sub">What every report should cover</p>
                </div>
              </div>

              <ul className="sd-check-list">
                {CHECKLIST.map((x) => (
                  <li className="sd-check-row" key={x}>
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </section>

      {/* =========================================================
          TOAST — floats in view, above modals and the bottom tab bar
      ========================================================= */}

      {(error || msg) && (
        <div
          className={`sd-toast ${error ? 'sd-toast--error' : 'sd-toast--success'}`}
          role={error ? 'alert' : 'status'}
          aria-live={error ? 'assertive' : 'polite'}
        >
          <span className="sd-toast-text">{error || msg}</span>
          <button
            type="button"
            className="sd-toast-close"
            aria-label="Dismiss message"
            onClick={dismissToast}
          >
            ×
          </button>
        </div>
      )}
      <ProviderReleaseDialog
        open={Boolean(releaseTarget)}
        serviceLabel="inspection agreement"
        busy={Boolean(releaseTarget) && respondingQuoteId === releaseTarget.quoteId}
        onConfirm={confirmCancelAcceptedInspection}
        onClose={() => setReleaseTarget(null)}
      />
    </div>
  );
}
