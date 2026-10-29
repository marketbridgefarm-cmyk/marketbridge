import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';
import AdminInspectionArrivals from '../components/AdminInspectionArrivals.jsx';
import AdminOverview from '../components/AdminOverview.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/AdminDashboard.css';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];

const ROLE_OPTIONS = [
  'BUYER',
  'SELLER',
  'INSPECTOR',
  'TRUCK_OWNER',
  'ADVERTISER',
  'ADMIN',
];

export default function AdminDashboard() {
  const { user } = useAuth();

  const [tab, setTab] = useState('overview');
  const [disputedArrivals, setDisputedArrivals] = useState(0);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);

  const disputeModalRef = useRef(null);
  const tabsNavRef = useRef(null);

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);
  const [ads, setAds] = useState([]);
  const [payments, setPayments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [commissionSummary, setCommissionSummary] = useState(null);
  const [operations, setOperations] = useState(null);
  const [orderEvents, setOrderEvents] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [recoveryRequests, setRecoveryRequests] = useState([]);
  const [releaseReviews, setReleaseReviews] = useState([]);
  const [frequentProviders, setFrequentProviders] = useState([]);
  const [providerStandings, setProviderStandings] = useState([]);

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
        commissionRes,
        ordersRes,
        operationsRes,
        orderEventsRes,
        auditEventsRes,
        refundsRes,
        recoveryRes,
        releaseReviewsRes,
        providerStandingsRes,
      ] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
        api.get('/ads'),
        api.get('/payments', {
          params: {
            status: ['PENDING', 'RECONCILIATION_REQUIRED'],
          },
        }),
        api.get('/payments/commissions/summary'),
        api.get('/orders'),
        api.get('/admin/operations/summary'),
        api.get('/admin/order-events', { params: { limit: 100 } }),
        api.get('/admin/audit-events', { params: { limit: 100 } }),
        api.get('/admin/financial/refunds'),
        api.get('/recovery-requests/admin/pending'),
        api.get('/admin/release-reviews').catch(() => ({ data: { reviews: [], frequentProviders: [] } })),
        api.get('/admin/provider-standings').catch(() => ({ data: { standings: [] } })),
      ]);

      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
      setAds(adsRes.data?.ads || []);
      setPayments(paymentsRes.data?.payments || []);
      setCommissionSummary(commissionRes.data);
      setOrders(ordersRes.data?.orders || []);
      setOperations(operationsRes.data || null);
      setOrderEvents(orderEventsRes.data?.events || []);
      setAuditEvents(auditEventsRes.data?.events || []);
      setRefunds(refundsRes.data?.refunds || []);
      setRecoveryRequests(recoveryRes.data?.recoveryRequests || []);
      setReleaseReviews(releaseReviewsRes.data?.reviews || []);
      setFrequentProviders(releaseReviewsRes.data?.frequentProviders || []);
      setProviderStandings(providerStandingsRes.data?.standings || []);
    } catch (err) {
      if (err.response?.data?.code === 'MFA_SETUP_REQUIRED') {
        setMfaRequired(true);
      } else {
        setError(err.response?.data?.error || 'Could not load admin data');
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
          // Silent background check.
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

  useEffect(() => {
    if (!tabMenuOpen) return undefined;

    function handleOutsideClick(event) {
      if (tabsNavRef.current && !tabsNavRef.current.contains(event.target)) {
        setTabMenuOpen(false);
      }
    }

    function handleKey(event) {
      if (event.key === 'Escape') setTabMenuOpen(false);
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [tabMenuOpen]);

  // Every admin table renders as one card per row; copy each header's text onto its cells as the card label.
  useEffect(() => {
    document.querySelectorAll('.admin-control-center table.sd-table--stack').forEach((table) => {
      const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
      table.querySelectorAll('tbody tr').forEach((row) => {
        Array.from(row.children).forEach((cell, i) => {
          if (!cell.hasAttribute('data-label') && heads[i] !== undefined && !cell.hasAttribute('colspan')) {
            cell.setAttribute('data-label', heads[i]);
          }
        });
      });
    });
  });

  function statusBadgeClass(status) {
    if (
      ['VERIFIED', 'ACTIVE', 'APPROVED', 'PUBLISHED', 'SCHEDULED', 'RESOLVED', 'COMPLETED'].includes(status)
    ) {
      return 'sd-badge sd-good';
    }
    if (['REJECTED', 'SUSPENDED', 'CANCELLED', 'FAILED'].includes(status)) {
      return 'sd-badge sd-red';
    }
    if (['PENDING', 'PENDING_PAYMENT', 'PAID_PENDING_REVIEW', 'EXPIRED', 'REQUESTED', 'PROCESSING'].includes(status)) {
      return 'sd-badge sd-warn';
    }
    if (status === 'RECONCILIATION_REQUIRED') {
      return 'sd-badge sd-red';
    }
    return 'sd-badge';
  }

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  // --------------------------------------------------------------------------
  // Dispute resolution — scoped by the disputed service
  // --------------------------------------------------------------------------

  function disputeAffectedService(dispute) {
    if (!dispute?.order) return 'GOODS';
    const againstId = dispute.againstId;
    if (dispute.order.buyerId === againstId) return 'GOODS';
    if (dispute.order.sellerId === againstId) return 'GOODS';
    if (dispute.againstRole === 'INSPECTOR') return 'INSPECTION';
    if (dispute.againstRole === 'TRUCK_OWNER') return 'TRANSPORT';
    return 'GOODS';
  }

  function openDisputeDecision(dispute, resolutionType) {
    clearMessages();
    setDisputeDecision({
      id: dispute.id,
      resolutionType,
      resolution: `Marked ${resolutionType} by admin`,
      affectedService: disputeAffectedService(dispute),
    });
    disputeModalRef.current?.showModal();
  }

  function closeDisputeDecision() {
    disputeModalRef.current?.close();
    setDisputeDecision(null);
  }

  async function submitDisputeDecision() {
    if (!disputeDecision) return;
    const { id, resolutionType, resolution } = disputeDecision;

    if (!resolution || resolution.trim().length < 5) {
      setError('Resolution notes must be at least 5 characters.');
      return;
    }

    clearMessages();
    setActionLoading(`dispute-${id}`);

    try {
      await api.patch(`/disputes/${id}/resolve`, { resolutionType, resolution });
      const labels = {
        DISMISSED: 'Claim dismissed — order resumed without cancellation.',
        CANCEL_SERVICE: 'Disputed service cancelled. Its payment is being refunded. The order stays open.',
        CANCEL_ORDER: 'Order cancelled. All settled payments are queued for refund.',
      };
      setSuccess(labels[resolutionType] || 'Dispute resolved.');
      closeDisputeDecision();
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not resolve dispute');
    } finally {
      setActionLoading('');
    }
  }

  async function processRefund(refund) {
    clearMessages();

    const confirmed = window.confirm(
      `Submit the ${Number(refund.amount).toLocaleString()} ${refund.currency || 'ETB'} refund for payment ${refund.paymentId.slice(0, 8)} to Chapa now? MarketBridge checks with Chapa automatically until it confirms the money was returned — no further action needed here.`
    );

    if (!confirmed) return;

    setActionLoading(`refund-${refund.id}`);
    try {
      let result;
      if (refund.status === 'FAILED') {
        result = await api.post(`/admin/financial/refunds/${refund.id}/retry`);
      } else {
        result = await api.post(`/admin/financial/refunds/${refund.id}/process`);
      }
      const finalStatus = result?.data?.refund?.status;
      setSuccess(
        finalStatus === 'COMPLETED'
          ? 'Chapa confirmed the refund immediately — it\'s complete.'
          : 'Refund submitted to Chapa. It will finalize automatically — no need to check back manually.'
      );
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit refund to Chapa');
    } finally {
      setActionLoading('');
    }
  }

  async function verifyRefund(refund) {
    clearMessages();
    setActionLoading(`refund-${refund.id}`);
    try {
      const response = await api.post(`/admin/financial/refunds/${refund.id}/verify`);
      const status = response.data?.providerStatus;
      if (status === 'refunded') {
        setSuccess('Chapa confirmed the refund. MarketBridge marked it completed.');
      } else if (status === 'reversed') {
        setError('Chapa reversed the refund. The refund was not completed.');
      } else {
        setSuccess(`Chapa refund status: ${status || 'processing'}.`);
      }
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not verify refund with Chapa');
    } finally {
      setActionLoading('');
    }
  }

  async function markRefundFailed(refund) {
    clearMessages();
    const failureReason = window.prompt('Reason the refund failed:');
    if (!failureReason) return;

    setActionLoading(`refund-${refund.id}`);
    try {
      await api.patch(`/admin/financial/refunds/${refund.id}/fail`, { failureReason });
      setSuccess('Refund marked as failed.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update refund');
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
    clearMessages();
    setActionLoading(`verify-${userId}`);
    try {
      await api.patch(`/admin/users/${userId}/verify`, { verificationStatus });
      setSuccess('Verification status updated successfully.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update verification status');
    } finally {
      setActionLoading('');
    }
  }

  async function setAccountStatus(userId, accountStatus) {
    clearMessages();
    const targetUser = users.find((item) => item.id === userId);
    if (!targetUser) return;

    const action = accountStatus === 'SUSPENDED' ? 'suspend' : 'activate';
    const confirmed = window.confirm(`Are you sure you want to ${action} ${targetUser.name || targetUser.email}?`);
    if (!confirmed) return;

    setActionLoading(`status-${userId}`);
    try {
      await api.patch(`/admin/users/${userId}/status`, { accountStatus });
      setSuccess(accountStatus === 'SUSPENDED' ? 'User account suspended successfully.' : 'User account activated successfully.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update account status');
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
      await api.patch(`/admin/users/${userId}/roles/add`, { role });
      setSuccess(`${role} role added successfully.`);
      setRoleSelections((current) => ({ ...current, [userId]: '' }));
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add role');
    } finally {
      setActionLoading('');
    }
  }

  async function removeRole(userId, role) {
    clearMessages();
    const targetUser = users.find((item) => item.id === userId);
    if (!targetUser) return;

    const confirmed = window.confirm(`Remove ${role} role from ${targetUser.name || targetUser.email}?`);
    if (!confirmed) return;

    setActionLoading(`remove-role-${userId}-${role}`);
    try {
      await api.patch(`/admin/users/${userId}/roles/remove`, { role });
      setSuccess(`${role} role removed successfully.`);
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove role');
    } finally {
      setActionLoading('');
    }
  }

  async function markTelegramPublished(adId) {
    clearMessages();
    const postReference = window.prompt('Telegram post reference/link (optional):') || undefined;
    setActionLoading(`ad-${adId}`);
    try {
      await api.patch(`/ads/${adId}/telegram-publication`, { postReference });
      setSuccess('Telegram publication recorded.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record Telegram publication');
    } finally {
      setActionLoading('');
    }
  }

  async function cancelAdCampaign(adId) {
    clearMessages();
    if (!window.confirm('Cancel this campaign? Any paid amount is flagged REFUNDED as a bookkeeping record.')) return;
    const reason = window.prompt('Reason for cancelling this campaign (optional):') || undefined;
    setActionLoading(`ad-${adId}`);
    try {
      await api.patch(`/ads/${adId}/cancel`, { reason });
      setSuccess('Campaign cancelled.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not cancel campaign');
    } finally {
      setActionLoading('');
    }
  }

  async function setAdStatus(adId, status) {
    clearMessages();
    setActionLoading(`ad-${adId}`);
    try {
      let rejectionReason;
      if (status === 'REJECTED') {
        rejectionReason = window.prompt('Reason for rejecting this campaign (optional):') || undefined;
      }
      await api.patch(`/ads/${adId}/status`, { status, rejectionReason });
      setSuccess(`Campaign ${status.toLowerCase()} successfully.`);
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update campaign status');
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
      setError(err.response?.data?.error || 'Could not confirm payment');
    } finally {
      setActionLoading('');
    }
  }

  async function checkGatewayPayment(paymentId, provider) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);
    try {
      const response = await api.get(`/payments/${paymentId}/${provider}/verify`);
      setSuccess(
        response.data?.status === 'PAID'
          ? 'Payment confirmed by the gateway and reconciled.'
          : `Gateway reports this payment as ${response.data?.status || 'not yet completed'} — nothing to reconcile yet.`
      );
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check payment with the gateway');
    } finally {
      setActionLoading('');
    }
  }

  const decideRecovery = async (id, action) => {
    setActionLoading(`recovery-${action}-${id}`);
    setError('');
    setSuccess('');
    try {
      await api.patch(`/recovery-requests/admin/${id}/${action}`, action === 'approve' ? {} : {});
      setRecoveryRequests((items) => items.filter((item) => item.id !== id));
      setSuccess(action === 'approve' ? 'Recovery approved. The fresh service form was released; the goods order and payment records were not automatically cancelled.' : 'Recovery request rejected.');
    } catch (err) {
      setError(err.response?.data?.error || `Could not ${action} recovery request`);
    } finally {
      setActionLoading('');
    }
  };

  const reinstateProvider = async (userId, to, clearPenalty) => {
    setActionLoading(`standing-${userId}-${to}`);
    setError('');
    setSuccess('');
    try {
      const note = window.prompt('Optional note for the audit trail (why are you reinstating?)') || undefined;
      await api.post(`/admin/provider-standings/${userId}/reinstate`, { to, clearPenalty, note });
      setProviderStandings((items) => items.filter((item) => item.userId !== userId || to === 'PROBATION'));
      setSuccess(to === 'GOOD' ? 'Provider restored to good standing.' : 'Provider reinstated on probation.');
      const res = await api.get('/admin/provider-standings');
      setProviderStandings(res.data?.standings || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reinstate provider');
    } finally {
      setActionLoading('');
    }
  };

  const approveReleaseReview = async (id) => {
    setActionLoading(`release-review-${id}`);
    setError('');
    setSuccess('');
    try {
      await api.post(`/admin/release-reviews/${id}/approve`);
      setReleaseReviews((items) => items.filter((item) => item.id !== id));
      setSuccess('One additional release approved for that job. The requester can try again.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not approve release review');
    } finally {
      setActionLoading('');
    }
  };

  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase();
    if (!search) return users;
    return users.filter((item) => {
      const searchableText = [
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
        .toLowerCase();
      return searchableText.includes(search);
    });
  }, [users, userSearch]);

  const openDisputes = disputes.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');
  const resolvedDisputes = disputes.filter((d) => d.status !== 'OPEN' && d.status !== 'UNDER_REVIEW');

  const pendingAds = ads.filter(
    (a) =>
      a.status === 'PAID_PENDING_REVIEW' ||
      (a.status === 'PENDING' && ['BANNER', 'TELEGRAM_PROMOTION'].includes(a.type))
  );

  const reviewedAds = ads.filter((a) => !pendingAds.some((pending) => pending.id === a.id));

  const pendingRefunds = refunds.filter((r) => ['REQUESTED', 'PROCESSING'].includes(r.status));
  const refundHistory = refunds.filter((r) => !['REQUESTED', 'PROCESSING'].includes(r.status));

  const tabItems = [
    { key: 'overview', label: 'Overview', count: 0 },
    { key: 'users', label: 'Users & Control', count: 0 },
    { key: 'disputes', label: 'Disputes', count: openDisputes.length },
    { key: 'fraud', label: 'Fraud Monitoring', count: suspiciousUsers.length },
    { key: 'advertising', label: 'Advertising', count: pendingAds.length },
    { key: 'recovery', label: 'Workflow Recovery', count: recoveryRequests.length + releaseReviews.length + providerStandings.filter((p) => p.status === 'SUSPENDED' && p.appealedAt).length },
    { key: 'orders', label: 'Orders', count: orders.length },
    { key: 'refunds', label: 'Refunds', count: pendingRefunds.length },
    { key: 'arrivals', label: 'Inspector Arrivals', count: disputedArrivals },
    { key: 'operations', label: 'Operations & Audit', count: (operations?.queues?.reconciliationPayments || 0) + (operations?.queues?.openDisputes || 0) },
  ];

  const activeTabItem = tabItems.find((item) => item.key === tab) || tabItems[0];
  // Badge on the closed menu: alerts from queues that need action (not plain record counts).
  const totalTabAlerts = tabItems
    .filter((item) => !['overview', 'orders'].includes(item.key))
    .reduce((sum, item) => sum + (item.count || 0), 0);

  // Queues shown in the overview card. Counts reuse the tab badges so the two always agree.
  const tabCount = (key) => tabItems.find((item) => item.key === key)?.count || 0;
  const adminQueues = [
    { key: 'disputes', label: 'Open disputes', count: tabCount('disputes'), tab: 'disputes', tone: 'danger' },
    { key: 'reconcile', label: 'Payments to reconcile', count: operations?.queues?.reconciliationPayments || 0, tab: 'operations', tone: 'danger' },
    { key: 'refunds', label: 'Refunds to process', count: tabCount('refunds'), tab: 'refunds', tone: 'wait' },
    { key: 'ads', label: 'Ads waiting for review', count: tabCount('advertising'), tab: 'advertising', tone: 'wait' },
    { key: 'verify', label: 'Users awaiting verification', count: users.filter((u) => u.verificationStatus === 'PENDING').length, tab: 'users', tone: 'info' },
    { key: 'recovery', label: 'Recovery and release reviews', count: tabCount('recovery'), tab: 'recovery', tone: 'info' },
    { key: 'fraud', label: 'Suspicious accounts', count: tabCount('fraud'), tab: 'fraud', tone: 'accent' },
    { key: 'arrivals', label: 'Inspector arrival disputes', count: tabCount('arrivals'), tab: 'arrivals', tone: 'accent' },
  ];

  if (loading && !overview) {
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
              <div className="ac-shield">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
                  <path d="M9.5 12l1.7 1.7 3.5-3.7" />
                </svg>
              </div>
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
            Admin actions on MarketBridge now require multi-factor authentication.
            This takes about a minute with an authenticator app such as Google Authenticator or Authy.
          </p>
          <div className="ac-actions" style={{ justifyContent: 'center' }}>
            <Link to="/account/security" className="sd-btn sd-btn-primary">Set up MFA</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sd-dashboard admin-control-center">

      <section className="ac-section">
        <header className="ac-hero ac-hero--compact">
          <div className="ac-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
              <path d="M9.5 12l1.7 1.7 3.5-3.7" />
            </svg>
          </div>
          <div className="ac-hero-text">
            <span className="ac-kicker">MARKETBRIDGE ADMIN</span>
            <h1>Control Center</h1>
          </div>
          <div className="ac-hero-actions">
            <RoleSwitchCTA current="ADMIN" />
            <Link to="/account/security" className="sd-btn">Security</Link>
          </div>
        </header>
      </section>

      <dialog ref={disputeModalRef} className="ac-dialog" onClose={() => setDisputeDecision(null)}>
        <div className="ac-modal">
          <button type="button" className="ac-close" onClick={closeDisputeDecision} aria-label="Close">×</button>
          <span className="ac-section-label">MODERATION</span>
          <h2>
            {disputeDecision?.resolutionType === 'DISMISSED' && 'Dismiss claim'}
            {disputeDecision?.resolutionType === 'CANCEL_SERVICE' && 'Cancel disputed service only'}
            {disputeDecision?.resolutionType === 'CANCEL_ORDER' && 'Cancel whole order'}
          </h2>

          {disputeDecision && (
            <>
              <p className="sd-muted">
                The dispute froze the whole order. Choose how to release it.
              </p>

              <div className="sd-form-grid" style={{ marginTop: 15 }}>
                <div className="sd-full">
                  <label>Resolution notes</label>
                  <textarea
                    rows={3}
                    value={disputeDecision.resolution}
                    onChange={(e) =>
                      setDisputeDecision((d) => ({ ...d, resolution: e.target.value }))
                    }
                  />
                </div>

                <div className="sd-full">
                  <span className="ac-section-label">Outcome</span>
                  {disputeDecision.resolutionType === 'DISMISSED' && (
                    <p className="sd-muted" style={{ marginTop: 4 }}>
                      The order is restored to its pre-dispute status. No service is cancelled
                      and no refund is created. Frozen payouts resume their 3-day hold.
                    </p>
                  )}
                  {disputeDecision.resolutionType === 'CANCEL_SERVICE' && (
                    <p className="sd-muted" style={{ marginTop: 4 }}>
                      Only the disputed {disputeDecision.affectedService.toLowerCase()} is cancelled.
                      Its paid amount is refunded through Chapa. The rest of the order continues —
                      the buyer can open a fresh competition for that service right away.
                    </p>
                  )}
                  {disputeDecision.resolutionType === 'CANCEL_ORDER' && (
                    <p className="sd-muted" style={{ marginTop: 4 }}>
                      The whole order is cancelled. Every settled payment is queued for refund.
                      This is terminal — no recovery is possible.
                    </p>
                  )}
                </div>
              </div>

              <div className="ac-modal-actions">
                <button
                  type="button"
                  className="sd-btn sd-btn-primary"
                  disabled={actionLoading === `dispute-${disputeDecision.id}`}
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
        <div className="ac-tabs-shell" ref={tabsNavRef}>
          <button
            type="button"
            className={`ac-menu-trigger ac-fab ${tabMenuOpen ? 'open' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={tabMenuOpen}
            aria-label={`Admin sections, current: ${activeTabItem.label}`}
            title={activeTabItem.label}
            onClick={() => setTabMenuOpen((open) => !open)}
          >
            {tabMenuOpen ? (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
                <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
                <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
                <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
              </svg>
            )}
            {totalTabAlerts > 0 && !tabMenuOpen && (
              <span className="ac-fab-badge" title="Items needing attention">{totalTabAlerts}</span>
            )}
          </button>
          {tabMenuOpen && (
            <ul className="ac-menu-list" role="listbox" aria-label="Admin sections">
              {tabItems.map((item) => (
                <li key={item.key} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={tab === item.key}
                    className={`ac-menu-item ${tab === item.key ? 'active' : ''}`}
                    onClick={() => {
                      clearMessages();
                      setTab(item.key);
                      setTabMenuOpen(false);
                    }}
                  >
                    <span>{item.label}</span>
                    {item.count > 0 && <span className="ac-tab-count">{item.count}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {tab === 'overview' && (
          <AdminOverview
            overview={overview}
            commission={commissionSummary}
            operations={operations}
            queues={adminQueues}
            onOpenTab={(key) => { clearMessages(); setTab(key); setTabMenuOpen(false); }}
          />
        )}

        {tab === 'users' && (
          <div className="ac-panel">
            <div className="ac-toolbar">
              <div>
                <span className="ac-section-label">ACCESS MANAGEMENT</span>
                <h2>Users & account control</h2>
                <p>Search users, manage verification, activate or suspend accounts, and manage marketplace roles.</p>
              </div>
              <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

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

            <ul className="ac-user-list">
              {filteredUsers.map((item) => {
                const isActionLoading = actionLoading.includes(item.id);
                const status = item.accountStatus || 'ACTIVE';
                return (
                  <li key={item.id}>
                    <article className="ac-user">
                      <header className="ac-user-head">
                        <span className="ac-user-main">
                          <strong>{item.name}</strong>
                        </span>
                        <span className={statusBadgeClass(status)}>{status}</span>
                      </header>

                      <div className="ac-user-body">
                        <dl className="ac-user-facts">
                          <dt>Email</dt><dd>{item.email || '—'}</dd>
                          {item.phone && (<><dt>Phone</dt><dd>{item.phone}</dd></>)}
                          {item.location && (<><dt>Location</dt><dd>{item.location}</dd></>)}
                          <dt>Rating</dt><dd>{Number(item.rating || 0).toFixed(1)}</dd>
                        </dl>

                        <div className="ac-user-field">
                          <span className="ac-field-label">Roles</span>
                          <div className="sd-chip-row ac-wrap">
                            {(item.roles || []).map((role) => (
                              <span className="sd-badge" key={role}>{role}</span>
                            ))}
                          </div>
                        </div>

                        <label className="ac-user-field">
                          <span className="ac-field-label">Verification</span>
                          <select
                            value={item.verificationStatus || 'UNVERIFIED'}
                            onChange={(e) => setVerification(item.id, e.target.value)}
                            disabled={isActionLoading}
                          >
                            <option value="UNVERIFIED">UNVERIFIED</option>
                            {VERIFICATION_OPTIONS.map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                        </label>

                        <div className="ac-user-field">
                          <span className="ac-field-label">Role control</span>
                          <div className="ac-role-row">
                            <select
                              value={roleSelections[item.id] || ''}
                              onChange={(e) =>
                                setRoleSelections((current) => ({ ...current, [item.id]: e.target.value }))
                              }
                              disabled={isActionLoading}
                              aria-label="Role to add"
                            >
                              <option value="">Select role...</option>
                              {ROLE_OPTIONS.map((role) => (
                                <option key={role} value={role}>{role}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              disabled={isActionLoading || !roleSelections[item.id]}
                              onClick={() => addRole(item.id)}
                            >
                              Add
                            </button>
                          </div>
                          {(item.roles || []).length > 0 && (
                            <div className="sd-chip-row ac-wrap">
                              {item.roles.map((role) => (
                                <button
                                  type="button"
                                  key={role}
                                  className="sd-btn sd-btn-outline"
                                  disabled={isActionLoading}
                                  onClick={() => removeRole(item.id, role)}
                                  title={`Remove ${role}`}
                                >
                                  Remove {role}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="ac-user-field">
                          {item.accountStatus === 'SUSPENDED' ? (
                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              disabled={isActionLoading}
                              onClick={() => setAccountStatus(item.id, 'ACTIVE')}
                            >
                              {isActionLoading ? 'Working…' : 'Activate account'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="sd-btn sd-btn-outline"
                              disabled={isActionLoading}
                              onClick={() => setAccountStatus(item.id, 'SUSPENDED')}
                            >
                              {isActionLoading ? 'Working…' : 'Suspend account'}
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  </li>
                );
              })}
              {filteredUsers.length === 0 && (
                <li>
                  <div className="ac-empty">
                    <strong>No users found</strong>
                    Try a different name, email, role, or status.
                  </div>
                </li>
              )}
            </ul>
          </div>
        )}

        {tab === 'disputes' && (
          <div>
            <div className="ac-toolbar">
              <div>
                <span className="ac-section-label">MODERATION</span>
                <h2>Open disputes</h2>
                <p>
                  Review unresolved marketplace disputes. Choose the outcome that matches the claim —
                  dismissing, cancelling only the disputed service, or cancelling the whole order.
                </p>
              </div>
            </div>

            <div className="ac-grid">
              {openDisputes.map((item) => {
                const affectedService = disputeAffectedService(item);
                const canCancelService = affectedService !== 'GOODS';
                return (
                  <div className="ac-card" key={item.id}>
                    <div className="ac-status-row">
                      <h3>{item.disputeType}</h3>
                      <span className={statusBadgeClass(item.status)}>{item.status}</span>
                    </div>

                    <p>
                      {item.raisedBy?.name}
                      {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs{' '}
                      {item.against?.name}
                      {item.againstRole ? ` (${item.againstRole})` : ''}
                    </p>

                    <p>{item.description}</p>

                    <p className="sd-muted" style={{ fontSize: 12 }}>
                      Affected service: <strong>{affectedService}</strong>
                    </p>

                    <div className="ac-actions">
                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={actionLoading === `dispute-${item.id}`}
                        onClick={() => openDisputeDecision(item, 'DISMISSED')}
                      >
                        Dismiss claim
                      </button>

                      {canCancelService && (
                        <button
                          type="button"
                          className="sd-btn sd-btn-primary"
                          disabled={actionLoading === `dispute-${item.id}`}
                          onClick={() => openDisputeDecision(item, 'CANCEL_SERVICE')}
                        >
                          Cancel disputed service only
                        </button>
                      )}

                      <button
                        type="button"
                        className="sd-btn sd-btn-outline sd-btn-danger"
                        disabled={actionLoading === `dispute-${item.id}`}
                        onClick={() => openDisputeDecision(item, 'CANCEL_ORDER')}
                      >
                        Cancel whole order
                      </button>
                    </div>
                  </div>
                );
              })}

              {openDisputes.length === 0 && (
                <div className="ac-empty">
                  <strong>No open disputes</strong>
                  The moderation queue is clear.
                </div>
              )}
            </div>

            <div className="ac-toolbar" style={{ marginTop: 28 }}>
              <div>
                <span className="ac-section-label">HISTORY</span>
                <h2>Recently resolved</h2>
              </div>
            </div>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Parties</th>
                      <th>Resolution</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedDisputes.slice(0, 10).map((item) => (
                      <tr key={item.id}>
                        <td data-label="Type"><strong>{item.disputeType}</strong></td>
                        <td data-label="Parties" className="sd-muted">
                          {item.raisedBy?.name}
                          {item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs{' '}
                          {item.against?.name}
                          {item.againstRole ? ` (${item.againstRole})` : ''}
                        </td>
                        <td data-label="Resolution" className="sd-muted">
                          {item.resolutionType || '—'}
                        </td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(item.status)}>{item.status}</span>
                        </td>
                      </tr>
                    ))}
                    {resolvedDisputes.length === 0 && (
                      <tr>
                        <td colSpan="4" className="sd-muted">Nothing resolved yet.</td>
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
            <div className="ac-toolbar">
              <div>
                <span className="ac-section-label">RISK MONITORING</span>
                <h2>Flagged users</h2>
                <p>Users with multiple open disputes filed against them. This is a starting heuristic — not a conclusive fraud finding.</p>
              </div>
            </div>
            <div className="ac-grid">
              {suspiciousUsers.map((item) => (
                <div className="ac-card" key={item.id}>
                  <div className="ac-status-row">
                    <h3>{item.name}</h3>
                    <span className="sd-badge sd-warn">REVIEW</span>
                  </div>
                  <p>{item.email} · {(item.disputesAgainst || []).length} open dispute(s)</p>
                  {(item.disputesAgainst || []).map((dispute) => (
                    <p key={dispute.id}>— {dispute.disputeType}: {dispute.description}</p>
                  ))}
                </div>
              ))}
              {suspiciousUsers.length === 0 && (
                <div className="ac-empty">
                  <strong>No flagged users</strong>
                  No heuristic fraud signals are currently in the monitoring queue.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'advertising' && (
          <div>
            <div className="ac-toolbar">
              <div>
                <span className="ac-section-label">ADVERTISING</span>
                <h2>Campaign control</h2>
                <p>Review paid creative, publish approved campaigns, record Telegram publication, and end campaigns early when necessary.</p>
              </div>
            </div>

            <div className="ac-grid">
              {pendingAds.map((ad) => {
                const adPaid = (ad.payments || []).some((p) => p.status === 'PAID');
                const impressions = (ad.events || []).filter((e) => e.eventType === 'IMPRESSION').length;
                const clicks = (ad.events || []).filter((e) => e.eventType === 'CLICK').length;
                const ctr = impressions ? ((clicks / impressions) * 100).toFixed(2) : '0.00';
                return (
                  <div className="ac-card" key={ad.id}>
                    {ad.creativeImageUrl && (
                      <img src={ad.creativeImageUrl} alt={ad.headline || 'Campaign creative'} loading="lazy" decoding="async" className="ac-image" />
                    )}
                    <div className="ac-status-row">
                      <h3>{ad.type.replace(/_/g, ' ')}</h3>
                      <span className={statusBadgeClass(ad.status)}>{ad.status}</span>
                    </div>
                    {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramImageUrls?.length > 0 && (
                      <ImageCarousel images={ad.telegramImageUrls} alt={ad.headline || 'Carousel photo'} openLinks className="img-carousel--compact" />
                    )}
                    {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramTemplate && (
                      <p>
                        <strong>Template:</strong> {ad.telegramTemplate.replace(/_/g, ' ')}
                        {ad.telegramImageCount > 0 ? ` · ${ad.telegramImageCount} photos` : ''}
                      </p>
                    )}
                    {ad.headline && <p><strong>{ad.headline}</strong></p>}
                    <p>
                      <strong>Ref:</strong> {ad.campaignReference || ad.id.slice(0, 8)} ·{' '}
                      <strong>Advertiser:</strong> {ad.advertiser?.name} ({ad.advertiser?.email})
                    </p>
                    <p>
                      {ad.listing ? (<>Featuring <strong>{ad.listing.title || ad.listing.cropType}</strong> · </>) : 'Platform-wide · '}
                      {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                    </p>
                    <div className="ac-financial">
                      <div className="ac-financial-item">
                        <span>Quoted</span>
                        <b>{Number(ad.priceQuoted || 0).toLocaleString()} {ad.currency || 'ETB'}</b>
                      </div>
                      <div className="ac-financial-item">
                        <span>Paid</span>
                        <b>{adPaid ? Number(ad.amountPaid || 0).toLocaleString() : '0'} {ad.currency || 'ETB'}</b>
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
                        type="button"
                        className="sd-btn sd-btn-primary"
                        disabled={actionLoading === `ad-${ad.id}` || !adPaid}
                        title={!adPaid ? 'Waiting for payment' : undefined}
                        onClick={() => setAdStatus(ad.id, 'APPROVED')}
                      >
                        {actionLoading === `ad-${ad.id}` ? 'Working…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={actionLoading === `ad-${ad.id}`}
                        onClick={() => setAdStatus(ad.id, 'REJECTED')}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
              {pendingAds.length === 0 && (
                <div className="ac-empty">
                  <strong>No campaigns waiting</strong>
                  There are no campaigns waiting on content review.
                </div>
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
                      const impressions = (ad.events || []).filter((e) => e.eventType === 'IMPRESSION').length;
                      const clicks = (ad.events || []).filter((e) => e.eventType === 'CLICK').length;
                      const ctr = impressions ? ((clicks / impressions) * 100).toFixed(2) : '0.00';
                      return (
                        <tr key={ad.id}>
                          <td data-label="Campaign">
                            <strong>{ad.campaignReference || ad.type.replace(/_/g, ' ')}</strong>
                            <br />
                            <span className="sd-muted">{ad.type.replace(/_/g, ' ')}</span>
                            {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramImageUrls?.length > 0 && (
                              <details className="tg-ledger-photos">
                                <summary>🎠 {ad.telegramImageUrls.length} carousel photos</summary>
                                <ImageCarousel images={ad.telegramImageUrls} alt={ad.headline || 'Carousel photo'} openLinks className="img-carousel--compact" />
                              </details>
                            )}
                          </td>
                          <td data-label="Advertiser" className="sd-muted">{ad.advertiser?.name}</td>
                          <td data-label="Dates" className="sd-muted">
                            {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                          </td>
                          <td data-label="Financials" className="sd-muted">
                            {Number(ad.priceQuoted || 0).toLocaleString()} {ad.currency || 'ETB'} quoted
                            <br />
                            {Number(ad.amountPaid || 0).toLocaleString()} paid
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
                                  type="button"
                                  className="sd-btn sd-btn-outline"
                                  disabled={actionLoading === `ad-${ad.id}`}
                                  onClick={() => setAdStatus(ad.id, 'EXPIRED')}
                                >
                                  {actionLoading === `ad-${ad.id}` ? 'Working…' : 'End early'}
                                </button>
                              )}
                              {['PAID_PENDING_REVIEW', 'APPROVED', 'SCHEDULED'].includes(ad.status) && (
                                <button
                                  type="button"
                                  className="sd-btn sd-btn-outline"
                                  disabled={actionLoading === `ad-${ad.id}`}
                                  onClick={() => cancelAdCampaign(ad.id)}
                                >
                                  {actionLoading === `ad-${ad.id}` ? 'Working…' : 'Cancel & refund'}
                                </button>
                              )}
                              {ad.type === 'TELEGRAM_PROMOTION' && ['APPROVED', 'SCHEDULED'].includes(ad.status) && (
                                <button
                                  type="button"
                                  className="sd-btn sd-btn-primary"
                                  disabled={actionLoading === `ad-${ad.id}`}
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
                        <td colSpan="7" className="sd-muted">No reviewed campaigns yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'recovery' && (
          <section className="ac-panel">
            <div className="ac-panel-header">
              <div>
                <span className="ac-section-label">ADMIN APPROVAL QUEUE</span>
                <h2>Workflow recovery requests</h2>
                <p className="sd-muted">
                  Review the reason, service status and payment/refund state before deciding. Approving
                  recovery releases a fresh form for the affected service only; it does not cancel the
                  goods order or mark the replacement provider as paid. Resolve disputes and approve
                  service cancellations through their separate decision workflow.
                </p>
              </div>
            </div>
            {recoveryRequests.length === 0 ? (
              <div className="ac-empty">No workflow recovery requests are waiting for approval.</div>
            ) : (
              <div className="ac-table-shell">
                <table className="ac-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Order</th>
                      <th>Requested by</th>
                      <th>Release to</th>
                      <th>Reason</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recoveryRequests.map((item) => (
                      <tr key={item.id}>
                        <td><strong>{item.type}</strong></td>
                        <td>
                          #{item.order?.id?.slice(0, 8)}
                          <div className="sd-muted">{item.order?.listing?.title || item.order?.listing?.cropType || 'Order'}</div>
                        </td>
                        <td>
                          {item.requestedBy?.name || '—'}
                          <div className="sd-muted">{item.requestedBy?.email || ''}</div>
                        </td>
                        <td>{(item.targetParties || []).join(', ')}</td>
                        <td>{item.reason || 'No reason supplied'}</td>
                        <td>
                          <div className="ac-actions">
                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              disabled={Boolean(actionLoading)}
                              onClick={() => decideRecovery(item.id, 'approve')}
                            >
                              {actionLoading === `recovery-approve-${item.id}` ? 'Approving…' : 'Approve fresh service form'}
                            </button>
                            <button
                              type="button"
                              className="sd-btn"
                              disabled={Boolean(actionLoading)}
                              onClick={() => decideRecovery(item.id, 'reject')}
                            >
                              {actionLoading === `recovery-reject-${item.id}` ? 'Rejecting…' : 'Reject'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === 'recovery' && (
          <section className="ac-panel">
            <div className="ac-panel-header">
              <div>
                <span className="ac-section-label">RELEASE LIMIT REVIEWS</span>
                <h2>Blocked provider releases</h2>
                <p className="sd-muted">
                  A requester reached the limit of 2 releases of an accepted transporter or inspector
                  on one job. Approving allows exactly one more release for that job. Every release and
                  approval is kept in the audit trail.
                </p>
              </div>
            </div>
            {releaseReviews.length === 0 ? (
              <div className="ac-empty">No release limit reviews are waiting.</div>
            ) : (
              <div className="ac-table-shell">
                <table className="ac-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Order</th>
                      <th>Requester</th>
                      <th>Attempted reason</th>
                      <th>Releases used</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {releaseReviews.map((item) => (
                      <tr key={item.id}>
                        <td><strong>{item.type}</strong></td>
                        <td>#{String(item.orderId || '').slice(0, 8) || '—'}</td>
                        <td>
                          {item.requester?.name || '—'}
                          <div className="sd-muted">{item.requester?.email || ''}</div>
                        </td>
                        <td>{item.attemptedReason || '—'}</td>
                        <td>{item.releasesUsed ?? '—'} / {item.limit ?? '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="sd-btn sd-btn-primary"
                            disabled={Boolean(actionLoading)}
                            onClick={() => approveReleaseReview(item.id)}
                          >
                            {actionLoading === `release-review-${item.id}` ? 'Approving…' : 'Allow one more release'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="ac-panel-header" style={{ marginTop: 24 }}>
              <div>
                <span className="ac-section-label">PROVIDER CANCELLATIONS</span>
                <h2>Frequent provider cancellations (30 days)</h2>
                <p className="sd-muted">
                  Truck owners and inspectors who cancelled several provisional agreements before
                  payment. No automatic penalty is applied; review and act through the user controls if needed.
                </p>
              </div>
            </div>
            {frequentProviders.length === 0 ? (
              <div className="ac-empty">No provider has repeatedly cancelled recently.</div>
            ) : (
              <div className="ac-table-shell">
                <table className="ac-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Cancellations</th>
                      <th>Reasons</th>
                      <th>Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {frequentProviders.map((row) => (
                      <tr key={row.provider?.id || row.lastAt}>
                        <td>
                          {row.provider?.name || '—'}
                          <div className="sd-muted">{row.provider?.email || ''}</div>
                        </td>
                        <td><strong>{row.count}</strong></td>
                        <td>{Object.entries(row.reasons || {}).map(([reason, n]) => `${reason} ×${n}`).join(', ')}</td>
                        <td>{row.lastAt ? new Date(row.lastAt).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="ac-panel-header" style={{ marginTop: 24 }}>
              <div>
                <span className="ac-section-label">PROVIDER STANDINGS</span>
                <h2>Suspensions, appeals and probation</h2>
                <p className="sd-muted">
                  Automatic: rating -0.1 per cancellation; 3 cancellations in 30 days suspends bidding
                  (3, 14, 30 days, then until admin review); a cancellation on probation suspends
                  immediately. Providers rejoin on 30-day probation after acknowledging the rules.
                  You can reinstate early below.
                </p>
              </div>
            </div>
            {providerStandings.length === 0 ? (
              <div className="ac-empty">No provider is suspended or on probation.</div>
            ) : (
              <div className="ac-table-shell">
                <table className="ac-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Suspensions</th>
                      <th>Until</th>
                      <th>Rating penalty</th>
                      <th>Appeal</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerStandings.map((row) => {
                      const suspended = row.status === 'SUSPENDED' || row.status === 'REJOIN_PENDING';
                      return (
                        <tr key={row.id}>
                          <td>
                            {row.user?.name || '—'}
                            <div className="sd-muted">{row.user?.email || ''}</div>
                          </td>
                          <td>
                            <strong>{row.status}</strong>
                            <div className="sd-muted">{row.lastReason || ''}</div>
                          </td>
                          <td>{row.suspensionCount}</td>
                          <td>
                            {row.status === 'PROBATION'
                              ? (row.probationUntil ? new Date(row.probationUntil).toLocaleDateString() : '—')
                              : (row.suspendedUntil ? new Date(row.suspendedUntil).toLocaleString() : 'Until admin review')}
                          </td>
                          <td>-{Number(row.ratingPenalty || 0).toFixed(1)}</td>
                          <td>{row.appealMessage || '—'}</td>
                          <td>
                            {suspended ? (
                              <div className="ac-actions">
                                <button
                                  type="button"
                                  className="sd-btn sd-btn-primary"
                                  disabled={Boolean(actionLoading)}
                                  onClick={() => reinstateProvider(row.userId, 'PROBATION', false)}
                                >
                                  Reinstate on probation
                                </button>
                                <button
                                  type="button"
                                  className="sd-btn"
                                  disabled={Boolean(actionLoading)}
                                  onClick={() => reinstateProvider(row.userId, 'GOOD', true)}
                                >
                                  Clear fully
                                </button>
                              </div>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === 'orders' && (
          <div>
            <div className="ac-toolbar">
              <div>
                <span className="ac-section-label">ORDERS</span>
                <h2>All orders</h2>
                <p>
                  Cancelling here is an admin override for stalled orders. It is blocked once a transport
                  job has started pickup, since goods already in motion need a dispute instead.
                </p>
              </div>
            </div>

            <div className="ac-panel">
              <div className="ac-table-shell">
                <table className="sd-table sd-table--stack">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>Order</th>
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
                      const cancellable =
                        !['COMPLETED', 'CANCELLED'].includes(o.status) && !transportInMotion;
                      return (
                        <tr key={o.id} data-section="Order details">
                          <td data-label="Listing" data-eyebrow="Order">{o.listing?.title || o.listing?.cropType || '—'}</td>
                          <td data-label="Order"><span className="ac-code">{o.id.slice(0, 8)}</span></td>
                          <td data-label="Buyer">{o.buyer?.name || '—'}</td>
                          <td data-label="Seller">{o.seller?.name || '—'}</td>
                          <td data-label="Value">{Number(o.finalPrice).toLocaleString()} ETB</td>
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
                        <td colSpan="7" className="sd-muted">No orders yet.</td>
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
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">FINANCIAL REFUNDS</span>
                  <h2>Chapa refund queue</h2>
                  <p>
                    Refunds are submitted to Chapa automatically. A refund is not marked completed until
                    Chapa reports the final <strong>refunded</strong> state.
                  </p>
                </div>
                <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <div className="ac-stat-strip">
                <div className="ac-small-stat"><span>Awaiting submission</span><strong>{refunds.filter((r) => r.status === 'REQUESTED').length}</strong></div>
                <div className="ac-small-stat"><span>Processing at Chapa</span><strong>{refunds.filter((r) => r.status === 'PROCESSING').length}</strong></div>
                <div className="ac-small-stat"><span>Completed</span><strong>{refunds.filter((r) => r.status === 'COMPLETED').length}</strong></div>
                <div className="ac-small-stat"><span>Failed / reversed</span><strong>{refunds.filter((r) => r.status === 'FAILED').length}</strong></div>
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
                        <td data-label="Refund"><span className="ac-code">{refund.id.slice(0, 8)}</span></td>
                        <td data-label="Payment"><span className="ac-code">{refund.paymentId.slice(0, 8)}</span></td>
                        <td data-label="Amount">{Number(refund.amount).toLocaleString()} {refund.currency || 'ETB'}</td>
                        <td data-label="Provider">{refund.provider || refund.payment?.provider || '—'}</td>
                        <td data-label="Status"><span className={statusBadgeClass(refund.status)}>{refund.status}</span></td>
                        <td data-label="Chapa refund ID">
                          <span className="ac-code">{refund.providerRefundId ? refund.providerRefundId.slice(0, 18) : '—'}</span>
                        </td>
                        <td data-label="Chapa tx ref (admin)">
                          {refund.payment?.chapaTxRef ? (
                            <span className="ac-code">{refund.payment.chapaTxRef}</span>
                          ) : (
                            <>
                              <span className={statusBadgeClass('FAILED')}>missing</span>
                              {refund.payment?.providerTransactionId && (
                                <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                                  providerTransactionId: <span className="ac-code">{refund.payment.providerTransactionId}</span>
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td data-label="Actions">
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
                              <span className="sd-muted" style={{ fontSize: 12 }}>Auto-checking with Chapa…</span>
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
                        <td colSpan="8" className="sd-muted">No refunds recorded.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'arrivals' && <AdminInspectionArrivals onCount={setDisputedArrivals} />}

        {tab === 'operations' && (
          <div>
            <div className="ac-panel">
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">SYSTEM OPERATIONS</span>
                  <h2>Operations & audit</h2>
                  <p>Monitor live workflow queues from durable OrderEvent records and review the internal audit trail.</p>
                </div>
                <button type="button" className="sd-btn sd-btn-outline" onClick={loadAll} disabled={loading}>
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

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
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">ORDER EVENTS</span>
                  <h2>Recent order events</h2>
                  <p className="sd-muted">Latest durable OrderEvent records emitted by the workflow engine.</p>
                </div>
              </div>
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
                        <td data-label="Event"><span className={statusBadgeClass(event.type)}>{event.type || '—'}</span></td>
                        <td data-label="Order"><span className="ac-code">{event.orderId ? event.orderId.slice(0, 8) : '—'}</span></td>
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
                      <tr><td colSpan="5" className="sd-muted">No order events recorded.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="ac-panel">
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">AUDIT TRAIL</span>
                  <h2>Admin audit log</h2>
                  <p className="sd-muted">Actions taken by admin users, most recent first.</p>
                </div>
              </div>
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
                        <td data-label="Action"><span className={statusBadgeClass(event.action)}>{event.action || '—'}</span></td>
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
                        <td data-label="Details">
                          {event.metadata ? JSON.stringify(event.metadata) : '—'}
                        </td>
                      </tr>
                    ))}
                    {auditEvents.length === 0 && (
                      <tr><td colSpan="5" className="sd-muted">No audit events recorded.</td></tr>
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
