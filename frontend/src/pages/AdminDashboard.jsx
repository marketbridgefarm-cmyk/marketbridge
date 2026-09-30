import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/AdminDashboard.css';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];
const ROLE_OPTIONS = ['BUYER', 'SELLER', 'INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER', 'ADMIN'];
const PAYMENT_STATUSES = ['PENDING', 'RECONCILIATION_REQUIRED'];

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
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const toNumber = (value) => {
  const n = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : Number(value);
  return Number.isFinite(n) ? n : 0;
};

function describeError(err) {
  const status = err?.response?.status;
  const message =
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    (typeof err === 'string' ? err : '');
  return [status, message].filter(Boolean).join(' · ') || 'Unknown error';
}

function isTransient(err) {
  const status = err?.response?.status;
  return !err?.response || status === 408 || status === 429 || status >= 500;
}

async function withRetry(fn, retries = 1, delay = 1200) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0 && isTransient(err)) {
      await sleep(delay);
      return withRetry(fn, retries - 1, delay * 1.5);
    }
    throw err;
  }
}

async function fetchPayments() {
  try {
    return await api.get('/payments', { params: { status: PAYMENT_STATUSES } });
  } catch (err) {
    if (err.response?.data?.code === 'MFA_SETUP_REQUIRED') throw err;
    const res = await api.get('/payments');
    const all = res.data?.payments || [];
    return { data: { payments: all.filter((p) => PAYMENT_STATUSES.includes(p.status)) } };
  }
}

function statusBadgeClass(status) {
  if (['VERIFIED', 'ACTIVE', 'APPROVED', 'PUBLISHED', 'SCHEDULED', 'RESOLVED', 'COMPLETED', 'DELIVERED', 'PAID'].includes(status)) {
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
 * Metric Card
 * Designed to match the "Selling" card style from the Orders page.
 */
function Metric({ label, value, tone = '' }) {
  return (
    <div className={`ac-metric-card ${tone}`}>
      <div className="ac-metric-card-eyebrow">
        <span className="ac-eyebrow-line" />
        <span>{label}</span>
      </div>
      <strong className="ac-metric-card-value">{value}</strong>
    </div>
  );
}

/**
 * Progress Tracker
 * Replicates the green checkmark stepper from the Orders page.
 */
function ProgressTracker({ steps, currentStep }) {
  return (
    <div className="ac-progress-tracker">
      {steps.map((step, index) => (
        <div key={step} className="ac-progress-step">
          <div className={`ac-progress-dot ${index <= currentStep ? 'active' : ''}`}>
            {index <= currentStep ? '✓' : ''}
          </div>
          {index < steps.length - 1 && (
            <div className={`ac-progress-line ${index < currentStep ? 'active' : ''}`} />
          )}
        </div>
      ))}
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
        <div className="ac-toolbar-eyebrow">
          <span className="ac-eyebrow-line" />
          <span>{label}</span>
        </div>
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
  const [loadIssues, setLoadIssues] = useState([]);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [actionLoading, setActionLoading] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    setMfaRequired(false);

    const issues = [];
    let mfa = false;

    const load = async (label, request, apply) => {
      try {
        const res = await withRetry(request);
        apply(res?.data || {});
      } catch (err) {
        if (err?.response?.data?.code === 'MFA_SETUP_REQUIRED') {
          mfa = true;
          return;
        }
        console.error(`Admin Dashboard: "${label}" failed`, err);
        issues.push({ label, detail: describeError(err) });
      }
    };

    await Promise.all([
      load('Overview', () => api.get('/admin/overview'), (d) => setOverview(d)),
      load('Users', () => api.get('/admin/users'), (d) => setUsers(d.users || [])),
    ]);

    if (mfa) {
      setMfaRequired(true);
      setBootstrapped(true);
      setLoading(false);
      return;
    }

    setBootstrapped(true);

    const batches = [
      [
        () => load('Disputes', () => api.get('/disputes'), (d) => setDisputes(d.disputes || [])),
        () => load('Fraud flags', () => api.get('/admin/fraud-flags'), (d) => setSuspiciousUsers(d.suspiciousUsers || [])),
        () => load('Advertising', () => api.get('/ads'), (d) => setAds(d.ads || [])),
      ],
      [
        () => load('Payments', fetchPayments, (d) => setPayments(d.payments || [])),
        () => load('Orders', () => api.get('/orders'), (d) => setOrders(d.orders || [])),
        () => load('Operations summary', () => api.get('/admin/operations/summary'), (d) => setOperations(d || null)),
      ],
      [
        () => load('Order events', () => api.get('/admin/order-events', { params: { limit: 100 } }), (d) => setOrderEvents(d.events || [])),
        () => load('Audit events', () => api.get('/admin/audit-events', { params: { limit: 100 } }), (d) => setAuditEvents(d.events || [])),
        () => load('Refunds', () => api.get('/admin/financial/refunds'), (d) => setRefunds(d.refunds || [])),
      ],
      [
        () =>
          load(
            'Installment plans',
            () => api.get('/admin/financial/installment-plans').catch(() => ({ data: { plans: [] } })),
            (d) => setInstallmentPlans(d.plans || [])
          ),
      ],
    ];

    for (const batch of batches) {
      await Promise.all(batch.map((run) => run()));
      if (mfa) break;
    }

    if (mfa) {
      setMfaRequired(true);
    }

    setLoadIssues(issues);
    setLoading(false);
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
        { label: 'Users', value: overview.users, tone: '' },
        { label: 'Listings', value: overview.listings, tone: '' },
        { label: 'Orders', value: overview.orders, tone: '' },
        { label: 'Open disputes', value: overview.openDisputes, tone: 'warn' },
        { label: 'Active ads', value: overview.activeAds, tone: '' },
        { label: 'Suspended users', value: overview.suspendedUsers || 0, tone: 'danger' },
        { label: 'Paid volume', value: `${fmt(overview.totalPaidVolume)} ETB`, tone: 'primary' },
      ]
    : [];

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

  if (!bootstrapped && !mfaRequired) {
    return (
      <div className="sd-dashboard admin-control-center">
        <div className="ac-mfa">
          <div className="ac-mfa-icon">⌛</div>
          <span className="ac-kicker">ADMINISTRATION</span>
          <h1>Loading control center</h1>
          <p className="sd-muted">Loading admin dashboard…</p>
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

        {cards.length > 0 ? (
          <div className="ac-metrics-grid">
            {cards.map((card) => (
              <Metric
                key={card.label}
                label={card.label}
                value={card.value}
                tone={card.tone}
              />
            ))}
          </div>
        ) : (
          <div className="ac-metrics-grid ac-metrics--empty">
            <Empty title="Metrics unavailable">
              The overview numbers couldn’t be loaded. See the notice below for the exact error, then try
              again.
            </Empty>
          </div>
        )}
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

          <div className="ac-metrics-grid" style={{ marginTop: 18 }}>
            {cards.map((card) => (
              <Metric
                key={card.label}
                label={card.label}
                value={card.value}
                tone={card.tone}
              />
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

      {loadIssues.length > 0 && (
        <section className="ac-section">
          <div className="ac-alert warn" role="alert">
            <span className="ac-alert-icon">!</span>
            <div className="ac-alert-body">
              <strong>Some data couldn’t be loaded</strong>
              <ul className="ac-alert-list">
                {loadIssues.map((issue) => (
                  <li key={issue.label}>
                    <b>{issue.label}</b> — {issue.detail}
                  </li>
                ))}
              </ul>
              <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                {loading ? 'Retrying…' : 'Try again'}
              </button>
            </div>
          </div>
        </section>
      )}

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
                <div className="ac-toolbar-eyebrow">
                  <span className="ac-eyebrow-line" />
                  <span>SYSTEM OVERVIEW</span>
                </div>
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

            {/* NEW: Responsive Card Grid for Users */}
            <div className="ac-users-grid">
              {filteredUsers.map((item) => {
                const busy = actionLoading.includes(item.id);
                const suspended = item.accountStatus === 'SUSPENDED';

                return (
                  <div className="ac-user-card" key={item.id}>
                    {/* Header: Name & Account Status */}
                    <div className="ac-user-card-header">
                      <div className="ac-user-card-name">
                        <strong>{item.name}</strong>
                        {item.phone && <span className="ac-user-card-sub">{item.phone}</span>}
                        {item.location && <span className="ac-user-card-sub">{item.location}</span>}
                      </div>
                      <span className={statusBadgeClass(item.accountStatus || 'ACTIVE')}>
                        {item.accountStatus || 'ACTIVE'}
                      </span>
                    </div>

                    {/* Email */}
                    <div className="ac-user-card-row">
                      <span className="ac-user-card-label">Email</span>
                      <span className="ac-user-card-value">{item.email}</span>
                    </div>

                    {/* Roles */}
                    <div className="ac-user-card-row">
                      <span className="ac-user-card-label">Roles</span>
                      <div className="sd-chip-row">
                        {(item.roles || []).map((role) => (
                          <span className="sd-badge" key={role}>
                            {role}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Rating */}
                    <div className="ac-user-card-row">
                      <span className="ac-user-card-label">Rating</span>
                      <span className="ac-user-card-value">{Number(item.rating || 0).toFixed(1)}</span>
                    </div>

                    {/* Verification */}
                    <div className="ac-user-card-row">
                      <span className="ac-user-card-label">Verification</span>
                      <select
                        value={item.verificationStatus || 'UNVERIFIED'}
                        onChange={(e) => setVerification(item.id, e.target.value)}
                        disabled={busy}
                        className="ac-user-card-select"
                      >
                        <option value="UNVERIFIED">UNVERIFIED</option>
                        {VERIFICATION_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Account Actions */}
                    <div className="ac-user-card-row">
                      <span className="ac-user-card-label">Account</span>
                      <div className="ac-user-card-actions">
                        <button
                          type="button"
                          className={`sd-btn ${suspended ? 'sd-btn-primary' : 'sd-btn-outline'}`}
                          disabled={busy}
                          onClick={() => setAccountStatus(item.id, suspended ? 'ACTIVE' : 'SUSPENDED')}
                        >
                          {busy ? 'Working…' : suspended ? 'Activate' : 'Suspend'}
                        </button>
                      </div>
                    </div>

                    {/* Role Control */}
                    <div className="ac-user-card-row ac-user-card-row--stacked">
                      <span className="ac-user-card-label">Role Control</span>
                      <div className="ac-role-actions">
                        <select
                          value={roleSelections[item.id] || ''}
                          onChange={(e) =>
                            setRoleSelections((current) => ({ ...current, [item.id]: e.target.value }))
                          }
                          disabled={busy}
                          className="ac-user-card-select"
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
                          <div className="sd-chip-row" style={{ marginTop: 4 }}>
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
                    </div>
                  </div>
                );
              })}

              {filteredUsers.length === 0 && (
                <div className="ac-users-grid-empty">
                  <Empty title="No users found">Try a different name, email, role, or status.</Empty>
                </div>
              )}
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
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>DISPUTE</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{item.disputeType}</h3>
                    <span className={statusBadgeClass(item.status)}>{item.status}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">PARTIES</span>
                    <span className="ac-card-value">
                      {item.raisedBy?.name}
                      {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs {item.against?.name}
                      {item.againstRole ? ` (${item.againstRole})` : ''}
                    </span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">DESCRIPTION</span>
                    <span className="ac-card-value">{item.description}</span>
                  </div>

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

            <div className="ac-grid">
              {resolvedDisputes.slice(0, 10).map((item) => (
                <div className="ac-card" key={item.id}>
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>HISTORY</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{item.disputeType}</h3>
                    <span className={statusBadgeClass(item.status)}>{item.status}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">PARTIES</span>
                    <span className="ac-card-value">
                      {item.raisedBy?.name}
                      {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs {item.against?.name}
                      {item.againstRole ? ` (${item.againstRole})` : ''}
                    </span>
                  </div>
                </div>
              ))}

              {resolvedDisputes.length === 0 && (
                <Empty title="No history">Nothing resolved yet.</Empty>
              )}
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
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>FLAGGED USER</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{item.name}</h3>
                    <span className="sd-badge sd-warn">REVIEW</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">EMAIL</span>
                    <span className="ac-card-value">{item.email}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">OPEN DISPUTES</span>
                    <span className="ac-card-value">{(item.disputesAgainst || []).length}</span>
                  </div>

                  {(item.disputesAgainst || []).map((dispute) => (
                    <div className="ac-card-row" key={dispute.id}>
                      <span className="ac-card-label">DISPUTE</span>
                      <span className="ac-card-value">
                        {dispute.disputeType}: {dispute.description}
                      </span>
                    </div>
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
                    <div className="ac-card-eyebrow">
                      <span className="ac-eyebrow-line" />
                      <span>ADVERTISING</span>
                    </div>
                    {ad.creativeImageUrl && (
                      <img
                        src={ad.creativeImageUrl}
                        alt={ad.headline || 'Campaign creative'}
                        loading="lazy"
                        decoding="async"
                        className="ac-image"
                      />
                    )}

                    <div className="ac-card-header">
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
                      <div className="ac-card-row">
                        <span className="ac-card-label">TEMPLATE</span>
                        <span className="ac-card-value">
                          {humanize(ad.telegramTemplate)}
                          {ad.telegramImageCount > 0 ? ` · ${ad.telegramImageCount} photos` : ''}
                        </span>
                      </div>
                    )}

                    {ad.headline && (
                      <div className="ac-card-row">
                        <span className="ac-card-label">HEADLINE</span>
                        <span className="ac-card-value">{ad.headline}</span>
                      </div>
                    )}

                    <div className="ac-card-row">
                      <span className="ac-card-label">REF / ADVERTISER</span>
                      <span className="ac-card-value">
                        {ad.campaignReference || ad.id.slice(0, 8)} · {ad.advertiser?.name} ({ad.advertiser?.email})
                      </span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">DATES</span>
                      <span className="ac-card-value">
                        {shortDate(ad.startDate)} — {shortDate(ad.endDate)}
                      </span>
                    </div>

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
                      <div className="ac-card-row">
                        <span className="ac-card-label">DESTINATION</span>
                        <span className="ac-card-value" style={{ wordBreak: 'break-word' }}>{ad.destinationUrl}</span>
                      </div>
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

            <div style={{ marginTop: 28 }}>
              <Toolbar label="HISTORY" title="Campaign ledger" />
            </div>

            <div className="ac-grid">
              {reviewedAds.slice(0, 30).map((ad) => {
                const { impressions, clicks, ctr } = adAnalytics(ad);
                const busy = actionLoading === `ad-${ad.id}`;

                return (
                  <div className="ac-card" key={ad.id}>
                    <div className="ac-card-eyebrow">
                      <span className="ac-eyebrow-line" />
                      <span>CAMPAIGN</span>
                    </div>
                    <div className="ac-card-header">
                      <h3>{ad.campaignReference || humanize(ad.type)}</h3>
                      <span className={statusBadgeClass(ad.status)}>{ad.status}</span>
                    </div>

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

                    <div className="ac-card-row">
                      <span className="ac-card-label">ADVERTISER</span>
                      <span className="ac-card-value">{ad.advertiser?.name}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">DATES</span>
                      <span className="ac-card-value">
                        {shortDate(ad.startDate)} — {shortDate(ad.endDate)}
                      </span>
                    </div>

                    <div className="ac-financial">
                      <div className="ac-financial-item">
                        <span>Quoted</span>
                        <b>{fmt(ad.priceQuoted)} {ad.currency || 'ETB'}</b>
                      </div>
                      <div className="ac-financial-item">
                        <span>Paid</span>
                        <b>{fmt(ad.amountPaid)} {ad.currency || 'ETB'}</b>
                      </div>
                      <div className="ac-financial-item">
                        <span>CTR</span>
                        <b>{ctr}%</b>
                      </div>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">ANALYTICS</span>
                      <span className="ac-card-value">
                        {impressions} imp · {clicks} clicks · {ctr}% CTR
                      </span>
                    </div>

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
                  </div>
                );
              })}

              {reviewedAds.length === 0 && (
                <Empty title="No history">No reviewed campaigns yet.</Empty>
              )}
            </div>
          </div>
        )}

        {tab === 'orders' && (
          <div>
            <Toolbar label="ORDERS" title="All orders">
              Cancelling here is an admin override for stalled orders. It is blocked once a transport job
              has started pickup, since goods already in motion need a dispute instead.
            </Toolbar>

            <div className="ac-grid">
              {orders.map((o) => {
                const transportInMotion = Boolean(
                  o.transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(o.transportJob.status)
                );
                const cancellable = !['COMPLETED', 'CANCELLED'].includes(o.status) && !transportInMotion;

                return (
                  <div className="ac-card" key={o.id}>
                    <div className="ac-card-eyebrow">
                      <span className="ac-eyebrow-line" />
                      <span>ORDER</span>
                    </div>
                    <div className="ac-card-header">
                      <h3>{o.listing?.title || o.listing?.cropType || 'Order'}</h3>
                      <span className={statusBadgeClass(o.status)}>{o.status}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">ORDER ID</span>
                      <span className="ac-card-value ac-code">{o.id.slice(0, 8)}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">BUYER</span>
                      <span className="ac-card-value">{o.buyer?.name || '—'}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">SELLER</span>
                      <span className="ac-card-value">{o.seller?.name || '—'}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">VALUE</span>
                      <span className="ac-card-value">{fmt(o.finalPrice)} ETB</span>
                    </div>

                    <div className="ac-actions">
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
                    </div>
                  </div>
                );
              })}

              {orders.length === 0 && (
                <Empty title="No orders yet">No orders to display.</Empty>
              )}
            </div>
          </div>
        )}

        {tab === 'payments' && (
          <div>
            <Toolbar label="PAYMENTS" title="Payments needing attention">
              Payments that are still pending or need reconciliation.
            </Toolbar>

            <div className="ac-grid">
              {payments.map((p) => (
                <div className="ac-card" key={p.id}>
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>PAYMENT</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{String(p.id).slice(0, 8)}</h3>
                    <span className={statusBadgeClass(p.status)}>{humanize(p.status)}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">ORDER</span>
                    <span className="ac-card-value ac-code">{p.orderId ? String(p.orderId).slice(0, 8) : '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">TYPE</span>
                    <span className="ac-card-value">{humanize(p.type) || '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">AMOUNT</span>
                    <span className="ac-card-value">{fmt(p.amount)} {p.currency || 'ETB'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">PROVIDER</span>
                    <span className="ac-card-value">{p.provider || '—'}</span>
                  </div>
                </div>
              ))}

              {payments.length === 0 && (
                <Empty title="No payments">No payments waiting for review.</Empty>
              )}
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

            <div className="ac-grid" style={{ marginTop: 18 }}>
              {refunds.map((refund) => (
                <div className="ac-card" key={refund.id}>
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>REFUND</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{refund.id.slice(0, 8)}</h3>
                    <span className={statusBadgeClass(refund.status)}>{refund.status}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">PAYMENT</span>
                    <span className="ac-card-value ac-code">{refund.paymentId.slice(0, 8)}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">AMOUNT</span>
                    <span className="ac-card-value">{fmt(refund.amount)} {refund.currency || 'ETB'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">PROVIDER</span>
                    <span className="ac-card-value">{refund.provider || refund.payment?.provider || '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">CHAPA REF ID</span>
                    <span className="ac-card-value ac-code">
                      {refund.providerRefundId ? refund.providerRefundId.slice(0, 18) : '—'}
                    </span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">CHAPA TX REF</span>
                    <span className="ac-card-value ac-code">
                      {refund.payment?.chapaTxRef || 'missing'}
                    </span>
                  </div>

                  <div className="ac-actions">
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
                </div>
              ))}

              {refunds.length === 0 && (
                <Empty title="No refunds">No refunds recorded.</Empty>
              )}
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
            </div>

            <div className="ac-grid" style={{ marginTop: 18 }}>
              {installmentPlans.map((plan) => {
                const live = (plan.installments || [])
                  .filter((item) => item.installmentSequence != null)
                  .sort((a, b) => a.installmentSequence - b.installmentSequence);
                const progress = plan.installmentProgress || {
                  paid: live.filter((item) => item.status === 'PAID').length,
                  total: plan.installmentCount,
                };

                return (
                  <div className="ac-card" key={plan.id}>
                    <div className="ac-card-eyebrow">
                      <span className="ac-eyebrow-line" />
                      <span>INSTALLMENT PLAN</span>
                    </div>
                    <div className="ac-card-header">
                      <h3>
                        {plan.order?.id ? (
                          <Link to={`/orders/${plan.order.id}`} className="ac-code">
                            {plan.order.id.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="ac-code">{plan.id.slice(0, 8)}</span>
                        )}
                      </h3>
                      <span className={statusBadgeClass(plan.status)}>{plan.status}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">AMOUNT</span>
                      <span className="ac-card-value">{fmt(plan.amount)} {plan.currency || 'ETB'}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">BUYER</span>
                      <span className="ac-card-value">{plan.order?.buyer?.name || plan.createdBy?.name || '—'}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">SELLER</span>
                      <span className="ac-card-value">{plan.order?.seller?.name || '—'}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">PROGRESS</span>
                      <span className="ac-card-value">{progress.paid} / {progress.total}</span>
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">INSTALLMENTS</span>
                      <div className="ac-card-value" style={{ display: 'grid', gap: 5, minWidth: 220 }}>
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
                    </div>

                    <div className="ac-card-row">
                      <span className="ac-card-label">SELLER PAYOUT</span>
                      <span className="ac-card-value">
                        {plan.payout ? (
                          <>
                            <span className={statusBadgeClass(plan.payout.status)}>{plan.payout.status}</span>
                            <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                              {fmt(plan.payout.amount)} {plan.payout.currency || 'ETB'}
                            </div>
                          </>
                        ) : (
                          'Not created yet'
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}

              {installmentPlans.length === 0 && (
                <Empty title="No plans">No installment plans recorded.</Empty>
              )}
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

            <div style={{ marginTop: 28 }}>
              <Toolbar label="ORDER EVENTS" title="Recent order events" />
            </div>

            <div className="ac-grid">
              {orderEvents.map((event) => (
                <div className="ac-card" key={event.id}>
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>EVENT</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{event.type || '—'}</h3>
                    <span className={statusBadgeClass(event.type)}>{event.type || '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">ORDER</span>
                    <span className="ac-card-value ac-code">{event.orderId ? event.orderId.slice(0, 8) : '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">STATUS CHANGE</span>
                    <span className="ac-card-value">
                      {event.fromStatus || event.toStatus
                        ? `${event.fromStatus || '—'} → ${event.toStatus || '—'}`
                        : '—'}
                    </span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">ACTOR</span>
                    <span className="ac-card-value">{event.actor?.name || event.actor?.email || 'System'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">WHEN</span>
                    <span className="ac-card-value">
                      {event.createdAt ? new Date(event.createdAt).toLocaleString() : '—'}
                    </span>
                  </div>
                </div>
              ))}

              {orderEvents.length === 0 && (
                <Empty title="No events">No order events recorded.</Empty>
              )}
            </div>

            <div style={{ marginTop: 28 }}>
              <Toolbar label="AUDIT TRAIL" title="Admin audit log" />
            </div>

            <div className="ac-grid">
              {auditEvents.map((event) => (
                <div className="ac-card" key={event.id}>
                  <div className="ac-card-eyebrow">
                    <span className="ac-eyebrow-line" />
                    <span>AUDIT</span>
                  </div>
                  <div className="ac-card-header">
                    <h3>{event.action || '—'}</h3>
                    <span className={statusBadgeClass(event.action)}>{event.action || '—'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">RESOURCE</span>
                    <span className="ac-card-value ac-code">
                      {event.resourceType || '—'}
                      {event.resourceId ? ` · ${event.resourceId.slice(0, 8)}` : ''}
                    </span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">ACTOR</span>
                    <span className="ac-card-value">{event.actor?.name || event.actor?.email || 'System'}</span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">WHEN</span>
                    <span className="ac-card-value">
                      {event.createdAt ? new Date(event.createdAt).toLocaleString() : '—'}
                    </span>
                  </div>

                  <div className="ac-card-row">
                    <span className="ac-card-label">DETAILS</span>
                    <span className="ac-card-value">{event.metadata ? JSON.stringify(event.metadata) : '—'}</span>
                  </div>
                </div>
              ))}

              {auditEvents.length === 0 && (
                <Empty title="No audit events">No audit events recorded.</Empty>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
