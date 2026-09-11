import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import { useAuth } from '../context/AuthContext.jsx';

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
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const performanceModalRef = useRef(null);
  const tabsNavRef = useRef(null);

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);
  const [ads, setAds] = useState([]);
  const [payments, setPayments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [commissionSummary, setCommissionSummary] = useState(null);

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
        paymentsRes,
        commissionRes,
        ordersRes,
      ] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
        api.get('/ads'),
        api.get('/payments', { params: { status: 'PENDING' } }),
        api.get('/payments/commissions/summary'),
        api.get('/orders'),
      ]);

      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
      setAds(adsRes.data?.ads || []);
      setPayments(paymentsRes.data?.payments || []);
      setCommissionSummary(commissionRes.data);
      setOrders(ordersRes.data?.orders || []);
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

  useEffect(() => {
    if (!tabMenuOpen) return undefined;

    function handleOutsideClick(event) {
      if (
        tabsNavRef.current &&
        !tabsNavRef.current.contains(event.target)
      ) {
        setTabMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [tabMenuOpen]);

  function statusBadgeClass(status) {
    if (['VERIFIED', 'ACTIVE', 'RESOLVED'].includes(status)) return 'sd-badge sd-good';
    if (['REJECTED', 'SUSPENDED'].includes(status)) return 'sd-badge sd-red';
    if (['PENDING', 'EXPIRED'].includes(status)) return 'sd-badge sd-warn';
    return 'sd-badge';
  }

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

  async function cancelOrder(order) {
    clearMessages();

    const confirmed = window.confirm(
      `Cancel order ${order.id.slice(0, 8)}? This cannot be undone. The listing becomes available again and any completed payments are flagged for refund.`
    );
    if (!confirmed) return;

    setActionLoading(`order-${order.id}`);

    try {
      await api.patch(`/orders/${order.id}/cancel`, {
        reason: 'Cancelled by admin',
      });

      setSuccess('Order cancelled.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not cancel order'
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

  async function confirmPayment(paymentId) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);

    try {
      await api.patch(`/payments/${paymentId}/confirm`);
      setSuccess('Payment confirmed and reconciled.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not confirm payment'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function checkGatewayPayment(paymentId, provider) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);

    try {
      const r = await api.get(`/payments/${paymentId}/${provider}/verify`);
      setSuccess(
        r.data?.status === 'PAID'
          ? 'Payment confirmed by the gateway and reconciled.'
          : `Gateway reports this payment as ${r.data?.status || 'not yet completed'} — nothing to reconcile yet.`
      );
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not check payment with the gateway'
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
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">ADMINISTRATION</span>
          <h1>Loading the control center...</h1>
          <p className="sd-muted">{error || 'Loading admin dashboard…'}</p>
        </section>
      </div>
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

  const tabItems = [
    { key: 'overview', label: 'Overview', count: 0 },
    { key: 'users', label: 'Users & Control', count: 0 },
    { key: 'disputes', label: 'Disputes', count: openDisputes.length },
    { key: 'fraud', label: 'Fraud Monitoring', count: suspiciousUsers.length },
    { key: 'advertising', label: 'Advertising', count: pendingAds.length },
    { key: 'orders', label: 'Orders', count: orders.length },
    { key: 'payments', label: 'Payments', count: payments.length },
  ];

  const activeTabItem =
    tabItems.find((item) => item.key === tab) || tabItems[0];

  return (
    <div className="sd-dashboard">

      <section>
        <DashboardWelcome user={user} subtitle="Manage users, verification, account access, roles, disputes, and fraud monitoring." />
        <span className="sd-eyebrow">ADMINISTRATION</span>
        <h1>Marketplace control center.</h1>
        <p className="sd-muted" style={{ maxWidth: 780 }}>
          Manage users, verification, account access, roles,
          disputes, and fraud monitoring.
        </p>

        <RoleSwitchCTA current="ADMIN" />

        <div className="sd-actions" style={{ marginTop: 28 }}>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={() => performanceModalRef.current?.showModal()}
          >
            Performance
          </button>
        </div>
      </section>

      <dialog ref={performanceModalRef} className="sd-dialog">
        <div className="sd-modal">
          <button
            className="sd-close"
            onClick={() => performanceModalRef.current?.close()}
          >
            ×
          </button>
          <span className="sd-eyebrow">SNAPSHOT</span>
          <h2>Marketplace performance</h2>

          <div className="sd-stat-grid" style={{ marginTop: 16 }}>
            {cards.map(([label, value]) => (
              <div className="sd-stat" key={label}>
                <span>{label.toUpperCase()}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </div>
      </dialog>

      {error && (
        <section>
          <div className="alert error">{error}</div>
        </section>
      )}

      {success && (
        <section>
          <div className="alert success">{success}</div>
        </section>
      )}

      <section>
        <div
          className={`sd-tabs-nav ${tabMenuOpen ? 'sd-tabs-open' : ''}`}
          ref={tabsNavRef}
        >
          <button
            type="button"
            className="sd-tabs-current"
            aria-expanded={tabMenuOpen}
            onClick={() => setTabMenuOpen((open) => !open)}
          >
            <span>
              {activeTabItem.label}
              {activeTabItem.count > 0 && ` (${activeTabItem.count})`}
            </span>
            <svg
              className="sd-tabs-chevron"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <div className="sd-tabs-list">
            {tabItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`sd-tab ${tab === item.key ? 'sd-active' : ''}`}
                onClick={() => {
                  clearMessages();
                  setTab(item.key);
                  setTabMenuOpen(false);
                }}
              >
                {item.label}
                {item.count > 0 && ` (${item.count})`}
              </button>
            ))}
          </div>
        </div>

        {tab === 'overview' && (
          <div>
            <div className="sd-panel">
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
                  true,
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
                  true,
                ],
              ].map(([label, built]) => (
                <div
                  className="tool-row"
                  key={label}
                >
                  {built ? '✓' : '○'} {label}{' '}
                  {!built && (
                    <span className="sd-muted">
                      (backend not built yet)
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="sd-panel">

            <div className="sd-toolbar">
              <div>
                <h2>Users & account control</h2>

                <p className="sd-muted">
                  Search users, manage verification,
                  activate or suspend accounts, and
                  manage marketplace roles.
                </p>
              </div>

              <button
                type="button"
                className="sd-btn sd-btn-outline"
                onClick={loadAll}
                disabled={loading}
              >
                {loading
                  ? 'Refreshing…'
                  : 'Refresh'}
              </button>
            </div>

            <div style={{ margin: '18px 0' }}>
              <input
                type="search"
                value={userSearch}
                onChange={(e) =>
                  setUserSearch(e.target.value)
                }
                placeholder="Search by name, email, phone, role, status..."
              />
            </div>

            <p className="sd-muted">
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
                            <div className="sd-muted">
                              {user.phone}
                            </div>
                          )}

                          {user.location && (
                            <div className="sd-muted">
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
                              className={statusBadgeClass(
                                user.accountStatus || 'ACTIVE'
                              )}
                            >
                              {user.accountStatus ||
                                'ACTIVE'}
                            </span>

                            {user.accountStatus ===
                            'SUSPENDED' ? (
                              <button
                                type="button"
                                className="sd-btn sd-btn-primary"
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
                                className="sd-btn sd-btn-outline"
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
                              className="sd-btn sd-btn-primary"
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
                                      className="sd-btn sd-btn-outline"
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
          <div>

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">MODERATION</span>
                <h2>Open disputes</h2>
              </div>
            </div>

            <div className="sd-cards">
              {openDisputes.map((item) => (
                <div className="sd-card" key={item.id}>
                  <h3>{item.disputeType}</h3>

                  <p className="sd-muted">
                    {item.raisedBy?.name} vs{' '}
                    {item.against?.name}
                  </p>

                  <p className="sd-muted">
                    {item.description}
                  </p>

                  <div className="sd-modal-actions" style={{ marginTop: 12 }}>

                    <button
                      className="sd-btn sd-btn-primary"
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
                      className="sd-btn sd-btn-outline"
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
                <div className="sd-panel">
                  <p className="sd-muted">No open disputes.</p>
                </div>
              )}
            </div>

            <div className="sd-toolbar" style={{ marginTop: 28 }}>
              <div>
                <span className="sd-eyebrow">HISTORY</span>
                <h2>Recently resolved</h2>
              </div>
            </div>

            <div className="sd-panel sd-table-wrap">
              <table className="sd-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Parties</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {resolvedDisputes.slice(0, 10).map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.disputeType}</strong></td>
                      <td className="sd-muted">
                        {item.raisedBy?.name} vs {item.against?.name}
                      </td>
                      <td>
                        <span className={statusBadgeClass(item.status)}>{item.status}</span>
                      </td>
                    </tr>
                  ))}

                  {resolvedDisputes.length === 0 && (
                    <tr>
                      <td colSpan="3" className="sd-muted">Nothing resolved yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {tab === 'fraud' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">RISK</span>
                <h2>Flagged users</h2>
                <p className="sd-muted">
                  Users with multiple open disputes filed against
                  them. This is a starting heuristic — not a
                  conclusive fraud finding.
                </p>
              </div>
            </div>

            <div className="sd-cards">
              {suspiciousUsers.map((user) => (
                <div className="sd-card" key={user.id}>
                  <h3>{user.name}</h3>

                  <p className="sd-muted">
                    {user.email} ·{' '}
                    {(user.disputesAgainst || []).length}{' '}
                    open dispute(s) against this account
                  </p>

                  {(user.disputesAgainst || []).map((dispute) => (
                    <p key={dispute.id} className="sd-muted">
                      — {dispute.disputeType}: {dispute.description}
                    </p>
                  ))}
                </div>
              ))}

              {suspiciousUsers.length === 0 && (
                <div className="sd-panel">
                  <p className="sd-muted">No flagged users right now.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'advertising' && (
          <div className="sd-workspace">

            <div>
              <span className="sd-eyebrow">PENDING</span>
              <h2>Pending review</h2>

              <div className="sd-cards">
              {pendingAds.map((ad) => (
                <div className="sd-card" key={ad.id}>
                  <h3>{ad.type.replace(/_/g, ' ')}</h3>

                  <p className="sd-muted">
                    {ad.advertiser?.name} ({ad.advertiser?.email})
                    {ad.listing && <> — featuring "{ad.listing.title || ad.listing.cropType}"</>}
                  </p>

                  <p className="sd-muted">
                    {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                    {' · '}
                    {ad.amountPaid != null
                      ? `${Number(ad.amountPaid).toLocaleString()} ETB paid`
                      : 'No payment recorded yet'}
                  </p>

                  <div className="sd-modal-actions">
                    <button
                      className="sd-btn sd-btn-primary"
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
                      className="sd-btn sd-btn-outline"
                      disabled={actionLoading === `ad-${ad.id}`}
                      onClick={() => setAdStatus(ad.id, 'REJECTED')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

              {pendingAds.length === 0 && (
                <div className="sd-panel">
                  <p className="sd-muted">No campaigns waiting on review.</p>
                </div>
              )}
              </div>
            </div>

            <div className="sd-panel sd-table-wrap">
              <h2>Reviewed campaigns</h2>

              <table className="sd-table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Advertiser</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reviewedAds.slice(0, 15).map((ad) => (
                    <tr key={ad.id}>
                      <td><strong>{ad.type.replace(/_/g, ' ')}</strong></td>
                      <td className="sd-muted">{ad.advertiser?.name}</td>
                      <td><span className={statusBadgeClass(ad.status)}>{ad.status}</span></td>
                      <td>
                        {ad.status === 'ACTIVE' && (
                          <button
                            className="sd-btn sd-btn-outline"
                            disabled={actionLoading === `ad-${ad.id}`}
                            onClick={() => setAdStatus(ad.id, 'EXPIRED')}
                          >
                            {actionLoading === `ad-${ad.id}` ? 'Working…' : 'End early'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}

                  {reviewedAds.length === 0 && (
                    <tr>
                      <td colSpan="4" className="sd-muted">Nothing reviewed yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {tab === 'orders' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">ORDERS</span>
                <h2>All orders</h2>
                <p className="sd-muted">
                  Cancelling here is an admin override for stalled orders —
                  it's blocked once a transport job has started pickup,
                  since goods already in motion need a dispute instead.
                </p>
              </div>
            </div>

            <div className="sd-panel sd-table-wrap">
              <table className="sd-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Listing</th>
                    <th>Buyer</th>
                    <th>Seller</th>
                    <th>Value</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const transportInMotion = Boolean(
                      o.transportJob &&
                      ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(o.transportJob.status)
                    );
                    const cancellable =
                      !['COMPLETED', 'CANCELLED'].includes(o.status) &&
                      !transportInMotion;

                    return (
                      <tr key={o.id}>
                        <td>{o.id.slice(0, 8)}</td>
                        <td>{o.listing?.title || o.listing?.cropType || '—'}</td>
                        <td>{o.buyer?.name || '—'}</td>
                        <td>{o.seller?.name || '—'}</td>
                        <td>{Number(o.finalPrice).toLocaleString()} ETB</td>
                        <td><span className={statusBadgeClass(o.status)}>{o.status}</span></td>
                        <td>
                          {cancellable && (
                            <button
                              type="button"
                              className="sd-btn sd-btn-outline"
                              disabled={actionLoading === `order-${o.id}`}
                              onClick={() => cancelOrder(o)}
                            >
                              {actionLoading === `order-${o.id}` ? 'Cancelling…' : 'Cancel order'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {orders.length === 0 && (
                    <tr><td colSpan="7">No orders yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'payments' && (
          <div>
            <div className="sd-stat-grid" style={{ marginBottom: 20 }}>
              <div className="sd-stat">
                <span>TOTAL CONFIRMED VOLUME</span>
                <b>{Number(commissionSummary?.totalVolume || 0).toLocaleString()} ETB</b>
              </div>
              <div className="sd-stat">
                <span>PLATFORM COMMISSION EARNED</span>
                <b>{Number(commissionSummary?.totalCommission || 0).toLocaleString()} ETB</b>
              </div>
              {Object.entries(commissionSummary?.byType || {}).map(([type, t]) => (
                <div className="sd-stat" key={type}>
                  <span>{type} ({t.count} payment{t.count === 1 ? '' : 's'})</span>
                  <b>{Number(t.commission).toLocaleString()} ETB</b>
                </div>
              ))}
            </div>

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">RECONCILIATION</span>
                <h2>Pending payment reconciliation</h2>
                <p className="sd-muted">
                  These are payment records waiting to be confirmed. Prefer a
                  signed provider webhook where available — use manual confirm
                  only once you've verified the funds arrived (e.g. checking a
                  Telebirr/CBE reference).
                </p>
              </div>
            </div>

            <div className="sd-cards">
              {payments.map((p) => (
                <div className="sd-card" key={p.id}>
                  <h3>
                    {Number(p.amount).toLocaleString()} ETB — {p.type} via {p.method}
                  </h3>

                  <p className="sd-muted">
                    {p.createdBy?.name} ({p.createdBy?.email})
                    {p.reference && <> · Ref: {p.reference}</>}
                  </p>

                  <p className="sd-muted">
                    {p.order && `Order ${p.order.id.slice(0, 8)}`}
                    {p.digitalProduct && `Digital product: ${p.digitalProduct.title}`}
                    {p.advertisement && `Ad campaign: ${p.advertisement.type.replace(/_/g, ' ')}`}
                    {' · '}
                    {new Date(p.createdAt).toLocaleString()}
                  </p>

                  {p.provider ? (
                    <button
                      className="sd-btn sd-btn-primary"
                      disabled={actionLoading === `payment-${p.id}`}
                      onClick={() => checkGatewayPayment(p.id, p.provider)}
                    >
                      {actionLoading === `payment-${p.id}` ? 'Checking…' : `Check with ${p.provider}`}
                    </button>
                  ) : (
                    <button
                      className="sd-btn sd-btn-primary"
                      disabled={actionLoading === `payment-${p.id}`}
                      onClick={() => confirmPayment(p.id)}
                    >
                      {actionLoading === `payment-${p.id}` ? 'Working…' : 'Confirm payment received'}
                    </button>
                  )}
                </div>
              ))}

              {payments.length === 0 && (
                <div className="sd-panel">
                  <p className="sd-muted">No pending payments right now.</p>
                </div>
              )}
            </div>
          </div>
        )}

      </section>
    </div>
  );
}
