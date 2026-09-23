import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';
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

const ADMIN_STYLES = `
  .admin-control-center {
    --ac-bg: #f5f7fb;
    --ac-surface: rgba(255,255,255,.94);
    --ac-surface-soft: #f8fafc;
    --ac-border: rgba(15,23,42,.09);
    --ac-border-strong: rgba(15,23,42,.14);
    --ac-text: #0f172a;
    --ac-muted: #64748b;
    --ac-primary: #166534;
    --ac-primary-2: #15803d;
    --ac-primary-soft: #ecfdf3;
    --ac-warning: #b45309;
    --ac-warning-soft: #fff7ed;
    --ac-danger: #b91c1c;
    --ac-danger-soft: #fef2f2;
    --ac-info: #1d4ed8;
    --ac-info-soft: #eff6ff;
    color: var(--ac-text);
  }

  .admin-control-center *,
  .admin-control-center *::before,
  .admin-control-center *::after {
    box-sizing: border-box;
  }

  .ac-hero {
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.7);
    border-radius: 28px;
    padding: 28px;
    margin-bottom: 22px;
    background:
      radial-gradient(circle at 92% 10%, rgba(34,197,94,.20), transparent 30%),
      radial-gradient(circle at 8% 100%, rgba(59,130,246,.11), transparent 30%),
      linear-gradient(135deg, #ffffff 0%, #f4f9f5 55%, #eef8f1 100%);
    box-shadow: 0 22px 60px rgba(15,23,42,.08);
  }

  .ac-hero::after {
    content: "";
    position: absolute;
    width: 180px;
    height: 180px;
    right: -70px;
    bottom: -90px;
    border-radius: 999px;
    background: rgba(34,197,94,.08);
    pointer-events: none;
  }

  .ac-hero-content {
    position: relative;
    z-index: 1;
  }

  .ac-brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    flex-wrap: wrap;
  }

  .ac-title-row {
    display: flex;
    align-items: flex-start;
    gap: 15px;
  }

  .ac-shield {
    width: 48px;
    height: 48px;
    flex: 0 0 48px;
    display: grid;
    place-items: center;
    border-radius: 15px;
    color: #fff;
    background: linear-gradient(145deg, #166534, #22c55e);
    box-shadow: 0 10px 25px rgba(22,101,52,.24);
  }

  .ac-shield svg {
    width: 24px;
    height: 24px;
  }

  .ac-kicker {
    display: block;
    margin-bottom: 5px;
    color: #15803d;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }

  .ac-hero h1 {
    margin: 0;
    font-size: clamp(25px, 4vw, 38px);
    line-height: 1.05;
    letter-spacing: -.035em;
  }

  .ac-subtitle {
    max-width: 760px;
    margin: 10px 0 0;
    color: var(--ac-muted);
    font-size: 14px;
    line-height: 1.65;
  }

  .ac-hero-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  .ac-cc-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid rgba(22,101,52,.14);
    border-radius: 999px;
    background: rgba(255,255,255,.72);
    color: #166534;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .03em;
    backdrop-filter: blur(12px);
  }

  .ac-cc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 4px rgba(34,197,94,.13);
  }

  .ac-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin: 18px 0 24px;
  }

  .ac-metric {
    min-width: 0;
    padding: 17px;
    border: 1px solid var(--ac-border);
    border-radius: 18px;
    background: var(--ac-surface);
    box-shadow: 0 10px 30px rgba(15,23,42,.045);
  }

  .ac-metric-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--ac-muted);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .09em;
    text-transform: uppercase;
  }

  .ac-metric-value {
    display: block;
    margin-top: 8px;
    font-size: 25px;
    line-height: 1.1;
    letter-spacing: -.025em;
  }

  .ac-metric-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
  }

  .ac-metric.warn .ac-metric-dot {
    background: #f59e0b;
  }

  .ac-metric.danger .ac-metric-dot {
    background: #ef4444;
  }

  .ac-tabs-shell {
    position: sticky;
    top: 10px;
    z-index: 20;
    margin-bottom: 22px;
  }

  .ac-tabs {
    display: flex;
    gap: 5px;
    overflow-x: auto;
    padding: 6px;
    border: 1px solid rgba(15,23,42,.08);
    border-radius: 18px;
    background: rgba(255,255,255,.90);
    box-shadow: 0 12px 35px rgba(15,23,42,.08);
    backdrop-filter: blur(18px);
    scrollbar-width: none;
  }

  .ac-tabs::-webkit-scrollbar {
    display: none;
  }

  .ac-tab {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 40px;
    padding: 9px 13px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: #64748b;
    font-size: 12px;
    font-weight: 750;
    cursor: pointer;
    transition: .18s ease;
    white-space: nowrap;
  }

  .ac-tab:hover {
    background: #f1f5f9;
    color: #0f172a;
  }

  .ac-tab.active {
    color: #fff;
    background: linear-gradient(135deg, #166534, #15803d);
    box-shadow: 0 7px 18px rgba(22,101,52,.20);
  }

  .ac-tab-count {
    min-width: 19px;
    height: 19px;
    display: inline-grid;
    place-items: center;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(15,23,42,.07);
    color: inherit;
    font-size: 10px;
    font-weight: 900;
  }

  .ac-tab.active .ac-tab-count {
    background: rgba(255,255,255,.20);
  }

  .ac-mobile-tab {
    display: none;
  }

  .ac-section {
    margin-bottom: 22px;
  }

  .ac-panel {
    padding: 22px;
    border: 1px solid var(--ac-border);
    border-radius: 22px;
    background: var(--ac-surface);
    box-shadow: 0 12px 35px rgba(15,23,42,.05);
  }

  .ac-panel + .ac-panel {
    margin-top: 18px;
  }

  .ac-panel-header,
  .ac-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
  }

  .ac-panel-header h2,
  .ac-toolbar h2 {
    margin: 0;
    font-size: 21px;
    letter-spacing: -.025em;
  }

  .ac-panel-header p,
  .ac-toolbar p {
    max-width: 780px;
    margin: 7px 0 0;
    color: var(--ac-muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .ac-section-label {
    display: block;
    margin-bottom: 5px;
    color: #15803d;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: .13em;
    text-transform: uppercase;
  }

  .ac-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 15px;
  }

  .ac-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 19px;
    border: 1px solid var(--ac-border);
    border-radius: 19px;
    background: linear-gradient(180deg, #fff, #fbfcfd);
    box-shadow: 0 8px 26px rgba(15,23,42,.045);
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
  }

  .ac-card:hover {
    transform: translateY(-2px);
    border-color: rgba(22,101,52,.16);
    box-shadow: 0 14px 34px rgba(15,23,42,.08);
  }

  .ac-card h3 {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 16px;
    letter-spacing: -.015em;
  }

  .ac-card p {
    margin: 8px 0 0;
    color: var(--ac-muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .ac-card p strong {
    color: var(--ac-text);
    font-weight: 650;
  }

  .ac-status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  .ac-status-row h3 {
    flex: 1 1 auto;
  }

  /* Pin the action row to the card's bottom edge so every card in a row
     lines its buttons up, regardless of how much body copy sits above. */
  .ac-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 15px;
    padding-top: 14px;
    border-top: 1px solid var(--ac-border);
  }

  .ac-card .ac-actions {
    margin-top: auto;
  }

  /* Buttons inside a card read as secondary, in-context actions, so they
     stay a step smaller than page-level buttons in the hero/toolbar. */
  .ac-actions .sd-btn {
    margin: 0;
    padding: 8px 14px;
    min-height: 36px;
    font-size: 12.5px;
    border-radius: 9px;
    flex: 0 0 auto;
  }

  .ac-search {
    position: relative;
    margin: 15px 0;
  }

  .ac-search input {
    width: 100%;
    min-height: 46px;
    padding: 0 15px 0 43px;
    border: 1px solid var(--ac-border-strong);
    border-radius: 14px;
    outline: none;
    background: #fff;
    color: var(--ac-text);
    transition: .18s ease;
  }

  .ac-search input:focus {
    border-color: rgba(22,101,52,.42);
    box-shadow: 0 0 0 4px rgba(34,197,94,.09);
  }

  .ac-search::before {
    content: "⌕";
    position: absolute;
    left: 16px;
    top: 50%;
    transform: translateY(-52%);
    color: #94a3b8;
    font-size: 20px;
    pointer-events: none;
  }

  .ac-empty {
    padding: 34px 20px;
    border: 1px dashed var(--ac-border-strong);
    border-radius: 17px;
    background: var(--ac-surface-soft);
    text-align: center;
    color: var(--ac-muted);
  }

  .ac-empty strong {
    display: block;
    margin-bottom: 5px;
    color: var(--ac-text);
  }

  .ac-module-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .ac-module {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 11px 13px;
    border: 1px solid var(--ac-border);
    border-radius: 13px;
    background: #fff;
    color: #334155;
    font-size: 13px;
  }

  .ac-module-icon {
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    background: var(--ac-primary-soft);
    color: #15803d;
    font-weight: 900;
  }

  .ac-module.off .ac-module-icon {
    background: #f1f5f9;
    color: #94a3b8;
  }

  .ac-module small {
    color: #94a3b8;
  }

  .ac-stat-strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 11px;
  }

  .ac-small-stat {
    padding: 14px;
    border: 1px solid var(--ac-border);
    border-radius: 15px;
    background: #fff;
  }

  .ac-small-stat span {
    display: block;
    color: var(--ac-muted);
    font-size: 9px;
    font-weight: 850;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .ac-small-stat b {
    display: block;
    margin-top: 7px;
    font-size: 20px;
  }

  .ac-table-shell {
    overflow-x: auto;
    border: 1px solid var(--ac-border);
    border-radius: 16px;
    background: #fff;
  }

  .ac-table-shell .sd-table {
    min-width: 860px;
  }

  .ac-image {
    width: 100%;
    max-height: 175px;
    margin-bottom: 11px;
    border-radius: 13px;
    object-fit: cover;
    border: 1px solid var(--ac-border);
  }

  .ac-media-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .ac-financial {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 13px;
  }

  .ac-financial-item {
    padding: 10px;
    border-radius: 12px;
    background: #f8fafc;
  }

  .ac-financial-item span {
    display: block;
    color: #94a3b8;
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .ac-financial-item b {
    display: block;
    margin-top: 3px;
    font-size: 13px;
  }

  .ac-alert {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 14px 16px;
    margin-bottom: 18px;
    border-radius: 15px;
    border: 1px solid;
    font-size: 13px;
    line-height: 1.5;
  }

  .ac-alert.error {
    color: #991b1b;
    background: var(--ac-danger-soft);
    border-color: #fecaca;
  }

  .ac-alert.success {
    color: #166534;
    background: var(--ac-primary-soft);
    border-color: #bbf7d0;
  }

  .ac-alert-icon {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(255,255,255,.65);
    font-weight: 900;
  }

  .ac-dialog {
    width: min(680px, calc(100vw - 28px));
    max-width: 680px;
    padding: 0;
    border: 0;
    border-radius: 24px;
    background: transparent;
    box-shadow: 0 30px 100px rgba(15,23,42,.28);
  }

  .ac-dialog::backdrop {
    background: rgba(15,23,42,.48);
    backdrop-filter: blur(5px);
  }

  .ac-modal {
    position: relative;
    padding: 26px;
    border: 1px solid rgba(255,255,255,.5);
    border-radius: 24px;
    background: #fff;
  }

  .ac-modal h2 {
    margin: 5px 0 0;
    font-size: 23px;
    letter-spacing: -.025em;
  }

  .ac-close {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 11px;
    background: #f1f5f9;
    color: #475569;
    font-size: 23px;
    cursor: pointer;
  }

  .ac-close:hover {
    background: #e2e8f0;
  }

  .ac-radio-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    margin-top: 8px;
    border: 1px solid var(--ac-border);
    border-radius: 13px;
    background: #f8fafc;
    font-size: 13px;
    line-height: 1.5;
  }

  .ac-radio-option input {
    margin-top: 3px;
  }

  .ac-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 18px;
  }

  .ac-mfa {
    max-width: 620px;
    margin: 40px auto;
    padding: 34px;
    text-align: center;
    border: 1px solid var(--ac-border);
    border-radius: 25px;
    background: #fff;
    box-shadow: 0 20px 60px rgba(15,23,42,.08);
  }

  .ac-mfa-icon {
    width: 64px;
    height: 64px;
    margin: 0 auto 17px;
    display: grid;
    place-items: center;
    border-radius: 20px;
    background: var(--ac-primary-soft);
    color: #15803d;
    font-size: 28px;
  }

  .ac-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
  }

  .ac-role-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ac-role-actions .sd-chip-row {
    margin-top: 2px;
  }

  @media (max-width: 1050px) {
    .ac-metrics {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .ac-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .ac-stat-strip {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (max-width: 760px) {
    .ac-hero {
      padding: 21px;
      border-radius: 21px;
    }

    .ac-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .ac-grid,
    .ac-module-list {
      grid-template-columns: 1fr;
    }

    .ac-panel {
      padding: 17px;
      border-radius: 18px;
    }

    .ac-toolbar,
    .ac-panel-header {
      flex-direction: column;
      align-items: stretch;
    }

    .ac-tabs-shell {
      position: static;
    }

    .ac-tabs {
      border-radius: 14px;
    }

    .ac-stat-strip,
    .ac-financial {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .ac-dialog {
      width: calc(100vw - 18px);
    }

    .ac-modal {
      padding: 21px;
    }
  }

  @media (max-width: 480px) {
    .ac-title-row {
      gap: 11px;
    }

    .ac-shield {
      width: 41px;
      height: 41px;
      flex-basis: 41px;
      border-radius: 13px;
    }

    .ac-hero h1 {
      font-size: 27px;
    }

    .ac-metrics {
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .ac-metric {
      padding: 13px;
      border-radius: 14px;
    }

    .ac-metric-value {
      font-size: 19px;
    }

    .ac-small-stat {
      padding: 11px;
    }

    .ac-stat-strip {
      grid-template-columns: 1fr 1fr;
    }

    .ac-hero-actions,
    .ac-actions {
      align-items: stretch;
    }

    .ac-hero-actions .sd-btn,
    .ac-actions .sd-btn {
      flex: 1 1 auto;
      min-width: calc(50% - 4px);
    }
  }
`;

export default function AdminDashboard() {
  const { user } = useAuth();

  const [tab, setTab] = useState('overview');
  const [tabMenuOpen, setTabMenuOpen] = useState(false);

  const performanceModalRef = useRef(null);
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
    } catch (err) {
      if (err.response?.data?.code === 'MFA_SETUP_REQUIRED') {
        setMfaRequired(true);
      } else {
        setError(
          err.response?.data?.error ||
          'Could not load admin data'
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Any refund stuck at PROCESSING is picked up automatically in the
  // background. Chapa's webhook usually finalizes it first; this polling
  // loop is the fallback, so no admin ever has to click a "check status"
  // button. It only re-fetches the refunds queue (not the whole
  // dashboard) and stops itself once nothing is PROCESSING.
  useEffect(() => {
    const pending = refunds.filter((r) => r.status === 'PROCESSING');
    if (pending.length === 0) return undefined;

    let cancelled = false;

    const poll = async () => {
      for (const refund of pending) {
        try {
          await api.post(`/admin/financial/refunds/${refund.id}/verify`);
        } catch {
          // Silent background check — a real problem surfaces next time
          // an admin looks at the refund row itself.
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
    if (
      [
        'VERIFIED',
        'ACTIVE',
        'APPROVED',
        'PUBLISHED',
        'SCHEDULED',
        'RESOLVED',
        'COMPLETED',
      ].includes(status)
    ) {
      return 'sd-badge sd-good';
    }

    if (
      [
        'REJECTED',
        'SUSPENDED',
        'CANCELLED',
        'FAILED',
      ].includes(status)
    ) {
      return 'sd-badge sd-red';
    }

    if (
      [
        'PENDING',
        'PENDING_PAYMENT',
        'PAID_PENDING_REVIEW',
        'EXPIRED',
        'REQUESTED',
        'PROCESSING',
      ].includes(status)
    ) {
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

    const {
      id,
      status,
      resolution,
      payoutDecision,
    } = disputeDecision;

    clearMessages();
    setActionLoading(`dispute-${id}`);

    try {
      await api.patch(`/disputes/${id}/resolve`, {
        status,
        resolution,
        payoutDecision: payoutDecision || undefined,
      });

      setSuccess(`Dispute ${status.toLowerCase()} successfully.`);
      closeDisputeDecision();
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

    const failureReason =
      window.prompt('Reason the refund failed:');

    if (!failureReason) return;

    setActionLoading(`refund-${refund.id}`);

    try {
      await api.patch(
        `/admin/financial/refunds/${refund.id}/fail`,
        { failureReason }
      );

      setSuccess('Refund marked as failed.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not update refund'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function cancelOrder(order) {
    clearMessages();

    const confirmed = window.confirm(
      `Cancel order ${order.id.slice(
        0,
        8
      )}? This cannot be undone. The listing becomes available again and any completed payments are flagged for refund.`
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
      const message =
        err.response?.data?.error ||
        'Could not cancel order';

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
      await api.patch(
        `/admin/users/${userId}/verify`,
        { verificationStatus }
      );

      setSuccess(
        'Verification status updated successfully.'
      );

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

    const targetUser = users.find(
      (item) => item.id === userId
    );

    if (!targetUser) return;

    const action =
      accountStatus === 'SUSPENDED'
        ? 'suspend'
        : 'activate';

    const confirmed = window.confirm(
      `Are you sure you want to ${action} ${
        targetUser.name || targetUser.email
      }?`
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

    const targetUser = users.find(
      (item) => item.id === userId
    );

    if (!targetUser) return;

    const confirmed = window.confirm(
      `Remove ${role} role from ${
        targetUser.name || targetUser.email
      }?`
    );

    if (!confirmed) return;

    setActionLoading(
      `remove-role-${userId}-${role}`
    );

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

  async function markTelegramPublished(adId) {
    clearMessages();

    const postReference =
      window.prompt(
        'Telegram post reference/link (optional):'
      ) || undefined;

    setActionLoading(`ad-${adId}`);

    try {
      await api.patch(
        `/ads/${adId}/telegram-publication`,
        { postReference }
      );

      setSuccess('Telegram publication recorded.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not record Telegram publication'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function cancelAdCampaign(adId) {
    clearMessages();

    if (
      !window.confirm(
        'Cancel this campaign? Any paid amount is flagged REFUNDED as a bookkeeping record.'
      )
    ) {
      return;
    }

    const reason =
      window.prompt(
        'Reason for cancelling this campaign (optional):'
      ) || undefined;

    setActionLoading(`ad-${adId}`);

    try {
      await api.patch(`/ads/${adId}/cancel`, {
        reason,
      });

      setSuccess('Campaign cancelled.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not cancel campaign'
      );
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
        rejectionReason =
          window.prompt(
            'Reason for rejecting this campaign (optional):'
          ) || undefined;
      }

      await api.patch(`/ads/${adId}/status`, {
        status,
        rejectionReason,
      });

      setSuccess(
        `Campaign ${status.toLowerCase()} successfully.`
      );

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
      await api.patch(
        `/payments/${paymentId}/confirm`
      );

      setSuccess(
        'Payment confirmed and reconciled.'
      );

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

  async function checkGatewayPayment(
    paymentId,
    provider
  ) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);

    try {
      const response = await api.get(
        `/payments/${paymentId}/${provider}/verify`
      );

      setSuccess(
        response.data?.status === 'PAID'
          ? 'Payment confirmed by the gateway and reconciled.'
          : `Gateway reports this payment as ${
              response.data?.status ||
              'not yet completed'
            } — nothing to reconcile yet.`
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

  const cards = overview
    ? [
        ['Users', overview.users],
        ['Listings', overview.listings],
        ['Orders', overview.orders],
        ['Open disputes', overview.openDisputes],
        ['Active ads', overview.activeAds],
        ['Suspended users', overview.suspendedUsers || 0],
        [
          'Paid volume',
          `${Number(
            overview.totalPaidVolume || 0
          ).toLocaleString()} ETB`,
        ],
      ]
    : [];

  const openDisputes = disputes.filter(
    (d) =>
      d.status === 'OPEN' ||
      d.status === 'UNDER_REVIEW'
  );

  const resolvedDisputes = disputes.filter(
    (d) =>
      d.status !== 'OPEN' &&
      d.status !== 'UNDER_REVIEW'
  );

  const pendingAds = ads.filter(
    (a) =>
      a.status === 'PAID_PENDING_REVIEW' ||
      (
        a.status === 'PENDING' &&
        ['BANNER', 'TELEGRAM_PROMOTION'].includes(
          a.type
        )
      )
  );

  const reviewedAds = ads.filter(
    (a) =>
      !pendingAds.some(
        (pending) => pending.id === a.id
      )
  );

  const pendingRefunds = refunds.filter(
    (r) =>
      ['REQUESTED', 'PROCESSING'].includes(
        r.status
      )
  );

  const refundHistory = refunds.filter(
    (r) =>
      !['REQUESTED', 'PROCESSING'].includes(
        r.status
      )
  );

  const tabItems = [
    {
      key: 'overview',
      label: 'Overview',
      count: 0,
    },
    {
      key: 'users',
      label: 'Users & Control',
      count: 0,
    },
    {
      key: 'disputes',
      label: 'Disputes',
      count: openDisputes.length,
    },
    {
      key: 'fraud',
      label: 'Fraud Monitoring',
      count: suspiciousUsers.length,
    },
    {
      key: 'advertising',
      label: 'Advertising',
      count: pendingAds.length,
    },
    {
      key: 'orders',
      label: 'Orders',
      count: orders.length,
    },
    {
      key: 'payments',
      label: 'Payments',
      count: payments.length,
    },
    {
      key: 'refunds',
      label: 'Refunds',
      count: pendingRefunds.length,
    },
    {
      key: 'operations',
      label: 'Operations & Audit',
      count:
        (operations?.queues?.reconciliationPayments ||
          0) +
        (operations?.queues?.openDisputes || 0),
    },
  ];

  const activeTabItem =
    tabItems.find(
      (item) => item.key === tab
    ) || tabItems[0];

  if (loading && !overview) {
    return (
      <>
        <style>{ADMIN_STYLES}</style>

        <div className="sd-dashboard admin-control-center">
          <div className="ac-mfa">
            <div className="ac-mfa-icon">⌛</div>
            <span className="ac-kicker">
              ADMINISTRATION
            </span>
            <h1>Loading control center</h1>
            <p className="sd-muted">
              {error ||
                'Loading admin dashboard…'}
            </p>
          </div>
        </div>
      </>
    );
  }

  if (mfaRequired) {
    return (
      <>
        <style>{ADMIN_STYLES}</style>

        <div className="sd-dashboard admin-control-center">
          <div className="ac-hero">
            <div className="ac-hero-content">
              <div className="ac-title-row">
                <div className="ac-shield">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
                    <path d="M9.5 12l1.7 1.7 3.5-3.7" />
                  </svg>
                </div>

                <div>
                  <span className="ac-kicker">
                    ADMINISTRATION
                  </span>
                  <h1>Secure your control center</h1>
                  <p className="ac-subtitle">
                    Multi-factor authentication is
                    required before administrative
                    actions can continue.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="ac-mfa">
            <div className="ac-mfa-icon">
              🔐
            </div>

            <h2>Set up MFA to continue</h2>

            <p className="sd-muted">
              Admin actions on MarketBridge now
              require multi-factor authentication.
              This takes about a minute with an
              authenticator app such as Google
              Authenticator or Authy.
            </p>

            <div className="ac-actions" style={{ justifyContent: 'center' }}>
              <Link
                to="/account/security"
                className="sd-btn sd-btn-primary"
              >
                Set up MFA
              </Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{ADMIN_STYLES}</style>

      <div className="sd-dashboard admin-control-center">

        <section className="ac-section">
          <div className="ac-hero">
            <div className="ac-hero-content">

              <div className="ac-brand-row">
                <div className="ac-title-row">
                  <div className="ac-shield">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
                      <path d="M9.5 12l1.7 1.7 3.5-3.7" />
                    </svg>
                  </div>

                  <div>
                    <span className="ac-kicker">
                      MARKETBRIDGE ADMINISTRATION
                    </span>

                    <h1>Control Center</h1>

                    <p className="ac-subtitle">
                      Manage marketplace users,
                      verification, disputes, payments,
                      advertising, refunds, orders,
                      fraud signals, and operational
                      workflows from one place.
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
                  onClick={() =>
                    performanceModalRef.current?.showModal()
                  }
                >
                  Performance snapshot
                </button>

                <Link
                  to="/account/security"
                  className="sd-btn"
                >
                  Account security
                </Link>
              </div>

            </div>
          </div>

          <div className="ac-metrics">
            {cards.slice(0, 4).map(
              ([label, value]) => (
                <div
                  className={`ac-metric ${
                    label === 'Open disputes'
                      ? 'warn'
                      : ''
                  }`}
                  key={label}
                >
                  <div className="ac-metric-label">
                    <span>{label}</span>
                    <span className="ac-metric-dot" />
                  </div>

                  <strong className="ac-metric-value">
                    {value}
                  </strong>
                </div>
              )
            )}

            {cards.slice(4).map(
              ([label, value]) => (
                <div
                  className={`ac-metric ${
                    label === 'Suspended users'
                      ? 'danger'
                      : ''
                  }`}
                  key={label}
                >
                  <div className="ac-metric-label">
                    <span>{label}</span>
                    <span className="ac-metric-dot" />
                  </div>

                  <strong className="ac-metric-value">
                    {value}
                  </strong>
                </div>
              )
            )}
          </div>
        </section>

        <dialog
          ref={performanceModalRef}
          className="ac-dialog"
        >
          <div className="ac-modal">
            <button
              type="button"
              className="ac-close"
              aria-label="Close"
              onClick={() =>
                performanceModalRef.current?.close()
              }
            >
              ×
            </button>

            <span className="ac-section-label">
              MARKETPLACE SNAPSHOT
            </span>

            <h2>Marketplace performance</h2>

            <div
              className="ac-metrics"
              style={{ marginTop: 18 }}
            >
              {cards.map(
                ([label, value]) => (
                  <div
                    className="ac-metric"
                    key={label}
                  >
                    <div className="ac-metric-label">
                      <span>{label}</span>
                      <span className="ac-metric-dot" />
                    </div>

                    <strong className="ac-metric-value">
                      {value}
                    </strong>
                  </div>
                )
              )}
            </div>
          </div>
        </dialog>

        <dialog
          ref={disputeModalRef}
          className="ac-dialog"
          onClose={() =>
            setDisputeDecision(null)
          }
        >
          <div className="ac-modal">
            <button
              type="button"
              className="ac-close"
              onClick={closeDisputeDecision}
              aria-label="Close"
            >
              ×
            </button>

            <span className="ac-section-label">
              MODERATION
            </span>

            <h2>
              {disputeDecision?.status ===
              'REJECTED'
                ? 'Reject dispute'
                : 'Resolve dispute'}
            </h2>

            {disputeDecision && (
              <>
                <p className="sd-muted">
                  The dispute freezes the entire order while it is open — payments,
                  transport, inspection and payouts cannot proceed. Choose the
                  economic outcome below.
                </p>

                <div
                  className="sd-form-grid"
                  style={{ marginTop: 15 }}
                >
                  <div className="sd-full">
                    <label>
                      Resolution notes
                    </label>

                    <textarea
                      rows={3}
                      value={
                        disputeDecision.resolution
                      }
                      onChange={(e) =>
                        setDisputeDecision(
                          (d) => ({
                            ...d,
                            resolution:
                              e.target.value,
                          })
                        )
                      }
                    />
                  </div>

                  <div className="sd-full">
                    <label>
                      Payout decision
                    </label>

                    <label className="ac-radio-option">
                      <input
                        type="radio"
                        name="payoutDecision"
                        value="RELEASE"
                        checked={
                          disputeDecision.payoutDecision ===
                          'RELEASE'
                        }
                        onChange={() =>
                          setDisputeDecision(
                            (d) => ({
                              ...d,
                              payoutDecision:
                                'RELEASE',
                            })
                          )
                        }
                      />

                      <span>
                        <strong>
                          Release & resume order
                        </strong>{' '}
                        — restores the order to its pre-dispute state and restarts
                        the normal payout hold. No buyer refund is created.
                      </span>
                    </label>

                    <label className="ac-radio-option">
                      <input
                        type="radio"
                        name="payoutDecision"
                        value="CANCEL"
                        checked={
                          disputeDecision.payoutDecision ===
                          'CANCEL'
                        }
                        onChange={() =>
                          setDisputeDecision(
                            (d) => ({
                              ...d,
                              payoutDecision:
                                'CANCEL',
                            })
                          )
                        }
                      />

                      <span>
                        <strong>
                          Cancel order & refund buyer
                        </strong>{' '}
                        — cancels the order, stops its remaining inspection/transport
                        proceedings, cancels unpaid payouts and creates refund
                        requests for payments already received.
                      </span>
                    </label>

                    <p
                      className="sd-muted"
                      style={{ marginTop: 8 }}
                    >
                      The decision applies to the whole disputed order. Inspector,
                      seller and transporter payouts are handled together so a
                      refund cannot coexist with a still-active order.
                    </p>
                  </div>
                </div>

                <div className="ac-modal-actions">
                  <button
                    type="button"
                    className="sd-btn sd-btn-primary"
                    disabled={
                      !disputeDecision.payoutDecision ||
                      actionLoading ===
                        `dispute-${disputeDecision.id}`
                    }
                    onClick={
                      submitDisputeDecision
                    }
                  >
                    {actionLoading ===
                    `dispute-${disputeDecision.id}`
                      ? 'Working…'
                      : 'Confirm'}
                  </button>

                  <button
                    type="button"
                    className="sd-btn sd-btn-outline"
                    onClick={
                      closeDisputeDecision
                    }
                  >
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
              <span className="ac-alert-icon">
                !
              </span>
              <span>{error}</span>
            </div>
          </section>
        )}

        {success && (
          <section className="ac-section">
            <div className="ac-alert success">
              <span className="ac-alert-icon">
                ✓
              </span>
              <span>{success}</span>
            </div>
          </section>
        )}

        <section className="ac-section">
          <div
            className="ac-tabs-shell"
            ref={tabsNavRef}
          >
            <div className="ac-tabs">
              {tabItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`ac-tab ${
                    tab === item.key
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => {
                    clearMessages();
                    setTab(item.key);
                    setTabMenuOpen(false);
                  }}
                >
                  {item.label}

                  {item.count > 0 && (
                    <span className="ac-tab-count">
                      {item.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {tab === 'overview' && (
            <div className="ac-panel">
              <div className="ac-panel-header">
                <div>
                  <span className="ac-section-label">
                    SYSTEM OVERVIEW
                  </span>

                  <h2>Marketplace modules</h2>

                  <p>
                    Current administrative capabilities
                    and implementation status across
                    the MarketBridge platform.
                  </p>
                </div>
              </div>

              <div className="ac-module-list">
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
                    className={`ac-module ${
                      built ? '' : 'off'
                    }`}
                    key={label}
                  >
                    <span className="ac-module-icon">
                      {built ? '✓' : '○'}
                    </span>

                    <span>
                      {label}{' '}
                      {!built && (
                        <small>
                          (backend not built yet)
                        </small>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className="ac-panel">
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">
                    ACCESS MANAGEMENT
                  </span>

                  <h2>
                    Users & account control
                  </h2>

                  <p>
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

              <div className="ac-search">
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
                Showing{' '}
                <strong>
                  {filteredUsers.length}
                </strong>{' '}
                of {users.length} users.
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
                    {filteredUsers.map(
                      (item) => {
                        const isActionLoading =
                          actionLoading.includes(
                            item.id
                          );

                        return (
                          <tr key={item.id}>
                            <td data-label="Name">
                              <strong>
                                {item.name}
                              </strong>

                              {item.phone && (
                                <div className="sd-muted">
                                  {item.phone}
                                </div>
                              )}

                              {item.location && (
                                <div className="sd-muted">
                                  {item.location}
                                </div>
                              )}
                            </td>

                            <td data-label="Email">
                              {item.email}
                            </td>

                            <td data-label="Roles">
                              <div className="sd-chip-row">
                                {(
                                  item.roles || []
                                ).map(
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

                            <td data-label="Rating">
                              {Number(
                                item.rating || 0
                              ).toFixed(1)}
                            </td>

                            <td data-label="Verification">
                              <select
                                value={
                                  item.verificationStatus ||
                                  'UNVERIFIED'
                                }
                                onChange={(e) =>
                                  setVerification(
                                    item.id,
                                    e.target.value
                                  )
                                }
                                disabled={
                                  isActionLoading
                                }
                              >
                                <option value="UNVERIFIED">
                                  UNVERIFIED
                                </option>

                                {VERIFICATION_OPTIONS.map(
                                  (option) => (
                                    <option
                                      key={
                                        option
                                      }
                                      value={
                                        option
                                      }
                                    >
                                      {option}
                                    </option>
                                  )
                                )}
                              </select>
                            </td>

                            <td data-label="Account">
                              <div className="sd-account-cell">
                                <span
                                  className={statusBadgeClass(
                                    item.accountStatus ||
                                      'ACTIVE'
                                  )}
                                >
                                  {item.accountStatus ||
                                    'ACTIVE'}
                                </span>

                                {item.accountStatus ===
                                'SUSPENDED' ? (
                                  <button
                                    type="button"
                                    className="sd-btn sd-btn-primary"
                                    disabled={
                                      isActionLoading
                                    }
                                    onClick={() =>
                                      setAccountStatus(
                                        item.id,
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
                                        item.id,
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

                            <td data-label="Role control">
                              <div className="ac-role-actions">
                                <select
                                  value={
                                    roleSelections[
                                      item.id
                                    ] || ''
                                  }
                                  onChange={(e) =>
                                    setRoleSelections(
                                      (current) => ({
                                        ...current,
                                        [item.id]:
                                          e.target
                                            .value,
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
                                      item.id
                                    ]
                                  }
                                  onClick={() =>
                                    addRole(
                                      item.id
                                    )
                                  }
                                >
                                  Add role
                                </button>

                                {(
                                  item.roles || []
                                ).length > 0 && (
                                  <div className="sd-chip-row">
                                    {item.roles.map(
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
                                              item.id,
                                              role
                                            )
                                          }
                                          title={`Remove ${role}`}
                                        >
                                          Remove{' '}
                                          {role}
                                        </button>
                                      )
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      }
                    )}

                    {filteredUsers.length ===
                      0 && (
                      <tr>
                        <td colSpan="7">
                          <div className="ac-empty">
                            <strong>
                              No users found
                            </strong>
                            Try a different name,
                            email, role, or status.
                          </div>
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
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">
                    MODERATION
                  </span>
                  <h2>Open disputes</h2>
                  <p>
                    Review unresolved marketplace
                    disputes and make the required
                    payout decision.
                  </p>
                </div>
              </div>

              <div className="ac-grid">
                {openDisputes.map((item) => (
                  <div
                    className="ac-card"
                    key={item.id}
                  >
                    <div className="ac-status-row">
                      <h3>
                        {item.disputeType}
                      </h3>

                      <span
                        className={statusBadgeClass(
                          item.status
                        )}
                      >
                        {item.status}
                      </span>
                    </div>

                    <p>
                      {item.raisedBy?.name}{item.raisedByRole ? ` (${item.raisedByRole})` : ''} vs{' '}
                      {item.against?.name}{item.againstRole ? ` (${item.againstRole})` : ''}
                    </p>

                    <p>
                      {item.description}
                    </p>

                    <div className="ac-actions">
                      <button
                        className="sd-btn sd-btn-primary"
                        disabled={
                          actionLoading ===
                          `dispute-${item.id}`
                        }
                        onClick={() =>
                          openDisputeDecision(
                            item,
                            'RESOLVED'
                          )
                        }
                      >
                        Resolve
                      </button>

                      <button
                        className="sd-btn sd-btn-outline"
                        disabled={
                          actionLoading ===
                          `dispute-${item.id}`
                        }
                        onClick={() =>
                          openDisputeDecision(
                            item,
                            'REJECTED'
                          )
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}

                {openDisputes.length ===
                  0 && (
                  <div className="ac-empty">
                    <strong>
                      No open disputes
                    </strong>
                    The moderation queue is clear.
                  </div>
                )}
              </div>

              <div
                className="ac-toolbar"
                style={{ marginTop: 28 }}
              >
                <div>
                  <span className="ac-section-label">
                    HISTORY
                  </span>
                  <h2>
                    Recently resolved
                  </h2>
                </div>
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
                      {resolvedDisputes
                        .slice(0, 10)
                        .map((item) => (
                          <tr key={item.id}>
                            <td data-label="Type">
                              <strong>
                                {item.disputeType}
                              </strong>
                            </td>

                            <td
                              data-label="Parties"
                              className="sd-muted"
                            >
                              {item.raisedBy?.name}{item.raisedByRole ? ` (${item.raisedByRole})` : ''}{' '}
                              vs{' '}
                              {item.against?.name}{item.againstRole ? ` (${item.againstRole})` : ''}
                            </td>

                            <td data-label="Status">
                              <span
                                className={statusBadgeClass(
                                  item.status
                                )}
                              >
                                {item.status}
                              </span>
                            </td>
                          </tr>
                        ))}

                      {resolvedDisputes.length ===
                        0 && (
                        <tr>
                          <td
                            colSpan="3"
                            className="sd-muted"
                          >
                            Nothing resolved
                            yet.
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
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">
                    RISK MONITORING
                  </span>

                  <h2>Flagged users</h2>

                  <p>
                    Users with multiple open disputes
                    filed against them. This is a
                    starting heuristic — not a
                    conclusive fraud finding.
                  </p>
                </div>
              </div>

              <div className="ac-grid">
                {suspiciousUsers.map(
                  (item) => (
                    <div
                      className="ac-card"
                      key={item.id}
                    >
                      <div className="ac-status-row">
                        <h3>{item.name}</h3>

                        <span className="sd-badge sd-warn">
                          REVIEW
                        </span>
                      </div>

                      <p>
                        {item.email} ·{' '}
                        {(
                          item.disputesAgainst ||
                          []
                        ).length}{' '}
                        open dispute(s)
                      </p>

                      {(
                        item.disputesAgainst ||
                        []
                      ).map((dispute) => (
                        <p
                          key={dispute.id}
                        >
                          —{' '}
                          {dispute.disputeType}
                          :{' '}
                          {
                            dispute.description
                          }
                        </p>
                      ))}
                    </div>
                  )
                )}

                {suspiciousUsers.length ===
                  0 && (
                  <div className="ac-empty">
                    <strong>
                      No flagged users
                    </strong>
                    No heuristic fraud signals are
                    currently in the monitoring queue.
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'advertising' && (
            <div>
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">
                    ADVERTISING
                  </span>

                  <h2>Campaign control</h2>

                  <p>
                    Review paid creative, publish
                    approved campaigns, record
                    Telegram publication, and end
                    campaigns early when necessary.
                  </p>
                </div>
              </div>

              <div className="ac-grid">
                {pendingAds.map((ad) => {
                  const adPaid =
                    (ad.payments || []).some(
                      (p) =>
                        p.status === 'PAID'
                    );

                  const impressions =
                    (ad.events || []).filter(
                      (e) =>
                        e.eventType ===
                        'IMPRESSION'
                    ).length;

                  const clicks =
                    (ad.events || []).filter(
                      (e) =>
                        e.eventType ===
                        'CLICK'
                    ).length;

                  const ctr = impressions
                    ? (
                        (clicks /
                          impressions) *
                        100
                      ).toFixed(2)
                    : '0.00';

                  return (
                    <div
                      className="ac-card"
                      key={ad.id}
                    >
                      {ad.creativeImageUrl && (
                        <img
                          src={
                            ad.creativeImageUrl
                          }
                          alt={
                            ad.headline ||
                            'Campaign creative'
                          }
                          loading="lazy"
                          decoding="async"
                          className="ac-image"
                        />
                      )}

                      <div className="ac-status-row">
                        <h3>
                          {ad.type.replace(
                            /_/g,
                            ' '
                          )}
                        </h3>

                        <span
                          className={statusBadgeClass(
                            ad.status
                          )}
                        >
                          {ad.status}
                        </span>
                      </div>

                      {ad.type ===
                        'TELEGRAM_PROMOTION' &&
                        ad.telegramImageUrls
                          ?.length > 0 && (
                          <ImageCarousel
                            images={
                              ad.telegramImageUrls
                            }
                            alt={
                              ad.headline ||
                              'Carousel photo'
                            }
                            openLinks
                            className="img-carousel--compact"
                          />
                        )}

                      {ad.type ===
                        'TELEGRAM_PROMOTION' &&
                        ad.telegramTemplate && (
                          <p>
                            <strong>
                              Template:
                            </strong>{' '}
                            {ad.telegramTemplate.replace(
                              /_/g,
                              ' '
                            )}
                            {ad.telegramImageCount >
                              0
                              ? ` · ${ad.telegramImageCount} photos`
                              : ''}
                          </p>
                        )}

                      {ad.headline && (
                        <p>
                          <strong>
                            {ad.headline}
                          </strong>
                        </p>
                      )}

                      <p>
                        <strong>
                          Ref:
                        </strong>{' '}
                        {ad.campaignReference ||
                          ad.id.slice(0, 8)}
                        {' · '}
                        <strong>
                          Advertiser:
                        </strong>{' '}
                        {ad.advertiser?.name}{' '}
                        (
                        {
                          ad.advertiser
                            ?.email
                        }
                        )
                      </p>

                      <p>
                        {ad.listing ? (
                          <>
                            Featuring{' '}
                            <strong>
                              {ad.listing.title ||
                                ad.listing.cropType}
                            </strong>{' '}
                            ·{' '}
                          </>
                        ) : (
                          'Platform-wide · '
                        )}

                        {new Date(
                          ad.startDate
                        ).toLocaleDateString()}{' '}
                        —{' '}
                        {new Date(
                          ad.endDate
                        ).toLocaleDateString()}
                      </p>

                      <div className="ac-financial">
                        <div className="ac-financial-item">
                          <span>
                            Quoted
                          </span>
                          <b>
                            {Number(
                              ad.priceQuoted ||
                                0
                            ).toLocaleString()}{' '}
                            {ad.currency ||
                              'ETB'}
                          </b>
                        </div>

                        <div className="ac-financial-item">
                          <span>
                            Paid
                          </span>
                          <b>
                            {adPaid
                              ? Number(
                                  ad.amountPaid ||
                                    0
                                ).toLocaleString()
                              : '0'}{' '}
                            {ad.currency ||
                              'ETB'}
                          </b>
                        </div>

                        <div className="ac-financial-item">
                          <span>
                            CTR
                          </span>
                          <b>
                            {ctr}%
                          </b>
                        </div>
                      </div>

                      {ad.destinationUrl && (
                        <p
                          style={{
                            wordBreak:
                              'break-word',
                          }}
                        >
                          Destination:{' '}
                          {ad.destinationUrl}
                        </p>
                      )}

                      <div className="ac-actions">
                        <button
                          className="sd-btn sd-btn-primary"
                          disabled={
                            actionLoading ===
                              `ad-${ad.id}` ||
                            !adPaid
                          }
                          title={
                            !adPaid
                              ? 'Waiting for payment'
                              : undefined
                          }
                          onClick={() =>
                            setAdStatus(
                              ad.id,
                              'APPROVED'
                            )
                          }
                        >
                          {actionLoading ===
                          `ad-${ad.id}`
                            ? 'Working…'
                            : 'Approve'}
                        </button>

                        <button
                          className="sd-btn sd-btn-outline"
                          disabled={
                            actionLoading ===
                            `ad-${ad.id}`
                          }
                          onClick={() =>
                            setAdStatus(
                              ad.id,
                              'REJECTED'
                            )
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                })}

                {pendingAds.length === 0 && (
                  <div className="ac-empty">
                    <strong>
                      No campaigns waiting
                    </strong>
                    There are no campaigns waiting on
                    content review.
                  </div>
                )}
              </div>

              <div
                className="ac-panel"
                style={{ marginTop: 20 }}
              >
                <div className="ac-panel-header">
                  <div>
                    <span className="ac-section-label">
                      HISTORY
                    </span>
                    <h2>
                      Campaign ledger
                    </h2>
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
                      {reviewedAds
                        .slice(0, 30)
                        .map((ad) => {
                          const impressions =
                            (
                              ad.events ||
                              []
                            ).filter(
                              (e) =>
                                e.eventType ===
                                'IMPRESSION'
                            ).length;

                          const clicks =
                            (
                              ad.events ||
                              []
                            ).filter(
                              (e) =>
                                e.eventType ===
                                'CLICK'
                            ).length;

                          const ctr =
                            impressions
                              ? (
                                  (clicks /
                                    impressions) *
                                  100
                                ).toFixed(2)
                              : '0.00';

                          return (
                            <tr
                              key={ad.id}
                            >
                              <td data-label="Campaign">
                                <strong>
                                  {ad.campaignReference ||
                                    ad.type.replace(
                                      /_/g,
                                      ' '
                                    )}
                                </strong>
                                <br />
                                <span className="sd-muted">
                                  {ad.type.replace(
                                    /_/g,
                                    ' '
                                  )}
                                </span>

                                {ad.type ===
                                  'TELEGRAM_PROMOTION' &&
                                  ad.telegramImageUrls
                                    ?.length >
                                    0 && (
                                    <details className="tg-ledger-photos">
                                      <summary>
                                        🎠{' '}
                                        {
                                          ad
                                            .telegramImageUrls
                                            .length
                                        }{' '}
                                        carousel photos
                                      </summary>

                                      <ImageCarousel
                                        images={
                                          ad.telegramImageUrls
                                        }
                                        alt={
                                          ad.headline ||
                                          'Carousel photo'
                                        }
                                        openLinks
                                        className="img-carousel--compact"
                                      />
                                    </details>
                                  )}
                              </td>

                              <td
                                data-label="Advertiser"
                                className="sd-muted"
                              >
                                {
                                  ad
                                    .advertiser
                                    ?.name
                                }
                              </td>

                              <td
                                data-label="Dates"
                                className="sd-muted"
                              >
                                {new Date(
                                  ad.startDate
                                ).toLocaleDateString()}{' '}
                                —{' '}
                                {new Date(
                                  ad.endDate
                                ).toLocaleDateString()}
                              </td>

                              <td
                                data-label="Financials"
                                className="sd-muted"
                              >
                                {Number(
                                  ad.priceQuoted ||
                                    0
                                ).toLocaleString()}{' '}
                                {ad.currency ||
                                  'ETB'}{' '}
                                quoted
                                <br />
                                {Number(
                                  ad.amountPaid ||
                                    0
                                ).toLocaleString()}{' '}
                                paid
                              </td>

                              <td
                                data-label="Analytics"
                                className="sd-muted"
                              >
                                {impressions}{' '}
                                imp · {clicks}{' '}
                                clicks · {ctr}%
                                CTR
                              </td>

                              <td data-label="Status">
                                <span
                                  className={statusBadgeClass(
                                    ad.status
                                  )}
                                >
                                  {ad.status}
                                </span>
                              </td>

                              <td data-label="">
                                <div className="ac-actions">
                                  {[
                                    'PUBLISHED',
                                    'ACTIVE',
                                  ].includes(
                                    ad.status
                                  ) && (
                                    <button
                                      className="sd-btn sd-btn-outline"
                                      disabled={
                                        actionLoading ===
                                        `ad-${ad.id}`
                                      }
                                      onClick={() =>
                                        setAdStatus(
                                          ad.id,
                                          'EXPIRED'
                                        )
                                      }
                                    >
                                      {actionLoading ===
                                      `ad-${ad.id}`
                                        ? 'Working…'
                                        : 'End early'}
                                    </button>
                                  )}

                                  {[
                                    'PAID_PENDING_REVIEW',
                                    'APPROVED',
                                    'SCHEDULED',
                                  ].includes(
                                    ad.status
                                  ) && (
                                    <button
                                      className="sd-btn sd-btn-outline"
                                      disabled={
                                        actionLoading ===
                                        `ad-${ad.id}`
                                      }
                                      onClick={() =>
                                        cancelAdCampaign(
                                          ad.id
                                        )
                                      }
                                    >
                                      {actionLoading ===
                                      `ad-${ad.id}`
                                        ? 'Working…'
                                        : 'Cancel & refund'}
                                    </button>
                                  )}

                                  {ad.type ===
                                    'TELEGRAM_PROMOTION' &&
                                    [
                                      'APPROVED',
                                      'SCHEDULED',
                                    ].includes(
                                      ad.status
                                    ) && (
                                      <button
                                        className="sd-btn sd-btn-primary"
                                        disabled={
                                          actionLoading ===
                                          `ad-${ad.id}`
                                        }
                                        onClick={() =>
                                          markTelegramPublished(
                                            ad.id
                                          )
                                        }
                                      >
                                        Mark Telegram
                                        published
                                      </button>
                                    )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                      {reviewedAds.length ===
                        0 && (
                        <tr>
                          <td
                            colSpan="7"
                            className="sd-muted"
                          >
                            No reviewed campaigns
                            yet.
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
              <div className="ac-toolbar">
                <div>
                  <span className="ac-section-label">
                    ORDERS
                  </span>

                  <h2>All orders</h2>

                  <p>
                    Cancelling here is an admin
                    override for stalled orders. It is
                    blocked once a transport job has
                    started pickup, since goods already
                    in motion need a dispute instead.
                  </p>
                </div>
              </div>

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
                        const transportInMotion =
                          Boolean(
                            o.transportJob &&
                              [
                                'PICKUP',
                                'IN_TRANSIT',
                                'DELIVERED',
                              ].includes(
                                o.transportJob
                                  .status
                              )
                          );

                        const cancellable =
                          ![
                            'COMPLETED',
                            'CANCELLED',
                          ].includes(
                            o.status
                          ) &&
                          !transportInMotion;

                        return (
                          <tr key={o.id}>
                            <td data-label="Order">
                              <span className="ac-code">
                                {o.id.slice(
                                  0,
                                  8
                                )}
                              </span>
                            </td>

                            <td data-label="Listing">
                              {o.listing?.title ||
                                o.listing
                                  ?.cropType ||
                                '—'}
                            </td>

                            <td data-label="Buyer">
                              {o.buyer?.name ||
                                '—'}
                            </td>

                            <td data-label="Seller">
                              {o.seller?.name ||
                                '—'}
                            </td>

                            <td data-label="Value">
                              {Number(
                                o.finalPrice
                              ).toLocaleString()}{' '}
                              ETB
                            </td>

                            <td data-label="Status">
                              <span
                                className={statusBadgeClass(
                                  o.status
                                )}
                              >
                                {o.status}
                              </span>
                            </td>

                            <td data-label="">
                              {cancellable && (
                                <button
                                  type="button"
                                  className="sd-btn sd-btn-outline"
                                  disabled={
                                    actionLoading ===
                                    `order-${o.id}`
                                  }
                                  onClick={() =>
                                    cancelOrder(
                                      o
                                    )
                                  }
                                >
                                  {actionLoading ===
                                  `order-${o.id}`
                                    ? 'Cancelling…'
                                    : 'Cancel order'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {orders.length === 0 && (
                        <tr>
                          <td
                            colSpan="7"
                            className="sd-muted"
                          >
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

          {tab === 'refunds' && (
            <div>
              <div className="ac-panel">
                <div className="ac-toolbar">
                  <div>
                    <span className="ac-section-label">FINANCIAL REFUNDS</span>
                    <h2>Chapa refund queue</h2>
                    <p>
                      Refunds are submitted to Chapa automatically. A refund is not marked completed until Chapa reports the final <strong>refunded</strong> state.
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
                          <td data-label="Chapa refund ID"><span className="ac-code">{refund.providerRefundId ? refund.providerRefundId.slice(0, 18) : '—'}</span></td>
                          <td data-label="Chapa tx ref (admin)">
                            {refund.payment?.chapaTxRef ? (
                              <span className="ac-code">{refund.payment.chapaTxRef}</span>
                            ) : (
                              <>
                                <span className={statusBadgeClass('FAILED')}>missing</span>
                                {refund.payment?.providerTransactionId && (
                                  <div className="sd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                                    providerTransactionId:{' '}
                                    <span className="ac-code">
                                      {refund.payment.providerTransactionId}
                                    </span>
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                          <td data-label="Actions">
                            <div className="refund-actions">
                              {refund.status === 'REQUESTED' && (
                                <button type="button" className="sd-btn sd-btn-primary" disabled={actionLoading === `refund-${refund.id}`} onClick={() => processRefund(refund)}>
                                  {actionLoading === `refund-${refund.id}` ? 'Submitting…' : 'Process with Chapa'}
                                </button>
                              )}
                              {refund.status === 'PROCESSING' && (
                                <span className="sd-muted" style={{ fontSize: 12 }}>
                                  Auto-checking with Chapa…
                                </span>
                              )}
                              {refund.status === 'FAILED' && (
                                <button type="button" className="sd-btn sd-btn-primary" disabled={actionLoading === `refund-${refund.id}`} onClick={() => processRefund(refund)}>
                                  {actionLoading === `refund-${refund.id}` ? 'Retrying…' : 'Retry refund'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {refunds.length === 0 && (
                        <tr><td colSpan="8" className="sd-muted">No refunds recorded.</td></tr>
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
                <div className="ac-toolbar">
                  <div>
                    <span className="ac-section-label">
                      SYSTEM OPERATIONS
                    </span>

                    <h2>
                      Operations & audit
                    </h2>

                    <p>
                      Monitor live workflow queues
                      from durable OrderEvent records
                      and review the internal audit
                      trail.
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

                <div className="ac-stat-strip">
                  {[
                    [
                      'Pending payments',
                      operations?.queues
                        ?.pendingPayments || 0,
                    ],
                    [
                      'Reconciliation queue',
                      operations?.queues
                        ?.reconciliationPayments ||
                        0,
                    ],
                    [
                      'Open disputes',
                      operations?.queues
                        ?.openDisputes || 0,
                    ],
                    [
                      'Active orders',
                      operations?.activeOrders ||
                        0,
                    ],
                    [
                      'Active transport',
                      operations?.activeTransportJobs ||
                        0,
                    ],
                  ].map(
                    ([label, value]) => (
                      <div
                        className="ac-small-stat"
                        key={label}
                      >
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="ac-panel">
                <div className="ac-toolbar">
                  <div>
                    <span className="ac-section-label">
                      ORDER EVENTS
                    </span>
                    <h2>Recent order events</h2>
                    <p className="sd-muted">
                      Latest durable OrderEvent records emitted by the
                      workflow engine.
                    </p>
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
                          <td data-label="Event">
                            <span
                              className={statusBadgeClass(event.type)}
                            >
                              {event.type || '—'}
                            </span>
                          </td>
                          <td data-label="Order">
                            <span className="ac-code">
                              {event.orderId
                                ? event.orderId.slice(0, 8)
                                : '—'}
                            </span>
                          </td>
                          <td data-label="Status change">
                            {event.fromStatus || event.toStatus
                              ? `${event.fromStatus || '—'} → ${
                                  event.toStatus || '—'
                                }`
                              : '—'}
                          </td>
                          <td data-label="Actor">
                            {event.actor?.name ||
                              event.actor?.email ||
                              'System'}
                          </td>
                          <td data-label="When">
                            {event.createdAt
                              ? new Date(
                                  event.createdAt
                                ).toLocaleString()
                              : '—'}
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
                <div className="ac-toolbar">
                  <div>
                    <span className="ac-section-label">
                      AUDIT TRAIL
                    </span>
                    <h2>Admin audit log</h2>
                    <p className="sd-muted">
                      Actions taken by admin users, most recent first.
                    </p>
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
                          <td data-label="Action">
                            <span
                              className={statusBadgeClass(event.action)}
                            >
                              {event.action || '—'}
                            </span>
                          </td>
                          <td data-label="Resource">
                            <span className="ac-code">
                              {event.resourceType || '—'}
                              {event.resourceId
                                ? ` · ${event.resourceId.slice(0, 8)}`
                                : ''}
                            </span>
                          </td>
                          <td data-label="Actor">
                            {event.actor?.name ||
                              event.actor?.email ||
                              'System'}
                          </td>
                          <td data-label="When">
                            {event.createdAt
                              ? new Date(
                                  event.createdAt
                                ).toLocaleString()
                              : '—'}
                          </td>
                          <td data-label="Details">
                            {event.metadata
                              ? JSON.stringify(event.metadata)
                              : '—'}
                          </td>
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
    </>
  );
}
