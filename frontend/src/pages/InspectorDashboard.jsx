import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

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
  const [tab, setTab] = useState('available');

  const [available, setAvailable] = useState([]);
  const [mine, setMine] = useState([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const [feeInputs, setFeeInputs] = useState({});
  const [activeRequestId, setActiveRequestId] = useState('');
  const [report, setReport] = useState(EMPTY_REPORT);

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
      setError(err.response?.data?.error || 'Could not load inspection jobs.');
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
      setError('Enter your fee for this inspection before accepting.');
      return;
    }

    try {
      await api.patch(`/inspections/${id}/accept`, { fee });
      setMsg('Job accepted. It is now in "My Jobs" — submit your report once the inspection is complete.');
      setTab('mine');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not accept this job — it may have just been claimed by another inspector.');
    }
  }

  function openReportForm(requestId) {
    setActiveRequestId(requestId);
    setReport(EMPTY_REPORT);
    setMsg('');
    setError('');
  }

  function closeReportForm() {
    setActiveRequestId('');
    setReport(EMPTY_REPORT);
  }

  async function submitReport(e) {
    e.preventDefault();
    if (!activeRequestId) return;

    try {
      await api.post(`/inspections/${activeRequestId}/report`, {
        ...report,
        quantity: Number(report.quantity),
        moisture: report.moisture ? Number(report.moisture) : undefined,
        photos: [],
        videos: [],
      });

      setMsg('Inspection report submitted and marked complete.');
      closeReportForm();
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit report.');
    }
  }

  const pendingMine = mine.filter((r) => r.status === 'ACCEPTED' || r.status === 'IN_PROGRESS');
  const completedMine = mine.filter((r) => r.status === 'COMPLETED');

  return (
    <main className="section">
      <div className="container-wide">
        <div className="page-header">
          <div>
            <span className="eyebrow">INSPECTOR DASHBOARD</span>
            <h1>Verify. Document. Report.</h1>
            <p>Inspectors are independent verifiers. They do not own produce, set farmer prices or arrange transport.</p>
          </div>
          <span className="role-chip">VERIFICATION ROLE</span>
        </div>

        {msg && <div className="alert success">{msg}</div>}
        {error && <div className="alert error">{error}</div>}

        <div className="sd-tabs" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`sd-tab ${tab === 'available' ? 'sd-active' : ''}`}
            onClick={() => setTab('available')}
          >
            Available Jobs {available.length > 0 && `(${available.length})`}
          </button>
          <button
            type="button"
            className={`sd-tab ${tab === 'mine' ? 'sd-active' : ''}`}
            onClick={() => setTab('mine')}
          >
            My Jobs {pendingMine.length > 0 && `(${pendingMine.length})`}
          </button>
        </div>

        <div className="dashboard-layout">
          <section>
            {tab === 'available' && (
              <div className="card">
                <h2>Open inspection requests</h2>
                <p className="muted">Requests from sellers or buyers that no inspector has accepted yet.</p>

                {loading ? (
                  <p className="muted">Loading…</p>
                ) : (
                  <div className="request-list">
                    {available.map((r) => (
                      <div className="request-row" key={r.id}>
                        <div>
                          <strong>{r.listing?.cropType || 'Listing'} · {r.listing?.quantity} {r.listing?.unit}</strong>
                          <p>{modeLabel(r.mode)} — requested for {r.listing?.location || 'location not set'}</p>
                          <p className="muted">Requested by {r.requestedBy?.name || 'user'}</p>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            placeholder="Your fee (ETB)"
                            style={{ width: 130 }}
                            value={feeInputs[r.id] || ''}
                            onChange={(e) => setFeeInputs((f) => ({ ...f, [r.id]: e.target.value }))}
                          />
                          <button type="button" className="btn btn-primary" onClick={() => accept(r.id)}>
                            Accept job
                          </button>
                        </div>
                      </div>
                    ))}

                    {available.length === 0 && <p className="muted">No open requests right now.</p>}
                  </div>
                )}
              </div>
            )}

            {tab === 'mine' && (
              <div className="card">
                <h2>My accepted jobs</h2>
                <p className="muted">Jobs you've accepted. Submit a report once the inspection is complete.</p>

                {loading ? (
                  <p className="muted">Loading…</p>
                ) : (
                  <div className="request-list">
                    {pendingMine.map((r) => (
                      <div className="request-row" key={r.id}>
                        <div>
                          <strong>{r.listing?.cropType || 'Listing'} · {r.listing?.quantity} {r.listing?.unit}</strong>
                          <p>{modeLabel(r.mode)} — {r.listing?.location || 'location not set'}</p>
                        </div>
                        <button type="button" className="btn btn-primary" onClick={() => openReportForm(r.id)}>
                          Submit report
                        </button>
                      </div>
                    ))}

                    {pendingMine.length === 0 && <p className="muted">No jobs in progress.</p>}
                  </div>
                )}

                {completedMine.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 24 }}>Completed</h3>
                    <div className="request-list">
                      {completedMine.map((r) => (
                        <div className="request-row" key={r.id}>
                          <div>
                            <strong>{r.listing?.cropType || 'Listing'}</strong>
                            <p className="muted">
                              {r.report ? `Grade: ${r.report.grade || '—'} · Quantity verified: ${r.report.quantity}` : 'Report on file'}
                            </p>
                          </div>
                          <Link to={`/listings/${r.listing?.id}`}>
                            <button type="button" className="btn btn-light">View listing</button>
                          </Link>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {activeRequestId && (
              <div className="card" style={{ marginTop: 20 }}>
                <h2>Inspection report</h2>
                <form onSubmit={submitReport}>
                  <div className="form-grid">
                    <div>
                      <label>Verified quantity</label>
                      <input
                        required
                        type="number"
                        value={report.quantity}
                        onChange={(e) => setReport({ ...report, quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Grade</label>
                      <input value={report.grade} onChange={(e) => setReport({ ...report, grade: e.target.value })} />
                    </div>
                    <div>
                      <label>Moisture (%)</label>
                      <input
                        type="number"
                        value={report.moisture}
                        onChange={(e) => setReport({ ...report, moisture: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>GPS / location evidence</label>
                      <input
                        value={report.gpsLocation}
                        onChange={(e) => setReport({ ...report, gpsLocation: e.target.value })}
                      />
                    </div>
                  </div>

                  <label>Visible defects</label>
                  <textarea
                    value={report.visibleDefects}
                    onChange={(e) => setReport({ ...report, visibleDefects: e.target.value })}
                  />

                  <label>Damage notes</label>
                  <textarea
                    value={report.damageNotes}
                    onChange={(e) => setReport({ ...report, damageNotes: e.target.value })}
                  />

                  <label>Packaging notes</label>
                  <textarea
                    value={report.packagingNotes}
                    onChange={(e) => setReport({ ...report, packagingNotes: e.target.value })}
                  />

                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn btn-primary" type="submit">Publish evidence report</button>
                    <button type="button" className="btn btn-light" onClick={closeReportForm}>Cancel</button>
                  </div>
                </form>
              </div>
            )}
          </section>

          <aside>
            <div className="card">
              <h3>Evidence checklist</h3>
              {[
                'Quantity', 'Grade / quality', 'Size where applicable', 'Moisture where applicable',
                'Visible defects / damage', 'Packaging', 'Photos / videos', 'GPS / location',
                'Date, time & inspector identity',
              ].map((x) => (
                <div className="tool-row" key={x}>✓ {x}</div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
