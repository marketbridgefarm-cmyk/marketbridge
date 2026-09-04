import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];

const ROLE_OPTIONS = [
  'BUYER',
  'SELLER',
  'INSPECTOR',
  'TRUCK_OWNER',
  'ADVERTISER',
  'ADMIN',
];

const ACCOUNT_STATUS_OPTIONS = ['ACTIVE', 'SUSPENDED'];

export default function AdminDashboard() {
  const [tab, setTab] = useState('overview');

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);
  const [ads, setAds] = useState([]);

  const [userSearch, setUserSearch] = useState('');
  const [roleSelections, setRoleSelections] = useState({});

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [
        overviewRes,
        usersRes,
        disputesRes,
        fraudRes,
        adsRes,
      ] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
        api.get('/ads'),
      ]);

      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
      setAds(adsRes.data?.ads || []);
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not load admin data'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  async function resolveDispute(id, status) {
    clearMessages();
    setActionLoading(`dispute-${id}`);

    try {
      await api.patch(`/disputes/${id}/resolve`, {
        status,
        resolution: `Marked ${status} by admin`,
      });

      setSuccess(`Dispute ${status.toLowerCase()} successfully.`);
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not resolve dispute'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setVerification(userId, verificationStatus) {
    clearMessages();
    setActionLoading(`verify-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/verify`,
        { verificationStatus }
      );

      setSuccess('Verification status updated successfully.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not update verification status'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setAccountStatus(userId, accountStatus) {
    clearMessages();

    const user = users.find((item) => item.id === userId);

    if (!user) return;

    const action =
      accountStatus === 'SUSPENDED'
        ? 'suspend'
        : 'activate';

    const confirmed = window.confirm(
      `Are you sure you want to ${action} ${user.name || user.email}?`
    );

    if (!confirmed) return;

    setActionLoading(`status-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/status`,
        { accountStatus }
      );

      setSuccess(
        accountStatus === 'SUSPENDED'
          ? 'User account suspended successfully.'
          : 'User account activated successfully.'
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not update account status'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function addRole(userId) {
    clearMessages();

    const role = roleSelections[userId];

    if (!role) {
      setError('Select a role first.');
      return;
    }

    setActionLoading(`add-role-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/roles/add`,
        { role }
      );

      setSuccess(`${role} role added successfully.`);

      setRoleSelections((current) => ({
        ...current,
        [userId]: '',
      }));

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not add role'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function removeRole(userId, role) {
    clearMessages();

    const user = users.find((item) => item.id === userId);

    if (!user) return;

    const confirmed = window.confirm(
      `Remove ${role} role from ${user.name || user.email}?`
    );

    if (!confirmed) return;

    setActionLoading(`remove-role-${userId}-${role}`);

    try {
      await api.patch(
        `/admin/users/${userId}/roles/remove`,
        { role }
      );

      setSuccess(`${role} role removed successfully.`);
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not remove role'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setAdStatus(adId, status) {
    clearMessages();
    setActionLoading(`ad-${adId}`);

    try {
      await api.patch(`/ads/${adId}/status`, { status });
      setSuccess(`Campaign ${status.toLowerCase()} successfully.`);
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not update campaign status'
      );
    } finally {
      setActionLoading('');
    }
  }

  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase();

    if (!search) {
      return users;
    }

    return users.filter((user) => {
      const searchableText = [
        user.name,
        user.email,
        user.phone,
        user.location,
        ...(user.roles || []),
        user.verificationStatus,
        user.accountStatus,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableText.includes(search);
    });
  }, [users, userSearch]);

  if (loading && !overview) {
    return (
      <main className="section">
        <div className="container-wide loading">
          {error || 'Loading admin dashboard…'}
        </div>
      </main>
    );
  }

  const cards = overview
    ? [
        ['Users', overview.users],
        ['Listings', overview.listings],
        ['Orders', overview.orders],
        ['Open disputes', overview.openDisputes],
        ['Active ads', overview.activeAds],
        [
          'Suspended users',
          overview.suspendedUsers || 0,
        ],
        [
          'Paid volume',
          `${Number(
            overview.totalPaidVolume || 0
          ).toLocaleString()} ETB`,
        ],
      ]
    : [];

  const openDisputes = disputes.filter(
    (d) => d.status === 'OPEN'
  );

  const resolvedDisputes = disputes.filter(
    (d) => d.status !== 'OPEN'
  );

  const pendingAds = ads.filter(
    (a) => a.status === 'PENDING'
  );

  const reviewedAds = ads.filter(
    (a) => a.status !== 'PENDING'
  );

  return (
    <main className="section">
      <div className="container-wide">

        <div className="page-header">
          <div>
            <span className="eyebrow">
              ADMINISTRATION
            </span>

            <h1>
              Marketplace control center.
            </h1>

            <p>
              Manage users, verification, account access,
              roles, disputes, and fraud monitoring.
            </p>
          </div>
        </div>

        {error && (
          <div className="alert error">
            {error}
          </div>
        )}

        {success && (
          <div className="alert">
            {success}
          </div>
        )}

        <div className="dashboard-grid">
          {cards.map(([label, value]) => (
            <div
              className="stat-card"
              key={label}
            >
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>

        <div
          className="sd-tabs"
          style={{ margin: '20px 0' }}
        >
          <button
            type="button"
            className={`sd-tab ${
              tab === 'overview'
                ? 'sd-active'
                : ''
            }`}
            onClick={() => {
              clearMessages();
              setTab('overview');
            }}
          >
            Overview
          </button>

          <button
            type="button"
            className={`sd-tab ${
              tab === 'users'
                ? 'sd-active'
                : ''
            }`}
            onClick={() => {
              clearMessages();
              setTab('users');
            }}
          >
            Users & Control
          </button>

          <button
            type="button"
            className={`sd-tab ${
              tab === 'disputes'
                ? 'sd-active'
                : ''
            }`}
            onClick={() => {
              clearMessages();
              setTab('disputes');
            }}
          >
            Disputes{' '}
            {openDisputes.length > 0 &&
              `(${openDisputes.length})`}
          </button>

          <button
            type="button"
            className={`sd-tab ${
              tab === 'fraud'
                ? 'sd-active'
                : ''
            }`}
            onClick={() => {
              clearMessages();
              setTab('fraud');
            }}
          >
            Fraud Monitoring{' '}
            {suspiciousUsers.length > 0 &&
              `(${suspiciousUsers.length})`}
          </button>

          <button
            type="button"
            className={`sd-tab ${
              tab === 'advertising'
                ? 'sd-active'
                : ''
            }`}
            onClick={() => {
              clearMessages();
              setTab('advertising');
            }}
          >
            Advertising{' '}
            {pendingAds.length > 0 &&
              `(${pendingAds.length})`}
          </button>
        </div>

        {tab === 'overview' && (
          <div className="admin-grid">
            <div className="card">
              <h2>Modules status</h2>

              {[
                [
                  'Users & role management',
                  true,
                ],
                [
                  'Verification management',
                  true,
                ],
                [
                  'Account suspension / activation',
                  true,
                ],
                [
                  'Sellers / buyers / inspectors / truck owners',
                  true,
                ],
                [
                  'Disputes & reports',
                  true,
                ],
                [
                  'Fraud flags (heuristic)',
                  true,
                ],
                [
                  'Listings & categories moderation',
                  false,
                ],
                [
                  'Orders & payments oversight',
                  false,
                ],
                [
                  'Transport jobs oversight',
                  false,
                ],
                [
                  'Advertising & sponsored listings approval',
                  true,
                ],
                [
                  'Commissions & revenue records',
                  false,
                ],
              ].map(([label, built]) => (
                <div
                  className="tool-row"
                  key={label}
                >
                  {built ? '✓' : '○'} {label}{' '}
                  {!built && (
                    <span className="muted">
                      (backend not built yet)
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="card">

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <h2>Users & account control</h2>

                <p className="muted">
                  Search users, manage verification,
                  activate or suspend accounts, and
                  manage marketplace roles.
                </p>
              </div>

              <button
                type="button"
                className="btn btn-light"
                onClick={loadAll}
                disabled={loading}
              >
                {loading
                  ? 'Refreshing…'
                  : 'Refresh'}
              </button>
            </div>

            <div
              style={{
                margin: '18px 0',
              }}
            >
              <input
                type="search"
                value={userSearch}
                onChange={(e) =>
                  setUserSearch(e.target.value)
                }
                placeholder="Search by name, email, phone, role, status..."
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid #ccc',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <p className="muted">
              Showing {filteredUsers.length} of{' '}
              {users.length} users.
            </p>

            <div className="sd-table-wrap">
              <table className="sd-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Roles</th>
                    <th>Rating</th>
                    <th>Verification</th>
                    <th>Account</th>
                    <th>Role control</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredUsers.map((user) => {
                    const isActionLoading =
                      actionLoading.includes(
                        user.id
                      );

                    return (
                      <tr key={user.id}>

                        <td>
                          <strong>
                            {user.name}
                          </strong>

                          {user.phone && (
                            <div className="muted">
                              {user.phone}
                            </div>
                          )}

                          {user.location && (
                            <div className="muted">
                              {user.location}
                            </div>
                          )}
                        </td>

                        <td>
                          {user.email}
                        </td>

                        <td>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '5px',
                            }}
                          >
                            {(user.roles || []).map(
                              (role) => (
                                <span
                                  className="sd-badge"
                                  key={role}
                                >
                                  {role}
                                </span>
                              )
                            )}
                          </div>
                        </td>

                        <td>
                          {Number(
                            user.rating || 0
                          ).toFixed(1)}
                        </td>

                        <td>
                          <select
                            value={
                              user.verificationStatus ||
                              'UNVERIFIED'
                            }
                            onChange={(e) =>
                              setVerification(
                                user.id,
                                e.target.value
                              )
                            }
                            disabled={isActionLoading}
                          >
                            <option value="UNVERIFIED">
                              UNVERIFIED
                            </option>

                            {VERIFICATION_OPTIONS.map(
                              (option) => (
                                <option
                                  key={option}
                                  value={option}
                                >
                                  {option}
                                </option>
                              )
                            )}
                          </select>
                        </td>

                        <td>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                              minWidth: '130px',
                            }}
                          >
                            <span
                              className="sd-badge"
                            >
                              {user.accountStatus ||
                                'ACTIVE'}
                            </span>

                            {user.accountStatus ===
                            'SUSPENDED' ? (
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={
                                  isActionLoading
                                }
                                onClick={() =>
                                  setAccountStatus(
                                    user.id,
                                    'ACTIVE'
                                  )
                                }
                              >
                                {isActionLoading
                                  ? 'Working…'
                                  : 'Activate'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-light"
                                disabled={
                                  isActionLoading
                                }
                                onClick={() =>
                                  setAccountStatus(
                                    user.id,
                                    'SUSPENDED'
                                  )
                                }
                              >
                                {isActionLoading
                                  ? 'Working…'
                                  : 'Suspend'}
                              </button>
                            )}
                          </div>
                        </td>

                        <td>
                          <div
                            style={{
                              minWidth: '180px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <select
                              value={
                                roleSelections[
                                  user.id
                                ] || ''
                              }
                              onChange={(e) =>
                                setRoleSelections(
                                  (current) => ({
                                    ...current,
                                    [user.id]:
                                      e.target.value,
                                  })
                                )
                              }
                              disabled={
                                isActionLoading
                              }
                            >
                              <option value="">
                                Select role...
                              </option>

                              {ROLE_OPTIONS.map(
                                (role) => (
                                  <option
                                    key={role}
                                    value={role}
                                  >
                                    {role}
                                  </option>
                                )
                              )}
                            </select>

                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={
                                isActionLoading ||
                                !roleSelections[
                                  user.id
                                ]
                              }
                              onClick={() =>
                                addRole(user.id)
                              }
                            >
                              Add role
                            </button>

                            {(user.roles || []).length >
                              0 && (
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '5px',
                                }}
                              >
                                {user.roles.map(
                                  (role) => (
                                    <button
                                      type="button"
                                      key={role}
                                      className="btn btn-light"
                                      disabled={
                                        isActionLoading
                                      }
                                      onClick={() =>
                                        removeRole(
                                          user.id,
                                          role
                                        )
                                      }
                                      title={`Remove ${role}`}
                                    >
                                      Remove {role}
                                    </button>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        </td>

                      </tr>
                    );
                  })}

                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan="7">
                        No users found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {tab === 'disputes' && (
          <div className="admin-grid">

            <div className="card">
              <h2>Open disputes</h2>

              {openDisputes.map((item) => (
                <div
                  className="dispute"
                  key={item.id}
                >
                  <strong>
                    {item.disputeType}
                  </strong>

                  <p>
                    {item.raisedBy?.name} vs{' '}
                    {item.against?.name}
                  </p>

                  <p>
                    {item.description}
                  </p>

                  <div className="row-actions">

                    <button
                      className="btn btn-primary"
                      disabled={
                        actionLoading ===
                        `dispute-${item.id}`
                      }
                      onClick={() =>
                        resolveDispute(
                          item.id,
                          'RESOLVED'
                        )
                      }
                    >
                      {actionLoading ===
                      `dispute-${item.id}`
                        ? 'Working…'
                        : 'Resolve'}
                    </button>

                    <button
                      className="btn btn-light"
                      disabled={
                        actionLoading ===
                        `dispute-${item.id}`
                      }
                      onClick={() =>
                        resolveDispute(
                          item.id,
                          'REJECTED'
                        )
                      }
                    >
                      Reject
                    </button>

                  </div>
                </div>
              ))}

              {openDisputes.length === 0 && (
                <p className="muted">
                  No open disputes.
                </p>
              )}
            </div>

            <div className="card">
              <h2>Recently resolved</h2>

              {resolvedDisputes
                .slice(0, 10)
                .map((item) => (
                  <div
                    className="dispute"
                    key={item.id}
                  >
                    <strong>
                      {item.disputeType}
                    </strong>

                    <p className="muted">
                      {item.raisedBy?.name} vs{' '}
                      {item.against?.name} —{' '}
                      <span className="sd-badge">
                        {item.status}
                      </span>
                    </p>
                  </div>
                ))}

              {resolvedDisputes.length === 0 && (
                <p className="muted">
                  Nothing resolved yet.
                </p>
              )}
            </div>

          </div>
        )}

        {tab === 'fraud' && (
          <div className="card">

            <h2>Flagged users</h2>

            <p className="muted">
              Users with multiple open disputes
              filed against them. This is a
              starting heuristic — not a conclusive
              fraud finding.
            </p>

            {suspiciousUsers.map((user) => (
              <div
                className="dispute"
                key={user.id}
              >
                <strong>
                  {user.name}
                </strong>

                <p className="muted">
                  {user.email} ·{' '}
                  {(user.disputesAgainst || [])
                    .length}{' '}
                  open dispute(s) against this
                  account
                </p>

                {(user.disputesAgainst || []).map(
                  (dispute) => (
                    <p
                      key={dispute.id}
                      className="muted"
                    >
                      — {dispute.disputeType}:{' '}
                      {dispute.description}
                    </p>
                  )
                )}
              </div>
            ))}

            {suspiciousUsers.length === 0 && (
              <p className="muted">
                No flagged users right now.
              </p>
            )}

          </div>
        )}

        {tab === 'advertising' && (
          <div className="admin-grid">

            <div className="card">
              <h2>Pending review</h2>

              {pendingAds.map((ad) => (
                <div className="dispute" key={ad.id}>
                  <strong>{ad.type.replace(/_/g, ' ')}</strong>

                  <p className="muted">
                    {ad.advertiser?.name} ({ad.advertiser?.email})
                    {ad.listing && <> — featuring "{ad.listing.title || ad.listing.cropType}"</>}
                  </p>

                  <p className="muted">
                    {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                    {' · '}
                    {ad.amountPaid != null
                      ? `${Number(ad.amountPaid).toLocaleString()} ETB paid`
                      : 'No payment recorded yet'}
                  </p>

                  <div className="row-actions">
                    <button
                      className="btn btn-primary"
                      disabled={
                        actionLoading === `ad-${ad.id}` ||
                        ad.amountPaid == null
                      }
                      title={ad.amountPaid == null ? 'Waiting on advertiser payment before approval' : undefined}
                      onClick={() => setAdStatus(ad.id, 'ACTIVE')}
                    >
                      {actionLoading === `ad-${ad.id}` ? 'Working…' : 'Approve'}
                    </button>

                    <button
                      className="btn btn-light"
                      disabled={actionLoading === `ad-${ad.id}`}
                      onClick={() => setAdStatus(ad.id, 'REJECTED')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

              {pendingAds.length === 0 && (
                <p className="muted">No campaigns waiting on review.</p>
              )}
            </div>

            <div className="card">
              <h2>Reviewed campaigns</h2>

              {reviewedAds.slice(0, 15).map((ad) => (
                <div className="dispute" key={ad.id}>
                  <strong>{ad.type.replace(/_/g, ' ')}</strong>

                  <p className="muted">
                    {ad.advertiser?.name} —{' '}
                    <span className="sd-badge">{ad.status}</span>
                  </p>

                  {ad.status === 'ACTIVE' && (
                    <button
                      className="btn btn-light"
                      disabled={actionLoading === `ad-${ad.id}`}
                      onClick={() => setAdStatus(ad.id, 'EXPIRED')}
                    >
                      {actionLoading === `ad-${ad.id}` ? 'Working…' : 'End campaign early'}
                    </button>
                  )}
                </div>
              ))}

              {reviewedAds.length === 0 && (
                <p className="muted">Nothing reviewed yet.</p>
              )}
            </div>

          </div>
        )}

      </div>
    </main>
  );
}
