import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const EMPTY_REPORT = {
  quantity: '',
  grade: '',
  moisture: '',
  visibleDefects: '',
  damageNotes: '',
  packagingNotes: '',
  gpsLocation: '',
};

function modeLabel(mode) {
  return (mode || '').replaceAll('_', ' ');
}

export default function InspectorDashboard() {
  const { user } = useAuth();
  const currentUserId = user?.id || user?.userId || user?._id || null;

  const [tab, setTab] = useState('available');

  const [available, setAvailable] = useState([]);
  const [mine, setMine] = useState([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const [feeInputs, setFeeInputs] = useState({});
  const [quoteAmountInputs, setQuoteAmountInputs] = useState({});
  const [quoteMessageInputs, setQuoteMessageInputs] = useState({});
  const [submittingQuoteId, setSubmittingQuoteId] = useState('');
  const [quotedRequestIds, setQuotedRequestIds] = useState(() => new Set());
  const [quoteCounterInputs, setQuoteCounterInputs] = useState({});
  const [respondingQuoteId, setRespondingQuoteId] = useState('');
  const [activeRequestId, setActiveRequestId] = useState('');
  const [report, setReport] = useState(EMPTY_REPORT);
  const [reportEvidence, setReportEvidence] = useState({ photoKeys: [], videoKeys: [] });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [availRes, mineRes] = await Promise.all([
        api.get('/inspections/available'),
        api.get('/inspections/mine'),
      ]);

      setAvailable(availRes.data?.requests || []);
      setMine(mineRes.data?.requests || []);
    } catch (err) {
      setError(
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
        'Quote submitted. The requester will pick one inspector, or someone may claim the job outright before then.'
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
    return list.find((q) => !parentIds.has(q.id)) || null;
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

  const acceptedMine = mine.filter(
    (r) => r.status === 'ACCEPTED'
  );

  const inProgressMine = mine.filter(
    (r) => r.status === 'IN_PROGRESS'
  );

  const pendingMine = mine.filter(
    (r) =>
      r.status === 'ACCEPTED' ||
      r.status === 'IN_PROGRESS'
  );

  const completedMine = mine.filter(
    (r) => r.status === 'COMPLETED'
  );

  if (loading) {
    return (
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">
            INSPECTOR DASHBOARD
          </span>

          <h1>
            Loading your inspection workspace...
          </h1>

          <p className="sd-muted">
            Loading available jobs and your accepted
            inspections.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sd-dashboard">
      <section>
        <div className="sd-toolbar">
          <div>
            <span className="sd-eyebrow">
              INSPECTOR DASHBOARD
            </span>

            <h1>
              Verify. Document. Report.
            </h1>

            <p
              className="sd-muted"
              style={{ maxWidth: 780 }}
            >
              Inspectors are independent verifiers. They do
              not own produce, set farmer prices or arrange
              transport.
            </p>
          </div>

          <span className="sd-badge sd-blue">
            VERIFICATION ROLE
          </span>
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

      {msg && (
        <section>
          <div className="alert success">
            {msg}
          </div>
        </section>
      )}

      {error && (
        <section>
          <div className="alert error">
            {error}
          </div>
        </section>
      )}

      <section>
        <div className="sd-tabs">
          <button
            type="button"
            className={`sd-tab ${
              tab === 'available'
                ? 'sd-active'
                : ''
            }`}
            onClick={() =>
              setTab('available')
            }
          >
            Available Jobs{' '}
            {available.length > 0 &&
              `(${available.length})`}
          </button>

          <button
            type="button"
            className={`sd-tab ${
              tab === 'mine'
                ? 'sd-active'
                : ''
            }`}
            onClick={() =>
              setTab('mine')
            }
          >
            My Jobs{' '}
            {pendingMine.length > 0 &&
              `(${pendingMine.length})`}
          </button>
        </div>

        <div className="sd-workspace">
          <div>
            {tab === 'available' && (
              <div>
                <div className="sd-toolbar">
                  <div>
                    <span className="sd-eyebrow">
                      MARKETPLACE
                    </span>

                    <h2>
                      Open inspection requests
                    </h2>

                    <p className="sd-muted">
                      Requests from sellers or buyers
                      that no inspector has accepted
                      yet.
                    </p>
                  </div>
                </div>

                <div className="sd-cards">
                  {available.map((r) => (
                    <div
                      className="sd-card"
                      key={r.id}
                    >
                      <h3>
                        {r.listing?.cropType ||
                          r.listing?.title ||
                          'Listing'}{' '}
                        · {r.listing?.quantity}{' '}
                        {r.listing?.unit}
                      </h3>

                      <p className="sd-muted">
                        {modeLabel(r.mode)} —
                        requested for{' '}
                        {r.location ||
                          r.listing?.location ||
                          'location not set'}
                      </p>

                      <p className="sd-muted">
                        Requested by{' '}
                        {r.requestedBy?.name ||
                          'user'}
                      </p>

                      {(() => {
                        const myLeaf = leafInspectionQuote(r.quotes);
                        if (!myLeaf) return null;
                        const displayAmount = myLeaf.status === 'COUNTERED' ? (myLeaf.counterAmount ?? myLeaf.amount) : myLeaf.amount;
                        return (
                          <p className="sd-muted">
                            You quoted {Number(displayAmount).toLocaleString()} ETB on this job ({myLeaf.status}).
                            Quotes are sealed — you won't see what anyone else bids, and the requester decides.
                          </p>
                        );
                      })()}

                      <div
                        className="sd-form-grid"
                        style={{
                          marginTop: 12,
                        }}
                      >
                        <div>
                          <label>
                            Your fee (ETB)
                          </label>

                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            placeholder="e.g. 500"
                            value={
                              feeInputs[r.id] ||
                              ''
                            }
                            onChange={(e) =>
                              setFeeInputs(
                                (f) => ({
                                  ...f,
                                  [r.id]:
                                    e.target
                                      .value,
                                })
                              )
                            }
                          />
                        </div>
                      </div>

                      <button
                        type="button"
                        className="sd-btn sd-btn-primary"
                        style={{
                          marginTop: 6,
                        }}
                        onClick={() =>
                          accept(r.id)
                        }
                      >
                        Accept job
                      </button>

                      {!(quotedRequestIds.has(r.id) || (() => { const l = leafInspectionQuote(r.quotes); return l && ['PENDING', 'COUNTERED'].includes(l.status); })()) && (
                        <p className="sd-muted" style={{ marginTop: 10, marginBottom: 4 }}>
                          Or submit a sealed quote instead of claiming it outright — the requester compares every inspector's quote and picks one; nobody, including you, sees anyone else's amount.
                        </p>
                      )}

                      {(() => {
                        const myLeaf = leafInspectionQuote(r.quotes);
                        const hasActiveThread = myLeaf && ['PENDING', 'COUNTERED'].includes(myLeaf.status);

                        if (!hasActiveThread) {
                          if (quotedRequestIds.has(r.id)) {
                            return <p className="sd-muted" style={{ marginTop: 10 }}>Waiting on the requester's decision.</p>;
                          }
                          return (
                            <>
                              <div
                                className="sd-form-grid"
                                style={{ marginTop: 6 }}
                              >
                                <div>
                                  <label>Your quote (ETB)</label>
                                  <input
                                    type="number"
                                    min="1"
                                    step="0.01"
                                    placeholder="e.g. 450"
                                    value={quoteAmountInputs[r.id] || ''}
                                    onChange={(e) =>
                                      setQuoteAmountInputs((q) => ({
                                        ...q,
                                        [r.id]: e.target.value,
                                      }))
                                    }
                                  />
                                </div>
                              </div>

                              <textarea
                                placeholder="Optional message to the requester"
                                value={quoteMessageInputs[r.id] || ''}
                                onChange={(e) =>
                                  setQuoteMessageInputs((q) => ({
                                    ...q,
                                    [r.id]: e.target.value,
                                  }))
                                }
                                style={{ marginTop: 6, width: '100%' }}
                              />

                              <button
                                type="button"
                                className="sd-btn sd-btn-outline"
                                style={{ marginTop: 6 }}
                                disabled={submittingQuoteId === r.id}
                                onClick={() => submitQuote(r.id)}
                              >
                                {submittingQuoteId === r.id ? 'Submitting…' : 'Submit quote'}
                              </button>
                            </>
                          );
                        }

                        const isMyTurn = myLeaf.status === 'COUNTERED' && myLeaf.counteredBy === 'REQUESTER';

                        if (!isMyTurn) {
                          return <p className="sd-muted" style={{ marginTop: 10 }}>Waiting on the requester's decision.</p>;
                        }

                        return (
                          <div style={{ marginTop: 10 }}>
                            <p className="sd-muted">
                              The requester countered at {Number(myLeaf.counterAmount ?? myLeaf.amount).toLocaleString()} ETB.
                            </p>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <button
                                type="button"
                                className="sd-btn sd-btn-primary"
                                disabled={respondingQuoteId === myLeaf.id}
                                onClick={() => acceptInspectionQuote(r.id, myLeaf.id)}
                              >
                                {respondingQuoteId === myLeaf.id ? 'Accepting…' : 'Accept'}
                              </button>
                              <input
                                type="number"
                                min="1"
                                step="0.01"
                                placeholder="Counter (ETB)"
                                style={{ width: 130 }}
                                value={quoteCounterInputs[myLeaf.id] || ''}
                                onChange={(e) =>
                                  setQuoteCounterInputs((q) => ({ ...q, [myLeaf.id]: e.target.value }))
                                }
                              />
                              <button
                                type="button"
                                className="sd-btn sd-btn-outline"
                                disabled={respondingQuoteId === myLeaf.id}
                                onClick={() => counterInspectionQuote(r.id, myLeaf.id)}
                              >
                                {respondingQuoteId === myLeaf.id ? 'Sending…' : 'Counter'}
                              </button>
                              <button
                                type="button"
                                className="sd-btn sd-btn-outline"
                                disabled={respondingQuoteId === myLeaf.id}
                                onClick={() => rejectInspectionQuote(r.id, myLeaf.id)}
                              >
                                {respondingQuoteId === myLeaf.id ? 'Rejecting…' : 'Reject'}
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))}

                  {available.length === 0 && (
                    <div className="sd-panel">
                      <h3>
                        No open requests
                      </h3>

                      <p className="sd-muted">
                        New inspection requests
                        will appear here.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'mine' && (
              <div>
                <div className="sd-toolbar">
                  <div>
                    <span className="sd-eyebrow">
                      MY JOBS
                    </span>

                    <h2>
                      My inspection jobs
                    </h2>

                    <p className="sd-muted">
                      Start an accepted inspection
                      when you arrive at the inspection
                      location. Submit the evidence
                      report after completing the
                      inspection.
                    </p>
                  </div>
                </div>

                <div className="sd-cards">
                  {pendingMine.map((r) => (
                    <div
                      className="sd-card"
                      key={r.id}
                    >
                      <h3>
                        {r.listing?.cropType ||
                          r.listing?.title ||
                          'Listing'}{' '}
                        · {r.listing?.quantity}{' '}
                        {r.listing?.unit}
                      </h3>

                      <p className="sd-muted">
                        {modeLabel(r.mode)} —{' '}
                        {r.location ||
                          r.listing?.location ||
                          'location not set'}
                      </p>

                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          marginTop: 12,
                        }}
                      >
                        {r.status ===
                          'ACCEPTED' && (
                          <button
                            type="button"
                            className="sd-btn sd-btn-primary"
                            onClick={() =>
                              startInspection(
                                r.id
                              )
                            }
                          >
                            Start inspection
                          </button>
                        )}

                        {r.status ===
                          'IN_PROGRESS' && (
                          <button
                            type="button"
                            className="sd-btn sd-btn-primary"
                            onClick={() =>
                              openReportForm(
                                r.id
                              )
                            }
                          >
                            Submit report
                          </button>
                        )}
                      </div>

                      <div
                        style={{
                          marginTop: 10,
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        {r.listing?.orders?.[0]?.id && (
                          <Link
                            to={`/orders/${r.listing.orders[0].id}`}
                            className="sd-btn sd-btn-outline"
                          >
                            Open related order
                          </Link>
                        )}
                        <span className="sd-badge">
                          {r.status.replaceAll(
                            '_',
                            ' '
                          )}
                        </span>
                      </div>
                    </div>
                  ))}

                  {pendingMine.length === 0 && (
                    <div className="sd-panel">
                      <p className="sd-muted">
                        No accepted or in-progress
                        inspection jobs.
                      </p>
                    </div>
                  )}
                </div>

                {completedMine.length > 0 && (
                  <>
                    <div
                      className="sd-toolbar"
                      style={{
                        marginTop: 28,
                      }}
                    >
                      <div>
                        <span className="sd-eyebrow">
                          HISTORY
                        </span>

                        <h2>
                          Completed
                        </h2>
                      </div>
                    </div>

                    <div className="sd-panel sd-table-wrap">
                      <table className="sd-table">
                        <thead>
                          <tr>
                            <th>
                              Listing
                            </th>

                            <th>
                              Report
                            </th>

                            <th>
                              Action
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          {completedMine.map(
                            (r) => (
                              <tr key={r.id}>
                                <td>
                                  <strong>
                                    {r.listing
                                      ?.cropType ||
                                      r.listing
                                        ?.title ||
                                      'Listing'}
                                  </strong>
                                </td>

                                <td className="sd-muted">
                                  {r.report
                                    ? `Grade: ${
                                        r.report
                                          .grade ||
                                        '—'
                                      } · Quantity verified: ${
                                        r.report
                                          .quantity
                                      }`
                                    : 'Report on file'}
                                </td>

                                <td>
                                  <Link
                                    to={`/listings/${r.listing?.id}`}
                                  >
                                    <button
                                      type="button"
                                      className="sd-btn sd-btn-outline"
                                    >
                                      View listing
                                    </button>
                                  </Link>
                                </td>
                              </tr>
                            )
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeRequestId && (
              <div
                className="sd-report-backdrop"
                role="presentation"
                onMouseDown={(e) => {
                  if (
                    e.target ===
                    e.currentTarget
                  ) {
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
                      <span className="sd-eyebrow">
                        INSPECTION EVIDENCE
                      </span>

                      <h2 id="inspection-report-title">
                        Inspection report
                      </h2>

                      <p className="sd-muted">
                        Record the verified condition
                        of the produce and supporting
                        evidence.
                      </p>
                    </div>

                    <button
                      type="button"
                      className="sd-close"
                      onClick={
                        closeReportForm
                      }
                      aria-label="Close report form"
                    >
                      ×
                    </button>
                  </div>

                  <form
                    onSubmit={submitReport}
                  >
                    <div className="sd-form-grid">
                      <div>
                        <label>
                          Verified quantity
                        </label>

                        <input
                          required
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={
                            report.quantity
                          }
                          onChange={(e) =>
                            setReport({
                              ...report,
                              quantity:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div>
                        <label>
                          Grade
                        </label>

                        <input
                          value={
                            report.grade
                          }
                          onChange={(e) =>
                            setReport({
                              ...report,
                              grade:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div>
                        <label>
                          Moisture (%)
                        </label>

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={
                            report.moisture
                          }
                          onChange={(e) =>
                            setReport({
                              ...report,
                              moisture:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div>
                        <label>
                          GPS / location evidence
                        </label>

                        <input
                          value={
                            report.gpsLocation
                          }
                          placeholder="e.g. 8.9806, 38.7578"
                          onChange={(e) =>
                            setReport({
                              ...report,
                              gpsLocation:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label>
                          Visible defects
                        </label>

                        <textarea
                          value={
                            report.visibleDefects
                          }
                          placeholder="Describe visible defects, quality issues or contamination."
                          onChange={(e) =>
                            setReport({
                              ...report,
                              visibleDefects:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label>
                          Damage notes
                        </label>

                        <textarea
                          value={
                            report.damageNotes
                          }
                          placeholder="Describe physical damage, bruising, broken packaging, etc."
                          onChange={(e) =>
                            setReport({
                              ...report,
                              damageNotes:
                                e.target
                                  .value,
                            })
                          }
                        />
                      </div>

                      <div className="sd-full">
                        <label>
                          Packaging notes
                        </label>

                        <textarea
                          value={
                            report.packagingNotes
                          }
                          placeholder="Describe packaging condition and quantity of packages inspected."
                          onChange={(e) =>
                            setReport({
                              ...report,
                              packagingNotes:
                                e.target
                                  .value,
                            })
                          }
                        />
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
                        {(reportEvidence.photoKeys.length > 0 || reportEvidence.videoKeys.length > 0) && (
                          <p className="muted small">
                            {reportEvidence.photoKeys.length} photo(s), {reportEvidence.videoKeys.length} video(s) attached
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="sd-modal-actions sd-report-actions">
                      <button
                        className="sd-btn sd-btn-primary"
                        type="submit"
                      >
                        Publish evidence report
                      </button>

                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        onClick={
                          closeReportForm
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>

          <aside>
            <div className="sd-panel">
              <h3>
                Evidence checklist
              </h3>

              {[
                'Quantity',
                'Grade / quality',
                'Size where applicable',
                'Moisture where applicable',
                'Visible defects / damage',
                'Packaging',
                'Photos / videos',
                'GPS / location',
                'Date, time & inspector identity',
              ].map((x) => (
                <div
                  className="tool-row"
                  key={x}
                >
                  ✓ {x}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
