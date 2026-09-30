import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/AdminDashboard.css';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];

const ROLE_OPTIONS = ['BUYER', 'SELLER', 'INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER', 'ADMIN'];

const MODULES = [
  ['Users & role management', true],
  ['Verification management', true],
  ['Account suspension / activation', true],
  ['Sellers / buyers / inspectors / truck owners', true],
  ['Disputes & reports', true],
  ['Fraud flags (heuristic)', true],
  ['Listings & categories moderation', false],
  ['Orders & payments oversight', true],
  ['Transport jobs oversight', false],
  ['Advertising & sponsored listings approval', true],
  ['Commissions & revenue records', true],
];

const fmt = (n) => Number(n || 0).toLocaleString();
const humanize = (s) => String(s || '').replace(/_/g, ' ');
const shortDate = (d) => new Date(d).toLocaleDateString();

function statusBadgeClass(status) {
  if (['VERIFIED', 'ACTIVE', 'APPROVED', 'PUBLISHED', 'SCHEDULED', 'RESOLVED', 'COMPLETED'].includes(status)) {
    return 'sd-badge sd-good';
  }
  if (['REJECTED', 'SUSPENDED', 'CANCELLED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(status)) {
    return 'sd-badge sd-red';
  }
  if (['PENDING', 'PENDING_PAYMENT', 'PAID_PENDING_REVIEW', 'EXPIRED', 'REQUESTED', 'PROCESSING'].includes(status)) {
    return 'sd-badge sd-warn';
  }
  return 'sd-badge';
}

function ShieldIcon() {
  return (
    <div className="ac-shield">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
        <path d="M9.5 12l1.7 1.7 3.5-3.7" />
      </svg>
    </div>
  );
}

/**
 * MetricSparkline
 * Renders a smooth, progressively animated area chart representing the
 * metric's value relative to a dynamic max. Each chart has its own
 * accent cadence via the `tone` prop.
 */
function MetricSparkline({ value = 0, max = 100, tone = 'primary', label = '' }) {
  const safeMax = max > 0 ? max : 1;
  const rawPercent = Math.min((Number(value) / safeMax) * 100, 100);
  const percent = Math.max(rawPercent, 5); // Ensure a visible baseline

  const width = 140;
  const height = 36;
  const baseline = height - 4;

  // Generate a smooth cubic bezier path
  const pathData = useMemo(() => {
    const startX = 0;
    const endX = width;
    const startY = baseline;
    const endY = height - (percent / 100) * (height - 4);

    const cp1x = width * 0.3;
    const cp1y = baseline;
    const cp2x = width * 0.7;
    const cp2y = endY;

    return `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
  }, [percent, baseline, height]);

  return (
    <div className={`ac-sparkline ac-sparkline-${tone}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="ac-sparkline-svg"
        role="img"
        aria-label={`${label} trend: ${fmt(value)}`}
      >
        <defs>
          <linearGradient id={`spark-fill-${tone}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path
          d={pathData}
          fill={`url(#spark-fill-${tone})`}
          stroke="none"
          className="ac-sparkline-area"
        />
        <path
          d={pathData}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="ac-sparkline-line"
        />
      </svg>
    </div>
  );
}

function Metric({ label, value, tone = '', max = 100, rawValue }) {
  const numValue = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : value;

  return (
    <div className={`ac-metric ${tone}`}>
      <div className="ac-metric-label">
        <span>{label}</span>
      </div>
      <strong className="ac-metric-value">{value}</strong>
      <div className="ac-metric-chart">
        <MetricSparkline
          value={rawValue !== undefined ? rawValue : numValue}
          max={max}
          tone={tone || 'primary'}
          label={label}
        />
      </div>
    </div>
  );
}

function Empty({ title, children }) {
  return (
    <div className="ac-empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

function Toolbar({ label, title, children, action }) {
  return (
    <div className="ac-toolbar">
      <div>
        <span className="ac-section-label">{label}</span>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

function adAnalytics(ad) {
  const events = ad.events || [];
  const impressions = events.filter((e) => e.eventType === 'IMPRESSION').length;
  const clicks = events.filter((e) => e.eventType === 'CLICK').length;
  const ctr = impressions ? ((clicks / impressions) * 100).toFixed(2) : '0.00';
  return { impressions, clicks, ctr };
}

export default function AdminDashboard() {
  useAuth();

  const [tab, setTab] = useState('overview');

  const performanceModalRef = useRef(null);
  const disputeModalRef = useRef(null);

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);
  const [ads, setAds] = useState([]);
  const [payments, setPayments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [operations, setOperations] = useState(null);
  const [orderEvents, setOrderEvents] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [installmentPlans, setInstallmentPlans] = useState([]);

  const [disputeDecision, setDisputeDecision] = useState(null);
  const [userSearch, setUserSearch] = useState('');
  const [roleSelections, setRoleSelections] = useState({});

  const [error, setError] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    setMfaRequired(false);

    try {
      const [
        overviewRes,
        usersRes,
        disputesRes,
        fraudRes,
        adsRes,
        paymentsRes,
        ordersRes,
        operationsRes,
        orderEventsRes,
        auditEventsRes,
        refundsRes,
        installmentPlansRes,
      ] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
        api.get('/ads'),
        api.get('/payments', { params: { status: ['PENDING', 'RECONCILIATION_REQUIRED'] } }),
        api.get('/orders'),
        api.get('/admin/operations/summary'),
        api.get('/admin/order-events', { params: { limit: 100 } }),
        api.get('/admin/audit-events', { params: { limit: 100 } }),
        api.get('/admin/financial/refunds'),
        api.get('/admin/financial/installment-plans').catch(() => ({ data: { plans: [] } })),
      ]);

      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
      setAds(adsRes.data?.ads || []);
      setPayments(paymentsRes.data?.payments || []);
      setOrders(ordersRes.data?.orders || []);
      setOperations(operationsRes.data || null);
      setOrderEvents(orderEventsRes.data?.events || []);
      setAuditEvents(auditEventsRes.data?.events || []);
      setRefunds(refundsRes.data?.refunds || []);
      setInstallmentPlans(installmentPlansRes.data?.plans || []);
    } catch (err) {
      if (err.response?.data?.code === 'MFA_SETUP_REQUIRED') {
        setMfaRequired(true);
      } else {
        // Log the full error for debugging
        console.error("Admin Dashboard Load Error:", err);
        setError(
          err.response?.data?.error || 
          err.message || 
          'Could not load admin data. Please check your network and API status.'
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const pending = refunds.filter((r) => r.status === 'PROCESSING');
    if (pending.length === 0) return undefined;

    let cancelled = false;

    const poll = async () => {
      for (const refund of pending) {
        try {
          await api.post(`/admin/financial/refunds/${refund.id}/verify`);
        } catch {
          // Silent background check
        }
      }
      if (cancelled) return;
      try {
        const res = await api.get('/admin/financial/refunds');
        if (!cancelled) setRefunds(res.data?.refunds || []);
      } catch {
        // Next tick retries.
      }
    };

    const interval = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refunds]);

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  async function run(key, fn, fallbackError) {
    clearMessages();
    setActionLoading(key);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || fallbackError);
      return false;
    } finally {
      setActionLoading('');
    }
  }

  function openDisputeDecision(dispute, status) {
    clearMessages();
    setDisputeDecision({
      id: dispute.id,
      status,
      resolution: `Marked ${status} by admin`,
      payoutDecision: '',
    });
    disputeModalRef.current?.showModal();
  }

  function closeDisputeDecision() {
    disputeModalRef.current?.close();
    setDisputeDecision(null);
  }

  async function submitDisputeDecision() {
    if (!disputeDecision) return;
    const { id, status, resolution, payoutDecision } = disputeDecision;

    const ok = await run(
      `dispute-${id}`,
      () =>
        api.patch(`/disputes/${id}/resolve`, {
          status,
          resolution,
          payoutDecision: payoutDecision || undefined,
        }),
      'Could not resolve dispute'
    );

    if (ok) {
      setSuccess(`Dispute ${status.toLowerCase()} successfully.`);
      closeDisputeDecision();
      await loadAll();
    }
  }

  async function processRefund(refund) {
    clearMessages();

    const confirmed = window.confirm(
      `Submit the ${fmt(refund.amount)} ${refund.currency || 'ETB'} refund for payment ${refund.paymentId.slice(0, 8)} to Chapa now? MarketBridge checks with Chapa automatically until it confirms the money was returned — no further action needed here.`
    );
    if (!confirmed) return;

    setActionLoading(`refund-${refund.id}`);
    try {
      const result =
        refund.status === 'FAILED'
          ? await api.post(`/admin/financial/refunds/${refund.id}/retry`)
          : await api.post(`/admin/financial/refunds/${refund.id}/process`);

      const finalStatus = result?.data?.refund?.status;
      setSuccess(
        finalStatus === 'COMPLETED'
          ? 'Chapa confirmed the refund immediately — it’s complete.'
          : 'Refund submitted to Chapa. It will finalize automatically — no need to check back manually.'
      );
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit refund to Chapa');
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
      await api.patch(`/orders/${order.id}/cancel`, { reason: 'Cancelled by admin' });
      setSuccess('Order cancelled.');
      await loadAll();
    } catch (err) {
      const message = err.response?.data?.error || 'Could not cancel order';
      setError(
        message === 'Failed to cancel order'
          ? `${message} This can happen right after the server has been idle — wait a few seconds and try again.`
          : message
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setVerification(userId, verificationStatus) {
    const ok = await run(
      `verify-${userId}`,
      () => api.patch(`/admin/users/${userId}/verify`, { verificationStatus }),
      'Could not update verification status'
    );
    if (ok) {
      setSuccess('Verification status updated successfully.');
      await loadAll();
    }
  }

  async function setAccountStatus(userId, accountStatus) {
    clearMessages();

    const targetUser = users.find((item) => item.id === userId);
    if (!targetUser) return;

    const action = accountStatus === 'SUSPENDED' ? 'suspend' : 'activate';
    if (!window.confirm(`Are you sure you want to ${action} ${targetUser.name || targetUser.email}?`)) return;

    const ok = await run(
      `status-${userId}`,
      () => api.patch(`/admin/users/${userId}/status`, { accountStatus }),
      'Could not update account status'
    );
    if (ok) {
      setSuccess(
        accountStatus === 'SUSPENDED'
          ? 'User account suspended successfully.'
          : 'User account activated successfully.'
      );
      await loadAll();
    }
  }

  async function addRole(userId) {
    clearMessages();

    const role = roleSelections[userId];
    if (!role) {
      setError('Select a role first.');
      return;
    }

    const ok = await run(
      `add-role-${userId}`,
      () => api.patch(`/admin/users/${userId}/roles/add`, { role }),
      'Could not add role'
    );
    if (ok) {
      setSuccess(`${role} role added successfully.`);
      setRoleSelections((current) => ({ ...current, [userId]: '' }));
      await loadAll();
    }
  }

  async function removeRole(userId, role) {
    clearMessages();

    const targetUser = users.find((item) => item.id === userId);
    if (!targetUser) return;

    if (!window.confirm(`Remove ${role} role from ${targetUser.name || targetUser.email}?`)) return;

    const ok = await run(
      `remove-role-${userId}-${role}`,
      () => api.patch(`/admin/users/${userId}/roles/remove`, { role }),
      'Could not remove role'
    );
    if (ok) {
      setSuccess(`${role} role removed successfully.`);
      await loadAll();
    }
  }

  async function markTelegramPublished(adId) {
    clearMessages();
    const postReference = window.prompt('Telegram post reference/link (optional):') || undefined;

    const ok = await run(
      `ad-${adId}`,
      () => api.patch(`/ads/${adId}/telegram-publication`, { postReference }),
      'Could not record Telegram publication'
    );
    if (ok) {
      setSuccess('Telegram publication recorded.');
      await loadAll();
    }
  }

  async function cancelAdCampaign(adId) {
    clearMessages();

    if (!window.confirm('Cancel this campaign? Any paid amount is flagged REFUNDED as a bookkeeping record.')) {
      return;
    }
    const reason = window.prompt('Reason for cancelling this campaign (optional):') || undefined;

    const ok = await run(
      `ad-${adId}`,
      () => api.patch(`/ads/${adId}/cancel`, { reason }),
      'Could not cancel campaign'
    );
    if (ok) {
      setSuccess('Campaign cancelled.');
      await loadAll();
    }
  }

  async function setAdStatus(adId, status) {
    clearMessages();

    let rejectionReason;
    if (status === 'REJECTED') {
      rejectionReason = window.prompt('Reason for rejecting this campaign (optional):') || undefined;
    }

    const ok = await run(
      `ad-${adId}`,
      () => api.patch(`/ads/${adId}/status`, { status, rejectionReason }),
      'Could not update campaign status'
    );
    if (ok) {
      setSuccess(`Campaign ${status.toLowerCase()} successfully.`);
      await loadAll();
    }
  }

  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase();
    if (!search) return users;

    return users.filter((item) =>
      [
        item.name,
        item.email,
        item.phone,
        item.location,
        ...(item.roles || []),
        item.verificationStatus,
        item.accountStatus,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search)
    );
  }, [users, userSearch]);

  const cards = overview
    ? [
        ['Users', overview.users],
        ['Listings', overview.listings],
        ['Orders', overview.orders],
        ['Open disputes', overview.openDisputes],
        ['Active ads', overview.activeAds],
        ['Suspended users', overview.suspendedUsers || 0],
        ['Paid volume', `${fmt(overview.totalPaidVolume)} ETB`],
      ]
    : [];

  const getMaxForMetric = (label) => {
    if (!overview) return 100;
    const allValues = [overview.users, overview.listings, overview.orders, overview.activeAds].filter(n => typeof n === 'number');
    const baseMax = Math.max(...allValues, 1) * 1.2;

    if (label === 'Paid volume') return overview.totalPaidVolume * 1.2 || 1000000;
    if (label === 'Open disputes') return Math.max(overview.openDisputes * 2, 5);
    if (label === 'Suspended users') return Math.max(overview.suspendedUsers * 2, 5);
    return baseMax;
  };

  const openDisputes = disputes.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');
  const resolvedDisputes = disputes.filter((d) => d.status !== 'OPEN' && d.status !== 'UNDER_REVIEW');

  const pendingAds = ads.filter(
    (a) =>
      a.status === 'PAID_PENDING_REVIEW' ||
      (a.status === 'PENDING' && ['BANNER', 'TELEGRAM_PROMOTION'].includes(a.type))
  );
  const reviewedAds = ads.filter((a) => !pendingAds.some((p) => p.id === a.id));

  const pendingRefunds = refunds.filter((r) => ['REQUESTED', 'PROCESSING'].includes(r.status));
  const openInstallmentPlans = installmentPlans.filter((p) => ['PENDING', 'PROCESSING'].includes(p.status));

  const tabItems = [
    { key: 'overview', label: 'Overview', count: 0 },
    { key: 'users', label: 'Users & Control', count: 0 },
    { key: 'disputes', label: 'Disputes', count: openDisputes.length },
    { key: 'fraud', label: 'Fraud Monitoring', count: suspiciousUsers.length },
    { key: 'advertising', label: 'Advertising', count: pendingAds.length },
    { key: 'orders', label: 'Orders', count: orders.length },
    { key: 'payments', label: 'Payments', count: payments.length },
    { key: 'refunds', label: 'Refunds', count: pendingRefunds.length },
    { key: 'installments', label: 'Installments', count: openInstallmentPlans.length },
    {
      key: 'operations',
      label: 'Operations & Audit',
      count: (operations?.queues?.reconciliationPayments || 0) + (operations?.queues?.openDisputes || 0),
    },
  ];

  if (loading && !overview && !mfaRequired) {
    return (
      <div className="sd-dashboard admin-control-center">
        <div className="ac-mfa">
          <div className="ac-mfa-icon">⌛</div>
          <span className="ac-kicker">ADMINISTRATION</span>
          <h1>Loading control center</h1>
          <p className="sd-muted">{error || 'Loading admin dashboard…'}</p>
        </div>
      </div>
    );
  }

  if (mfaRequired) {
    return (
      <div className="sd-dashboard admin-control-center">
        <div className="ac-hero">
          <div className="ac-hero-content">
            <div className="ac-title-row">
              <ShieldIcon />
              <div>
                <span className="ac-kicker">ADMINISTRATION</span>
                <h1>Secure your control center</h1>
                <p className="ac-subtitle">
                  Multi-factor authentication is required before administrative actions can continue.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="ac-mfa">
          <div className="ac-mfa-icon">🔐</div>
          <h2>Set up MFA to continue</h2>
          <p className="sd-muted">
            Admin actions on MarketBridge now require multi-factor authentication. This takes about a
            minute with an authenticator app such as Google Authenticator or Authy.
          </p>
          <div className="ac-actions" style={{ justifyContent: 'center', borderTop: 0 }}>
            <Link to="/account/security" className="sd-btn sd-btn-primary">
              Set up MFA
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sd-dashboard admin-control-center">
      <section className="ac-section">
        <div className="ac-hero">
          <div className="ac-hero-content">
            <div className="ac-brand-row">
              <div className="ac-title-row">
                <ShieldIcon />
                <div>
                  <span className="ac-kicker">MARKETBRIDGE ADMINISTRATION</span>
                  <h1>Control Center</h1>
                  <p className="ac-subtitle">
                    Manage marketplace users, verification, disputes, payments, advertising, refunds,
                    orders, fraud signals, and operational workflows from one place.
                  </p>
                </div>
              </div>

              <div className="ac-cc-pill">
                <span className="ac-cc-dot" />
                ADMIN ACCESS
              </div>
            </div>

            <div className="ac-hero-actions">
              <RoleSwitchCTA current="ADMIN" />

              <button
                type="button"
                className="sd-btn sd-btn-primary"
                onClick={() => performanceModalRef.current?.showModal()}
              >
                Performance snapshot
              </button>

              <Link to="/account/security" className="sd-btn">
                Account security
              </Link>
            </div>
          </div>
        </div>

        <div className="ac-metrics">
          {cards.map(([label, value]) => {
            let tone = '';
            if (label === 'Open disputes') tone = 'warn';
            if (label === 'Suspended users') tone = 'danger';
            
            const max = getMaxForMetric(label);
            let rawValue = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : value;

            return (
              <Metric
                key={label}
                label={label}
                value={value}
                tone={tone}
                max={max}
                rawValue={rawValue}
              />
            );
          })}
        </div>
      </section>

      <dialog ref={performanceModalRef} className="ac-dialog">
        <div className="ac-modal">
          <button
            type="button"
            className="ac-close"
            aria-label="Close"
            onClick={() => performanceModalRef.current?.close()}
          >
            ×
          </button>

          <span className="ac-section-label">MARKETPLACE SNAPSHOT</span>
          <h2>Marketplace performance</h2>

          <div className="ac-metrics" style={{ marginTop: 18 }}>
            {cards.map(([label, value]) => (
              <Metric key={label} label={label} value={value} />
            ))}
          </div>
        </div>
      </dialog>

      <dialog ref={disputeModalRef} className="ac-dialog" onClose={() => setDisputeDecision(null)}>
        <div className="ac-modal">
          <button type="button" className="ac-close" onClick={closeDisputeDecision} aria-label="Close">
            ×
          </button>

          <span className="ac-section-label">MODERATION</span>
          <h2>{disputeDecision?.status === 'REJECTED' ? 'Reject dispute' : 'Resolve dispute'}</h2>

          {disputeDecision && (
            <>
              <p className="sd-muted">
                The dispute freezes the entire order while it is open — payments, transport, inspection
                and payouts cannot proceed. Choose the economic outcome below.
              </p>

              <div className="sd-form-grid" style={{ marginTop: 15 }}>
                <div className="sd-full">
                  <label>Resolution notes</label>
                  <textarea
                    rows={3}
                    value={disputeDecision.resolution}
                    onChange={(e) => setDisputeDecision((d) => ({ ...d, resolution: e.target.value }))}
                  />
                </div>

                <div className="sd-full">
                  <label>Payout decision</label>

                  <label className="ac-radio-option">
                    <input
                      type="radio"
                      name="payoutDecision"
                      value="RELEASE"
                      checked={disputeDecision.payoutDecision === 'RELEASE'}
                      onChange={() => setDisputeDecision((d) => ({ ...d, payoutDecision: 'RELEASE' }))}
                    />
                    <span>
                      <strong>Release & resume order</strong> — restores the order to its pre-dispute
                      state and restarts the normal payout hold. No buyer refund is created.
                    </span>
                  </label>

                  <label className="ac-radio-option">
                    <input
                      type="radio"
                      name="payoutDecision"
                      value="CANCEL"
                      checked={disputeDecision.payoutDecision === 'CANCEL'}
                      onChange={() => setDisputeDecision((d) => ({ ...d, payoutDecision: 'CANCEL' }))}
                    />
                    <span>
                      <strong>Cancel order & refund buyer</strong> — cancels the order, stops its
                      remaining inspection/transport proceedings, cancels unpaid payouts and creates
                      refund requests for payments already received.
                    </span>
                  </label>

                  <p className="sd-muted" style={{ marginTop: 8 }}>
                    The decision applies to the whole disputed order. Inspector, seller and transporter
                    payouts are handled together so a refund cannot coexist with a still-active order.
                  </p>
                </div>
              </div>

              <div className="ac-modal-actions">
                <button
                  type="button"
                  className="sd-btn sd-btn-primary"
                  disabled={!disputeDecision.payoutDecision || actionLoading === `dispute-${disputeDecision.id}`}
                  onClick={submitDisputeDecision}
                >
                  {actionLoading === `dispute-${disputeDecision.id}` ? 'Working…' : 'Confirm'}
                </button>

                <button type="button" className="sd-btn sd-btn-outline" onClick={closeDisputeDecision}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>

      {error && (
        <section className="ac-section">
          <div className="ac-alert error">
            <span className="ac-alert-icon">!</span>
            <span>{error}</span>
          </div>
        </section>
      )}

      {success && (
        <section className="ac-section">
          <div className="ac-alert success">
            <span className="ac-alert-icon">✓</span>
            <span>{success}</span>
          </div>
        </section>
      )}

      <section className="ac-section">
        <div className="ac-tabs-shell">
          <div className="ac-tabs" role="tablist" aria-label="Admin sections">
            {tabItems.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={`ac-tab ${tab === item.key ? 'active' : ''}`}
                onClick={() => {
                  clearMessages();
                  setTab(item.key);
                }}
              >
                {item.label}
                {item.count > 0 && <span className="ac-tab-count">{item.count}</span>}
              </button>
            ))}
          </div>
        </div>

        {tab === 'overview' && (
          <div className="ac-panel">
            <div className="ac-panel-header">
              <div>
                <span className="ac-section-label">SYSTEM OVERVIEW</span>
                <h2>Marketplace modules</h2>
                <p>
                  Current administrative capabilities and implementation status across the MarketBridge
                  platform.
                </p>
              </div>
            </div>

            <div className="ac-module-list">
              {MODULES.map(([label, built]) => (
                <div className={`ac-module ${built ? '' : 'off'}`} key={label}>
                  <span className="ac-module-icon">{built ? '✓' : '○'}</span>
                  <span>
                    {label} {!built && <small>(backend not built yet)</small>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="ac-panel">
            <Toolbar
              label="ACCESS MANAGEMENT"
              title="Users & account control"
              action={
                <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
              }
            >
              Search users, manage verification, activate or suspend accounts, and manage marketplace
              roles.
            </Toolbar>

            <div className="ac-search">
              <input
                type="search"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search by name, email, phone, role, status..."
              />
            </div>

            <p className="sd-muted">
              Showing <strong>{filteredUsers.length}</strong> of {users.length} users.
            </p>

            <div className="ac-table-shell">
              <table className="sd-table sd-table--stack">
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
                  {filteredUsers.map((item) => {
                    const busy = actionLoading.includes(item.id);
                    const suspended = item.accountStatus === 'SUSPENDED';

                    return (
                      <tr key={item.id}>
                        <td data-label="Name">
                          <strong>{item.name}</strong>
                          {item.phone && <div className="sd-muted">{item.phone}</div>}
                          {item.location && <div className="sd-muted">{item.location}</div>}
                        </td>

                        <td data-label="Email">{item.email}</td>

                        <td data-label="Roles">
                          <div className="sd-chip-row">
                            {(item.roles || []).map((role) => (
                              <span className="sd-badge" key={role}>
                                {role}
                              </span>
                            ))}
                          </div>
                        </td>

                        <td data-label="Rating">{Number(item.rating || 0).toFixed(1)}</td>

                        <td data-label="Verification">
                          <select
                            value={item.verificationStatus || 'UNVERIFIED'}
                            onChange={(e) => setVerification(item.id, e.target.value)}
                            disabled={busy}
                          >
                            <option value="UNVERIFIED">UNVERIFIED</option>
                            {VERIFICATION_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td data-label="Account">
                          <div className="sd-account-cell">
                            <span className={statusBadgeClass(item.accountStatus || 'ACTIVE')}>
                              {item.accountStatus || 'ACTIVE'}
                            </span>

                            <button
                              type="button"
                              className={`sd-btn ${suspended ? 'sd-btn-primary' : 'sd-btn-outline'}`}
                              disabled={busy}
                              onClick={() => setAccountStatus(item.id, suspended ? 'ACTIVE' : 'SUSPENDED')}
                            >
                              {busy ? 'Working…' : suspended ? 'Activate' : 'Suspend'}
                            </button>
                          </div>
                        </td>

                        <td data-label="Role control">
                          <div className="ac-role-actions">
                            <select
                              value={roleSelections[item.id] || ''}
                              onChange={(e) =>
                                setRoleSelections((current) => ({ ...current, [item.id]: e.target.value }))
                              }
                              disabled={busy}
                            >
                              <option value="">Select role...</option>
                              {ROLE_OPTIONS.map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>

                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              disabled={busy || !roleSelections[item.id]}
                              onClick={() => addRole(item.id)}
                            >
                              Add role
                            </button>

                            {(item.roles || []).length > 0 && (
                              <div className="sd-chip-row">
                                {item.roles.map((role) => (
                                  <button
                                    type="button"
                                    key={role}
                                    className="sd-btn sd-btn-outline"
                                    disabled={busy}
                                    onClick={() => removeRole(item.id, role)}
                                    title={`Remove ${role}`}
                                  >
                                    Remove {role}
                                  </button>
                                ))}
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
                        <Empty title="No users found">Try a different name, email, role, or status.</Empty>
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
            <Toolbar label="MODERATION" title="Open disputes">
              Review unresolved marketplace disputes and make the required payout decision.
            </Toolbar>

            <div className="ac-grid">
              {openDisputes.map((item) => (
                <div className="ac-card" key={item.id}>
                  <div className="ac-status-row">
                    <h3>{item.disputeType}</h3>
                    <span className={statusBadgeClass(item.status)}>{item.status}</span>
                  </div>

                  <p>
                    {item.raisedBy?.name}
                    {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs {item.against?.name}
                    {item.againstRole ? ` (${item.againstRole})` : ''}
                  </p>

                  <p>{item.description}</p>

                  <div className="ac-actions">
                    <button
                      className="sd-btn sd-btn-primary"
                      disabled={actionLoading === `dispute-${item.id}`}
                      onClick={() => openDisputeDecision(item, 'RESOLVED')}
                    >
                      Resolve
                    </button>

                    <button
                      className="sd-btn sd-btn-outline"
                      disabled={actionLoading === `dispute-${item.id}`}
                      onClick={() => openDisputeDecision(item, 'REJECTED')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

              {openDisputes.length === 0 && (
                <Empty title="No open disputes">The moderation queue is clear.</Empty>
              )}
            </div>

            <div style={{ marginTop: 28 }}>
              <Toolbar label="HISTORY" title="Recently resolved" />
            </div>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
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
                        <td data-label="Type">
                          <strong>{item.disputeType}</strong>
                        </td>
                        <td data-label="Parties" className="sd-muted">
                          {item.raisedBy?.name}
                          {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs {item.against?.name}
                          {item.againstRole ? ` (${item.againstRole})` : ''}
                        </td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(item.status)}>{item.status}</span>
                        </td>
                      </tr>
                    ))}

                    {resolvedDisputes.length === 0 && (
                      <tr>
                        <td colSpan="3" className="sd-muted">
                          Nothing resolved yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'fraud' && (
          <div>
            <Toolbar label="RISK MONITORING" title="Flagged users">
              Users with multiple open disputes filed against them. This is a starting heuristic — not a
              conclusive fraud finding.
            </Toolbar>

            <div className="ac-grid">
              {suspiciousUsers.map((item) => (
                <div className="ac-card" key={item.id}>
                  <div className="ac-status-row">
                    <h3>{item.name}</h3>
                    <span className="sd-badge sd-warn">REVIEW</span>
                  </div>

                  <p>
                    {item.email} · {(item.disputesAgainst || []).length} open dispute(s)
                  </p>

                  {(item.disputesAgainst || []).map((dispute) => (
                    <p key={dispute.id}>
                      — {dispute.disputeType}: {dispute.description}
                    </p>
                  ))}
                </div>
              ))}

              {suspiciousUsers.length === 0 && (
                <Empty title="No flagged users">
                  No heuristic fraud signals are currently in the monitoring queue.
                </Empty>
              )}
            </div>
          </div>
        )}

        {tab === 'advertising' && (
          <div>
            <Toolbar label="ADVERTISING" title="Campaign control">
              Review paid creative, publish approved campaigns, record Telegram publication, and end
              campaigns early when necessary.
            </Toolbar>

            <div className="ac-grid">
              {pendingAds.map((ad) => {
                const adPaid = (ad.payments || []).some((p) => p.status === 'PAID');
                const { ctr } = adAnalytics(ad);
                const busy = actionLoading === `ad-${ad.id}`;

                return (
                  <div className="ac-card" key={ad.id}>
                    {ad.creativeImageUrl && (
                      <img
                        src={ad.creativeImageUrl}
                        alt={ad.headline || 'Campaign creative'}
                        loading="lazy"
                        decoding="async"
                        className="ac-image"
                      />
                    )}

                    <div className="ac-status-row">
                      <h3>{humanize(ad.type)}</h3>
                      <span className={statusBadgeClass(ad.status)}>{ad.status}</span>
                    </div>

                    {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramImageUrls?.length > 0 && (
                      <ImageCarousel
                        images={ad.telegramImageUrls}
                        alt={ad.headline || 'Carousel photo'}
                        openLinks
                        className="img-carousel--compact"
                      />
                    )}

                    {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramTemplate && (
                      <p>
                        <strong>Template:</strong> {humanize(ad.telegramTemplate)}
                        {ad.telegramImageCount > 0 ? ` · ${ad.telegramImageCount} photos` : ''}
                      </p>
                    )}

                    {ad.headline && (
                      <p>
                        <strong>{ad.headline}</strong>
                      </p>
                    )}

                    <p>
                      <strong>Ref:</strong> {ad.campaignReference || ad.id.slice(0, 8)}
                      {' · '}
                      <strong>Advertiser:</strong> {ad.advertiser?.name} ({ad.advertiser?.email})
                    </p>

                    <p>
                      {ad.listing ? (
                        <>
                          Featuring <strong>{ad.listing.title || ad.listing.cropType}</strong> ·{' '}
                        </>
                      ) : (
                        'Platform-wide · '
                      )}
                      {shortDate(ad.startDate)} — {shortDate(ad.endDate)}
                    </p>

                    <div className="ac-financial">
                      <div className="ac-financial-item">
                        <span>Quoted</span>
                        <b>
                          {fmt(ad.priceQuoted)} {ad.currency || 'ETB'}
                        </b>
                      </div>

                      <div className="ac-financial-item">
                        <span>Paid</span>
                        <b>
                          {adPaid ? fmt(ad.amountPaid) : '0'} {ad.currency || 'ETB'}
                        </b>
                      </div>

                      <div className="ac-financial-item">
                        <span>CTR</span>
                        <b>{ctr}%</b>
                      </div>
                    </div>

                    {ad.destinationUrl && (
                      <p style={{ wordBreak: 'break-word' }}>Destination: {ad.destinationUrl}</p>
                    )}

                    <div className="ac-actions">
                      <button
                        className="sd-btn sd-btn-primary"
                        disabled={busy || !adPaid}
                        title={!adPaid ? 'Waiting for payment' : undefined}
                        onClick={() => setAdStatus(ad.id, 'APPROVED')}
                      >
                        {busy ? 'Working…' : 'Approve'}
                      </button>

                      <button
                        className="sd-btn sd-btn-outline"
                        disabled={busy}
                        onClick={() => setAdStatus(ad.id, 'REJECTED')}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {pendingAds.length === 0 && (
                <Empty title="No campaigns waiting">There are no campaigns waiting on content review.</Empty>
              )}
            </div>

            <div className="ac-panel" style={{ marginTop: 20 }}>
              <div className="ac-panel-header">
                <div>
                  <span className="ac-section-label">HISTORY</span>
                  <h2>Campaign ledger</h2>
                </div>
              </div>

              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Advertiser</th>
                      <th>Dates</th>
                      <th>Financials</th>
                      <th>Analytics</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>

                  <tbody>
                    {reviewedAds.slice(0, 30).map((ad) => {
                      const { impressions, clicks, ctr } = adAnalytics(ad);
                      const busy = actionLoading === `ad-${ad.id}`;

                      return (
                        <tr key={ad.id}>
                          <td data-label="Campaign">
                            <strong>{ad.campaignReference || humanize(ad.type)}</strong>
                            <br />
                            <span className="sd-muted">{humanize(ad.type)}</span>

                            {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramImageUrls?.length > 0 && (
                              <details className="tg-ledger-photos">
                                <summary>🎠 {ad.telegramImageUrls.length} carousel photos</summary>
                                <ImageCarousel
                                  images={ad.telegramImageUrls}
                                  alt={ad.headline || 'Carousel photo'}
                                  openLinks
                                  className="img-carousel--compact"
                                />
                              </details>
                            )}
                          </td>

                          <td data-label="Advertiser" className="sd-muted">
                            {ad.advertiser?.name}
                          </td>

                          <td data-label="Dates" className="sd-muted">
                            {shortDate(ad.startDate)} — {shortDate(ad.endDate)}
                          </td>

                          <td data-label="Financials" className="sd-muted">
                            {fmt(ad.priceQuoted)} {ad.currency || 'ETB'} quoted
                            <br />
                            {fmt(ad.amountPaid)} paid
                          </td>

                          <td data-label="Analytics" className="sd-muted">
                            {impressions} imp · {clicks} clicks · {ctr}% CTR
                          </td>

                          <td data-label="Status">
                            <span className={statusBadgeClass(ad.status)}>{ad.status}</span>
                          </td>

                          <td data-label="">
                            <div className="ac-actions">
                              {['PUBLISHED', 'ACTIVE'].includes(ad.status) && (
                                <button
                                  className="sd-btn sd-btn-outline"
                                  disabled={busy}
                                  onClick={() => setAdStatus(ad.id, 'EXPIRED')}
                                >
                                  {busy ? 'Working…' : 'End early'}
                                </button>
                              )}

                              {['PAID_PENDING_REVIEW', 'APPROVED', 'SCHEDULED'].includes(ad.status) && (
                                <button
                                  className="sd-btn sd-btn-outline"
                                  disabled={busy}
                                  onClick={() => cancelAdCampaign(ad.id)}
                                >
                                  {busy ? 'Working…' : 'Cancel & refund'}
                                </button>
                              )}

                              {ad.type === 'TELEGRAM_PROMOTION' &&
                                ['APPROVED', 'SCHEDULED'].includes(ad.status) && (
                                  <button
                                    className="sd-btn sd-btn-primary"
                                    disabled={busy}
                                    onClick={() => markTelegramPublished(ad.id)}
                                  >
                                    Mark Telegram published
                                  </button>
                                )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {reviewedAds.length === 0 && (
                      <tr>
                        <td colSpan="7" className="sd-muted">
                          No reviewed campaigns yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'orders' && (
          <div>
            <Toolbar label="ORDERS" title="All orders">
              Cancelling here is an admin override for stalled orders. It is blocked once a transport job
              has started pickup, since goods already in motion need a dispute instead.
            </Toolbar>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Listing</th>
                      <th>Buyer</th>
                      <th>Seller</th>
                      <th>Value</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>

                  <tbody>
                    {orders.map((o) => {
                      const transportInMotion = Boolean(
                        o.transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(o.transportJob.status)
                      );
                      const cancellable = !['COMPLETED', 'CANCELLED'].includes(o.status) && !transportInMotion;

                      return (
                        <tr key={o.id}>
                          <td data-label="Order">
                            <span className="ac-code">{o.id.slice(0, 8)}</span>
                          </td>
                          <td data-label="Listing">{o.listing?.title || o.listing?.cropType || '—'}</td>
                          <td data-label="Buyer">{o.buyer?.name || '—'}</td>
                          <td data-label="Seller">{o.seller?.name || '—'}</td>
                          <td data-label="Value">{fmt(o.finalPrice)} ETB</td>
                          <td data-label="Status">
                            <span className={statusBadgeClass(o.status)}>{o.status}</span>
                          </td>
                          <td data-label="">
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
                      <tr>
                        <td colSpan="7" className="sd-muted">
                          No orders yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'payments' && (
          <div>
            <Toolbar label="PAYMENTS" title="Payments needing attention">
              Payments that are still pending or need reconciliation.
            </Toolbar>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>Order</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Provider</th>
                      <th>Status</th>
                    </tr>
                  </thead>

                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td data-label="Payment">
                          <span className="ac-code">{String(p.id).slice(0, 8)}</span>
                        </td>
                        <td data-label="Order">
                          <span className="ac-code">{p.orderId ? String(p.orderId).slice(0, 8) : '—'}</span>
                        </td>
                        <td data-label="Type">{humanize(p.type) || '—'}</td>
                        <td data-label="Amount">
                          {fmt(p.amount)} {p.currency || 'ETB'}
                        </td>
                        <td data-label="Provider">{p.provider || '—'}</td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(p.status)}>{humanize(p.status)}</span>
                        </td>
                      </tr>
                    ))}

                    {payments.length === 0 && (
                      <tr>
                        <td colSpan="6" className="sd-muted">
                          No payments waiting for review.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'refunds' && (
          <div>
            <div className="ac-panel">
              <Toolbar
                label="FINANCIAL REFUNDS"
                title="Chapa refund queue"
                action={
                  <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                    {loading ? 'Refreshing…' : 'Refresh'}
                  </button>
                }
              >
                Refunds are submitted to Chapa automatically. A refund is not marked completed until Chapa
                reports the final refunded state.
              </Toolbar>

              <div className="ac-stat-strip">
                {[
                  ['Awaiting submission', refunds.filter((r) => r.status === 'REQUESTED').length],
                  ['Processing at Chapa', refunds.filter((r) => r.status === 'PROCESSING').length],
                  ['Completed', refunds.filter((r) => r.status === 'COMPLETED').length],
                  ['Failed / reversed', refunds.filter((r) => r.status === 'FAILED').length],
                ].map(([label, value]) => (
                  <div className="ac-small-stat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Refund</th>
                      <th>Payment</th>
                      <th>Amount</th>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Chapa refund ID</th>
                      <th>Chapa tx ref (admin)</th>
                      <th />
                    </tr>
                  </thead>

                  <tbody>
                    {refunds.map((refund) => (
                      <tr key={refund.id}>
                        <td data-label="Refund">
                          <span className="ac-code">{refund.id.slice(0, 8)}</span>
                        </td>
                        <td data-label="Payment">
                          <span className="ac-code">{refund.paymentId.slice(0, 8)}</span>
                        </td>
                        <td data-label="Amount">
                          {fmt(refund.amount)} {refund.currency || 'ETB'}
                        </td>
                        <td data-label="Provider">{refund.provider || refund.payment?.provider || '—'}</td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(refund.status)}>{refund.status}</span>
                        </td>
                        <td data-label="Chapa refund ID">
                          <span className="ac-code">
                            {refund.providerRefundId ? refund.providerRefundId.slice(0, 18) : '—'}
                          </span>
                        </td>
                        <td data-label="Chapa tx ref (admin)">
                          {refund.payment?.chapaTxRef ? (
                            <span className="ac-code">{refund.payment.chapaTxRef}</span>
                          ) : (
                            <>
                              <span className={statusBadgeClass('FAILED')}>missing</span>
                              {refund.payment?.providerTransactionId && (
                                <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                                  providerTransactionId:{' '}
                                  <span className="ac-code">{refund.payment.providerTransactionId}</span>
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td data-label="">
                          <div className="refund-actions">
                            {refund.status === 'REQUESTED' && (
                              <button
                                type="button"
                                className="sd-btn sd-btn-primary"
                                disabled={actionLoading === `refund-${refund.id}`}
                                onClick={() => processRefund(refund)}
                              >
                                {actionLoading === `refund-${refund.id}` ? 'Submitting…' : 'Process with Chapa'}
                              </button>
                            )}
                            {refund.status === 'PROCESSING' && (
                              <span className="sd-muted" style={{ fontSize: 12 }}>
                                Auto-checking with Chapa…
                              </span>
                            )}
                            {refund.status === 'FAILED' && (
                              <button
                                type="button"
                                className="sd-btn sd-btn-primary"
                                disabled={actionLoading === `refund-${refund.id}`}
                                onClick={() => processRefund(refund)}
                              >
                                {actionLoading === `refund-${refund.id}` ? 'Retrying…' : 'Retry refund'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}

                    {refunds.length === 0 && (
                      <tr>
                        <td colSpan="8" className="sd-muted">
                          No refunds recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'installments' && (
          <div>
            <div className="ac-panel">
              <Toolbar
                label="LARGE ORDER PAYMENTS"
                title="Installment plans"
                action={
                  <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                    {loading ? 'Refreshing…' : 'Refresh'}
                  </button>
                }
              >
                Each plan represents one full marketplace payment. The seller payout is created only when
                every live installment is PAID.
              </Toolbar>

              <div className="ac-stat-strip">
                {[
                  ['Open plans', openInstallmentPlans.length],
                  ['Paid plans', installmentPlans.filter((p) => p.status === 'PAID').length],
                  ['Refund pending', installmentPlans.filter((p) => p.status === 'REFUND_PENDING').length],
                  ['Refunded', installmentPlans.filter((p) => p.status === 'REFUNDED').length],
                ].map(([label, value]) => (
                  <div className="ac-small-stat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>

              <div className="ac-table-shell" style={{ marginTop: 16 }}>
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Order / plan</th>
                      <th>Buyer</th>
                      <th>Seller</th>
                      <th>Progress</th>
                      <th>Installments</th>
                      <th>Seller payout</th>
                      <th>Status</th>
                    </tr>
                  </thead>

                  <tbody>
                    {installmentPlans.map((plan) => {
                      const live = (plan.installments || [])
                        .filter((item) => item.installmentSequence != null)
                        .sort((a, b) => a.installmentSequence - b.installmentSequence);
                      const progress = plan.installmentProgress || {
                        paid: live.filter((item) => item.status === 'PAID').length,
                        total: plan.installmentCount,
                      };

                      return (
                        <tr key={plan.id}>
                          <td data-label="Order / plan">
                            {plan.order?.id ? (
                              <Link to={`/orders/${plan.order.id}`} className="ac-code">
                                {plan.order.id.slice(0, 8)}
                              </Link>
                            ) : (
                              <span className="ac-code">{plan.id.slice(0, 8)}</span>
                            )}
                            <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                              {fmt(plan.amount)} {plan.currency || 'ETB'}
                            </div>
                          </td>

                          <td data-label="Buyer">{plan.order?.buyer?.name || plan.createdBy?.name || '—'}</td>
                          <td data-label="Seller">{plan.order?.seller?.name || '—'}</td>

                          <td data-label="Progress">
                            <strong>
                              {progress.paid} / {progress.total}
                            </strong>
                          </td>

                          <td data-label="Installments">
                            <div style={{ display: 'grid', gap: 5, minWidth: 220 }}>
                              {live.map((item) => (
                                <div
                                  key={item.id}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    alignItems: 'center',
                                  }}
                                >
                                  <span>
                                    #{item.installmentSequence} · {fmt(item.amount)} {item.currency || 'ETB'}
                                  </span>
                                  <span className={statusBadgeClass(item.status)}>{item.status}</span>
                                </div>
                              ))}
                            </div>
                          </td>

                          <td data-label="Seller payout">
                            {plan.payout ? (
                              <>
                                <span className={statusBadgeClass(plan.payout.status)}>{plan.payout.status}</span>
                                <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                                  {fmt(plan.payout.amount)} {plan.payout.currency || 'ETB'}
                                </div>
                              </>
                            ) : (
                              <span className="sd-muted">Not created yet</span>
                            )}
                          </td>

                          <td data-label="Status">
                            <span className={statusBadgeClass(plan.status)}>{plan.status}</span>
                            {plan.order?.status && (
                              <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                                Order: {plan.order.status}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {installmentPlans.length === 0 && (
                      <tr>
                        <td colSpan="7" className="sd-muted">
                          No installment plans recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'operations' && (
          <div>
            <div className="ac-panel">
              <Toolbar
                label="SYSTEM OPERATIONS"
                title="Operations & audit"
                action={
                  <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                    {loading ? 'Refreshing…' : 'Refresh'}
                  </button>
                }
              >
                Monitor live workflow queues from durable OrderEvent records and review the internal audit
                trail.
              </Toolbar>

              <div className="ac-stat-strip">
                {[
                  ['Pending payments', operations?.queues?.pendingPayments || 0],
                  ['Reconciliation queue', operations?.queues?.reconciliationPayments || 0],
                  ['Open disputes', operations?.queues?.openDisputes || 0],
                  ['Active orders', operations?.activeOrders || 0],
                  ['Active transport', operations?.activeTransportJobs || 0],
                ].map(([label, value]) => (
                  <div className="ac-small-stat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="ac-panel">
              <Toolbar label="ORDER EVENTS" title="Recent order events">
                Latest durable OrderEvent records emitted by the workflow engine.
              </Toolbar>

              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Order</th>
                      <th>Status change</th>
                      <th>Actor</th>
                      <th>When</th>
                    </tr>
                  </thead>

                  <tbody>
                    {orderEvents.map((event) => (
                      <tr key={event.id}>
                        <td data-label="Event">
                          <span className={statusBadgeClass(event.type)}>{event.type || '—'}</span>
                        </td>
                        <td data-label="Order">
                          <span className="ac-code">{event.orderId ? event.orderId.slice(0, 8) : '—'}</span>
                        </td>
                        <td data-label="Status change">
                          {event.fromStatus || event.toStatus
                            ? `${event.fromStatus || '—'} → ${event.toStatus || '—'}`
                            : '—'}
                        </td>
                        <td data-label="Actor">{event.actor?.name || event.actor?.email || 'System'}</td>
                        <td data-label="When">
                          {event.createdAt ? new Date(event.createdAt).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}

                    {orderEvents.length === 0 && (
                      <tr>
                        <td colSpan="5" className="sd-muted">
                          No order events recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="ac-panel">
              <Toolbar label="AUDIT TRAIL" title="Admin audit log">
                Actions taken by admin users, most recent first.
              </Toolbar>

              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Resource</th>
                      <th>Actor</th>
                      <th>When</th>
                      <th>Details</th>
                    </tr>
                  </thead>

                  <tbody>
                    {auditEvents.map((event) => (
                      <tr key={event.id}>
                        <td data-label="Action">
                          <span className={statusBadgeClass(event.action)}>{event.action || '—'}</span>
                        </td>
                        <td data-label="Resource">
                          <span className="ac-code">
                            {event.resourceType || '—'}
                            {event.resourceId ? ` · ${event.resourceId.slice(0, 8)}` : ''}
                          </span>
                        </td>
                        <td data-label="Actor">{event.actor?.name || event.actor?.email || 'System'}</td>
                        <td data-label="When">
                          {event.createdAt ? new Date(event.createdAt).toLocaleString() : '—'}
                        </td>
                        <td data-label="Details">{event.metadata ? JSON.stringify(event.metadata) : '—'}</td>
                      </tr>
                    ))}

                    {auditEvents.length === 0 && (
                      <tr>
                        <td colSpan="5" className="sd-muted">
                          No audit events recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
