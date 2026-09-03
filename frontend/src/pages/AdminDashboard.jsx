import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];

export default function AdminDashboard() {
  const [tab, setTab] = useState('overview');

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [overviewRes, usersRes, disputesRes, fraudRes] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
      ]);
      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function resolveDispute(id, status) {
    try {
      await api.patch(`/disputes/${id}/resolve`, { status, resolution: `Marked ${status} by admin` });
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not resolve dispute');
    }
  }

  async function setVerification(userId, verificationStatus) {
    try {
      await api.patch(`/admin/users/${userId}/verify`, { verificationStatus });
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update verification status');
    }
  }

  if (loading && !overview) {
    return <main className="section"><div className="container-wide loading">{error || 'Loading admin dashboard…'}</div></main>;
  }

  const cards = overview ? [
    ['Users', overview.users],
    ['Listings', overview.listings],
    ['Orders', overview.orders],
    ['Open disputes', overview.openDisputes],
    ['Active ads', overview.activeAds],
    ['Paid volume', `${Number(overview.totalPaidVolume || 0).toLocaleString()} ETB`],
  ] : [];

  const openDisputes = disputes.filter((d) => d.status === 'OPEN');
  const resolvedDisputes = disputes.filter((d) => d.status !== 'OPEN');

  return (
    <main className="section">
      <div className="container-wide">
        <div className="page-header">
          <div>
            <span className="eyebrow">ADMINISTRATION</span>
            <h1>Marketplace control center.</h1>
            <p>Verification, disputes, and fraud monitoring — with listings, transport, payments, commissions and advertising oversight coming as those backend endpoints are built out.</p>
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}

        <div className="dashboard-grid">
          {cards.map(([l, n]) => (
            <div className="stat-card" key={l}><strong>{n}</strong><span>{l}</span></div>
          ))}
        </div>

        <div className="sd-tabs" style={{ margin: '20px 0' }}>
          <button type="button" className={`sd-tab ${tab === 'overview' ? 'sd-active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
          <button type="button" className={`sd-tab ${tab === 'users' ? 'sd-active' : ''}`} onClick={() => setTab('users')}>Users & Verification</button>
          <button type="button" className={`sd-tab ${tab === 'disputes' ? 'sd-active' : ''}`} onClick={() => setTab('disputes')}>
            Disputes {openDisputes.length > 0 && `(${openDisputes.length})`}
          </button>
          <button type="button" className={`sd-tab ${tab === 'fraud' ? 'sd-active' : ''}`} onClick={() => setTab('fraud')}>
            Fraud Monitoring {suspiciousUsers.length > 0 && `(${suspiciousUsers.length})`}
          </button>
        </div>

        {tab === 'overview' && (
          <div className="admin-grid">
            <div className="card">
              <h2>Modules status</h2>
              {[
                ['Users & role verification', true],
                ['Sellers / buyers / inspectors / truck owners', true],
                ['Disputes & reports', true],
                ['Fraud flags (heuristic)', true],
                ['Listings & categories moderation', false],
                ['Orders & payments oversight', false],
                ['Transport jobs oversight', false],
                ['Advertising & sponsored listings approval', false],
                ['Commissions & revenue records', false],
              ].map(([label, built]) => (
                <div className="tool-row" key={label}>
                  {built ? '✓' : '○'} {label} {!built && <span className="muted">(backend not built yet)</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="card">
            <h2>All users</h2>
            <p className="muted">Set verification status for sellers, buyers, inspectors and truck owners.</p>
            <div className="sd-table-wrap">
              <table className="sd-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Roles</th><th>Rating</th><th>Verification</th></tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td>{u.email}</td>
                      <td>{(u.roles || []).join(', ')}</td>
                      <td>{Number(u.rating || 0).toFixed(1)}</td>
                      <td>
                        <select
                          value={u.verificationStatus}
                          onChange={(e) => setVerification(u.id, e.target.value)}
                        >
                          {VERIFICATION_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && <tr><td colSpan="5">No users found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'disputes' && (
          <div className="admin-grid">
            <div className="card">
              <h2>Open disputes</h2>
              {openDisputes.map((x) => (
                <div className="dispute" key={x.id}>
                  <strong>{x.disputeType}</strong>
                  <p>{x.raisedBy?.name} vs {x.against?.name}</p>
                  <p>{x.description}</p>
                  <div className="row-actions">
                    <button className="btn btn-primary" onClick={() => resolveDispute(x.id, 'RESOLVED')}>Resolve</button>
                    <button className="btn btn-light" onClick={() => resolveDispute(x.id, 'REJECTED')}>Reject</button>
                  </div>
                </div>
              ))}
              {openDisputes.length === 0 && <p className="muted">No open disputes.</p>}
            </div>

            <div className="card">
              <h2>Recently resolved</h2>
              {resolvedDisputes.slice(0, 10).map((x) => (
                <div className="dispute" key={x.id}>
                  <strong>{x.disputeType}</strong>
                  <p className="muted">{x.raisedBy?.name} vs {x.against?.name} — <span className="sd-badge">{x.status}</span></p>
                </div>
              ))}
              {resolvedDisputes.length === 0 && <p className="muted">Nothing resolved yet.</p>}
            </div>
          </div>
        )}

        {tab === 'fraud' && (
          <div className="card">
            <h2>Flagged users</h2>
            <p className="muted">Users with multiple open disputes filed against them. This is a starting heuristic — not a conclusive fraud finding.</p>
            {suspiciousUsers.map((u) => (
              <div className="dispute" key={u.id}>
                <strong>{u.name}</strong>
                <p className="muted">{u.email} · {(u.disputesAgainst || []).length} open dispute(s) against this account</p>
                {(u.disputesAgainst || []).map((d) => (
                  <p key={d.id} className="muted">— {d.disputeType}: {d.description}</p>
                ))}
              </div>
            ))}
            {suspiciousUsers.length === 0 && <p className="muted">No flagged users right now.</p>}
          </div>
        )}
      </div>
    </main>
  );
}
