import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/TruckOwnerDashboard.css';

const TABS = [
  { id: 'trucks', label: 'My Trucks' },
  { id: 'available', label: 'Available Jobs' },
  { id: 'jobs', label: 'My Jobs' },
];

const EMPTY_TRUCK_FORM = {
  registration: '',
  truckType: '',
  capacity: '',
  operatingArea: '',
};

const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];

/* ── Small presentational helpers (Orders-style card system) ── */

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

// The agreed price of a job: explicit field first, then the accepted quote
// (a counter-offer, when present, is the price that was actually accepted).
function jobAmount(job) {
  const accepted = (job.quotes || []).find((q) => q.status === 'ACCEPTED');
  const raw =
    job.agreedAmount ??
    job.amount ??
    job.price ??
    accepted?.counterAmount ??
    accepted?.amount ??
    null;
  return raw == null ? null : fmtMoney(raw);
}

// Short label + initials for the "Arranged by" cluster in a card head.
function arrangerShort(arrangingParty) {
  switch (arrangingParty) {
    case 'SELLER':
      return { name: 'Seller', initials: 'S' };
    case 'BUYER':
      return { name: 'Buyer', initials: 'B' };
    case 'JOINT':
      return { name: 'Buyer + Seller', initials: 'B+S' };
    default:
      return { name: 'Marketplace', initials: 'M' };
  }
}

// Tone (success | info | gold | danger | muted) for a transport job status.
function jobTone(status) {
  switch (status) {
    case 'DELIVERED':
    case 'ACCEPTED':
      return 'success';
    case 'PICKUP':
    case 'IN_TRANSIT':
      return 'info';
    case 'CANCELLED':
      return 'danger';
    case 'REQUESTED':
    case 'QUOTED':
    case 'SELECTED':
      return 'gold';
    default:
      return 'muted';
  }
}

function truckTone(availability) {
  if (availability === 'AVAILABLE') return 'success';
  if (availability === 'BUSY') return 'info';
  return 'muted';
}

function verificationTone(status) {
  const s = String(status || '').toUpperCase();
  if (['VERIFIED', 'APPROVED'].includes(s)) return 'success';
  if (['REJECTED', 'SUSPENDED'].includes(s)) return 'danger';
  return 'gold';
}

/*
 * Four-step trip timeline:
 *   Accepted → Pickup → In transit → Delivered
 * The "current" step is the next thing that still has to happen.
 */
function jobProgress(status) {
  const labels = ['Accepted', 'Pickup', 'In transit', 'Delivered'];
  const s = String(status || '').toUpperCase();

  let idx = 0;
  if (s === 'ACCEPTED') idx = 1;
  else if (s === 'PICKUP') idx = 2;
  else if (s === 'IN_TRANSIT') idx = 3;
  else if (s === 'DELIVERED') idx = 4;

  return labels.map((label, i) => ({
    label,
    cls: i < idx ? 'done' : i === idx ? 'current' : '',
  }));
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

function RouteStrip({ pickup, destination, compact = false }) {
  const w = compact ? 20 : 24;
  const h = compact ? 10 : 12;
  return (
    <div className={`sd-job-route${compact ? ' sd-job-route--compact' : ''}`}>
      <div className="sd-job-endpoint">
        <span className="sd-job-endpoint-label">Pickup</span>
        <strong>{pickup || 'Not set'}</strong>
      </div>
      <div className="sd-job-route-arrow" aria-hidden="true">
        <svg
          width={w}
          height={h}
          viewBox="0 0 24 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 6h18" />
          <path d="M15 2l5 4-5 4" />
        </svg>
      </div>
      <div className="sd-job-endpoint">
        <span className="sd-job-endpoint-label">Destination</span>
        <strong>{destination || 'Not set'}</strong>
      </div>
    </div>
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

export default function TruckOwnerDashboard() {
  const { user } = useAuth();
  const [trucks, setTrucks] = useState([]);
  const [openJobs, setOpenJobs] = useState([]);
  const [myJobs, setMyJobs] = useState([]);

  const [activeTab, setActiveTab] = useState('trucks');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);

  const [toastMsg, setToastMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [truckForm, setTruckForm] = useState(EMPTY_TRUCK_FORM);
  const [showTruckModal, setShowTruckModal] = useState(false);

  // Evidence capture, required by the backend before PICKUP -> IN_TRANSIT
  // (needs PICKUP evidence) and IN_TRANSIT -> DELIVERED (needs DELIVERY evidence).
  // Payment completeness (seller, transport, inspection) is enforced by the
  // backend before ACCEPTED -> PICKUP, i.e. before the truck collects the goods.
  const [evidenceModal, setEvidenceModal] = useState(null); // { jobId, type, nextStatus }
  const [evidenceKeys, setEvidenceKeys] = useState({ photoKeys: [], videoKeys: [] });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceGps, setEvidenceGps] = useState('');
  const [evidenceError, setEvidenceError] = useState('');
  const [submittingEvidence, setSubmittingEvidence] = useState(false);

  function toast(message) {
    setToastMsg(message);

    window.setTimeout(() => {
      setToastMsg('');
    }, 3000);
  }

  function getErrorMessage(err, fallback) {
    return (
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      fallback
    );
  }

  async function loadAll(showLoading = false) {
    if (showLoading) setLoading(true);

    try {
      setErrorMsg('');

      const [trucksRes, openRes, mineRes] = await Promise.all([
        api.get('/transport/trucks/mine'),
        api.get('/transport/open'),
        api.get('/transport/mine'),
      ]);

      setTrucks(trucksRes.data?.trucks || []);
      setOpenJobs(openRes.data?.jobs || []);
      setMyJobs(mineRes.data?.jobs || []);
    } catch (err) {
      setErrorMsg(
        getErrorMessage(
          err,
          'Unable to load transport dashboard data.'
        )
      );
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    let timer;

    const refresh = async () => {
      if (!mounted) return;
      await loadAll(false);
      if (mounted) timer = window.setTimeout(refresh, 10000);
    };

    loadAll(true).then(() => {
      if (mounted) timer = window.setTimeout(refresh, 10000);
    });

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const activeJobs = useMemo(
    () =>
      myJobs.filter(
        (job) => !TERMINAL_STATUSES.includes(job.status)
      ),
    [myJobs]
  );

  const completedJobs = useMemo(
    () => myJobs.filter((job) => job.status === 'DELIVERED'),
    [myJobs]
  );

  const activityItems = myJobs.map((job) => ({
    id: `job-${job.id}`,
    icon: '🚛',
    text: `Job to ${job.destination || 'destination'} is ${job.status.toLowerCase().replaceAll('_', ' ')}`,
    time: job.updatedAt || job.createdAt,
    href: `/orders/${job.orderId}`,
  }));

  const availableTrucks = useMemo(
    () =>
      trucks.filter(
        (truck) => truck.availability === 'AVAILABLE'
      ),
    [trucks]
  );

  async function registerTruck(event) {
    event.preventDefault();

    if (!truckForm.capacity || Number(truckForm.capacity) <= 0) {
      toast('Enter a valid truck capacity.');
      return;
    }

    setActionLoading('register-truck');

    try {
      await api.post('/transport/trucks', {
        registration: truckForm.registration.trim(),
        truckType: truckForm.truckType.trim(),
        capacity: Number(truckForm.capacity),
        operatingArea: truckForm.operatingArea.trim(),
      });

      setTruckForm(EMPTY_TRUCK_FORM);
      setShowTruckModal(false);
      toast('Truck registered successfully.');

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not register the truck.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function setAvailability(truckId, availability) {
    setActionLoading(`availability-${truckId}`);

    try {
      await api.patch(
        `/transport/trucks/${truckId}/availability`,
        { availability }
      );

      toast(`Truck marked ${availability.toLowerCase()}.`);

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not update truck availability.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function respondToJob(job) {
    const available = trucks.filter(
      (t) =>
        t.availability === 'AVAILABLE' &&
        (!job.requiredCapacity || t.capacity >= Number(job.requiredCapacity))
    );

    if (!available.length) {
      toast('No available truck meets this request.');
      return;
    }

    const amount = window.prompt(`Transport quote in ETB for ${job.load}:`);
    if (amount === null) return;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      toast('Enter a valid positive quote.');
      return;
    }

    setActionLoading(`job-${job.id}-QUOTE`);

    try {
      await api.post(`/transport/${job.id}/quotes`, {
        truckId: available[0].id,
        amount: Number(amount),
      });
      toast('Transport quote submitted. The buyer can compare your sealed bid with other transporters.');
      await loadAll(false);
      setActiveTab('jobs');
    } catch (err) {
      toast(getErrorMessage(err, 'Could not submit transport quote.'));
    } finally {
      setActionLoading(null);
    }
  }

  // A quote's negotiation thread is only "live" at its leaf: the row that
  // no later counter-quote points back to as a parent.
  function leafTransportQuote(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    const parentIds = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
    const leaves = list.filter((q) => !parentIds.has(q.id));
    return leaves.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || 0) -
        new Date(a.updatedAt || a.createdAt || 0)
    )[0] || null;
  }

  function isQuoteExpired(quote) {
    return Boolean(quote?.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
  }

  // Release a provisionally accepted deal (before transport payment). This is
  // a WITHDRAW, not a REJECT: the backend only allows REJECT on quotes that
  // are still being negotiated, so rejecting an ACCEPTED quote always failed.
  async function releaseTransportAgreement(quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'WITHDRAW' });
      toast('Agreement released. The requester can now choose another transporter.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not release this agreement.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function acceptTransportQuote(quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'ACCEPT' });
      toast('Requester\u2019s price accepted. The transport deal is provisional until payment settles.');
      await loadAll(false);
      setActiveTab('jobs');
    } catch (err) {
      toast(getErrorMessage(err, 'Could not accept this negotiation.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function counterTransportQuote(quoteId) {
    const amount = window.prompt('Your counter-offer in ETB:');
    if (amount === null) return;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      toast('Enter a valid positive amount.');
      return;
    }

    setActionLoading(`quote-${quoteId}`);

    try {
      await api.patch(`/transport/quotes/${quoteId}`, {
        action: 'COUNTER',
        counterAmount: Number(amount),
      });
      toast('Counter-offer sent to the requester.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not send counter-offer.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function rejectTransportQuote(quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'REJECT' });
      toast('Negotiation ended.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not reject this negotiation.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function updateStatus(jobId, status) {
    setActionLoading(`status-${jobId}-${status}`);

    try {
      await api.patch(
        `/transport/${jobId}/status`,
        { status }
      );

      const messages = {
        PICKUP: 'Pickup confirmed.',
        IN_TRANSIT: 'Trip marked in transit.',
        DELIVERED: 'Delivery marked completed.',
        CANCELLED: 'Transport job cancelled.',
      };

      toast(messages[status] || 'Transport status updated.');

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not update transport status.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  function openEvidenceModal(jobId, type, nextStatus) {
    setEvidenceModal({ jobId, type, nextStatus });
    setEvidenceKeys({ photoKeys: [], videoKeys: [] });
    setEvidenceNotes('');
    setEvidenceGps('');
    setEvidenceError('');
  }

  function closeEvidenceModal() {
    setEvidenceModal(null);
  }

  async function submitEvidenceAndAdvance() {
    if (!evidenceModal) return;
    const { jobId, type, nextStatus } = evidenceModal;

    if (
      !evidenceKeys.photoKeys.length &&
      !evidenceKeys.videoKeys.length &&
      !evidenceNotes &&
      !evidenceGps
    ) {
      setEvidenceError('Upload a photo/video or add notes/GPS before continuing.');
      return;
    }

    setSubmittingEvidence(true);
    setEvidenceError('');

    try {
      await api.post(`/transport/${jobId}/evidence`, {
        type,
        photos: evidenceKeys.photoKeys,
        videos: evidenceKeys.videoKeys,
        notes: evidenceNotes || undefined,
        gpsLocation: evidenceGps || undefined,
      });

      closeEvidenceModal();
      await updateStatus(jobId, nextStatus);
    } catch (err) {
      setEvidenceError(
        getErrorMessage(err, `Could not record ${type.toLowerCase()} evidence.`)
      );
    } finally {
      setSubmittingEvidence(false);
    }
  }

  function getArrangingPartyLabel(arrangingParty) {
    switch (arrangingParty) {
      case 'SELLER':
        return 'Seller arranging';
      case 'BUYER':
        return 'Buyer arranging';
      case 'JOINT':
        return 'Buyer + Seller';
      default:
        return 'Marketplace request';
    }
  }

  function getStatusClass(status) {
    if (status === 'DELIVERED') return 'sd-badge';
    if (status === 'CANCELLED') return 'sd-badge sd-warn';
    if (status === 'IN_TRANSIT') return 'sd-badge sd-blue';

    return 'sd-badge sd-warn';
  }

  function renderJobActionButtons(job) {
    const busy = actionLoading?.startsWith(`status-${job.id}`);

    if (job.status === 'REQUESTED' || job.status === 'QUOTED') {
      // The backend keeps the job in QUOTED after a deal is accepted: the
      // agreement is provisional until transport payment settles. Without
      // this branch the truck owner whose quote was accepted was told the
      // requester was still "selecting a transporter".
      const agreedQuote = (job.quotes || []).find((quote) => quote.status === 'ACCEPTED');
      if (agreedQuote) {
        const orderPayments = job.order?.payments || [];
        const transportPayStarted =
          orderPayments.some(
            (p) => p.type === 'TRANSPORT' && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
          ) ||
          (job.payments || []).some(
            (p) => p.type === 'TRANSPORT' && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
          );
        return (
          <div className="sd-job-actions">
            <p className="sd-job-waiting">
              <span className="sd-job-waiting-dot" aria-hidden="true" />
              Agreement reached at {fmtMoney(job.agreedAmount ?? agreedQuote.amount)} ETB — waiting for the requester&apos;s transport payment
            </p>
            {!transportPayStarted && (
              <button
                type="button"
                className="sd-btn sd-btn-outline"
                disabled={actionLoading === `quote-${agreedQuote.id}`}
                onClick={() => releaseTransportAgreement(agreedQuote.id)}
              >
                {actionLoading === `quote-${agreedQuote.id}` ? 'Releasing…' : 'Cancel provisional deal'}
              </button>
            )}
          </div>
        );
      }
      return (
        <p className="sd-job-waiting">
          <span className="sd-job-waiting-dot" aria-hidden="true" />
          Waiting for the requester to select a transporter
        </p>
      );
    }

    if (job.status === 'SELECTED') {
      return (
        <p className="sd-job-waiting">
          <span className="sd-job-waiting-dot" aria-hidden="true" />
          You've been selected — finalising the deal terms
        </p>
      );
    }

    if (job.status === 'ACCEPTED') {
      const acceptedQuote = (job.quotes || []).find(
        (quote) => quote.status === 'ACCEPTED'
      );
      const orderPayments = job.order?.payments || [];
      const marketplacePaid = orderPayments.some(
        (p) => p.type === 'MARKETPLACE' && p.status === 'PAID'
      );
      const transportPaid =
        job.method !== 'HIRE_TRANSPORTER' ||
        orderPayments.some((p) => p.type === 'TRANSPORT' && p.status === 'PAID') ||
        (job.payments || []).some((p) => p.type === 'TRANSPORT' && p.status === 'PAID');
      const inspectionRequests = job.order?.listing?.inspectionRequests || [];
      const inspectionPaid = inspectionRequests
        .filter((r) => r.status !== 'CANCELLED' && r.fee != null && Number(r.fee) > 0)
        .every((r) =>
          (r.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID')
        );
      const paymentsReady = marketplacePaid && transportPaid && inspectionPaid;

      return (
        <div className="sd-job-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy || !paymentsReady}
            onClick={() => updateStatus(job.id, 'PICKUP')}
          >
            {busy ? 'Updating…' : paymentsReady ? 'Mark picked up' : 'Waiting for all payments'}
          </button>

          {!paymentsReady && (
            <p className="sd-job-note">
              The deal is provisional until all payments settle. The buyer can still cancel and select another transporter before payment completes.
            </p>
          )}

          {!transportPaid && acceptedQuote && (
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              disabled={actionLoading === `quote-${acceptedQuote.id}`}
              onClick={() => releaseTransportAgreement(acceptedQuote.id)}
            >
              {actionLoading === `quote-${acceptedQuote.id}` ? 'Cancelling…' : 'Cancel provisional deal'}
            </button>
          )}
        </div>
      );
    }

    if (job.status === 'PICKUP') {
      return (
        <div className="sd-job-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy}
            onClick={() => openEvidenceModal(job.id, 'PICKUP', 'IN_TRANSIT')}
          >
            {busy ? 'Updating…' : 'Add pickup evidence & start trip'}
          </button>
        </div>
      );
    }

    if (job.status === 'IN_TRANSIT') {
      return (
        <div className="sd-job-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy}
            onClick={() => openEvidenceModal(job.id, 'DELIVERY', 'DELIVERED')}
          >
            {busy ? 'Updating…' : 'Add delivery evidence & complete trip'}
          </button>
        </div>
      );
    }

    return null;
  }

  if (loading) {
    return (
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>
          <h1>Loading your transport workspace…</h1>
          <p className="sd-muted">
            Loading trucks, available requests and your transport jobs.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sd-dashboard">

      {/* =========================================================
          HEADER / SUMMARY
      ========================================================= */}

      <section>
        <DashboardWelcome
          user={user}
          subtitle="Register your trucks, pick up transport jobs, and manage trips through delivery."
        />
        <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>

        <h1>Your trucks, your jobs, your routes.</h1>

        <p className="sd-muted" style={{ maxWidth: 780 }}>
          Register your trucks, receive agricultural transport
          requests created through MarketBridge, respond to jobs,
          and manage accepted trips through delivery.
        </p>

        <RoleSwitchCTA current="TRUCK_OWNER" />
        <RecentActivity
          items={activityItems}
          emptyText="No transport jobs yet — check available jobs below."
        />

        <div className="sd-stat-grid">
          <div className="sd-stat">
            <span>REGISTERED TRUCKS</span>
            <b>{trucks.length}</b>
          </div>

          <div className="sd-stat">
            <span>AVAILABLE TRUCKS</span>
            <b>{availableTrucks.length}</b>
          </div>

          <div className="sd-stat">
            <span>AVAILABLE JOBS</span>
            <b>{openJobs.length}</b>
          </div>

          <div className="sd-stat">
            <span>ACTIVE JOBS</span>
            <b>{activeJobs.length}</b>
          </div>

          <div className="sd-stat">
            <span>COMPLETED TRIPS</span>
            <b>{completedJobs.length}</b>
          </div>
        </div>
      </section>

      {/* =========================================================
          ERROR
      ========================================================= */}

      {errorMsg && (
        <section>
          <div className="sd-panel sd-panel--error">
            <strong>Unable to load dashboard</strong>
            <p className="sd-muted">{errorMsg}</p>
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              onClick={() => loadAll(true)}
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
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`sd-tab ${activeTab === tab.id ? 'sd-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'available' && openJobs.length > 0 && (
                <span>({openJobs.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* =======================================================
            MY TRUCKS
        ======================================================= */}

        {activeTab === 'trucks' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">FLEET</span>
                <h2>My trucks</h2>
                <p className="sd-muted">
                  Manage your fleet and availability.
                </p>
              </div>
              <button
                type="button"
                className="sd-btn sd-btn-primary"
                onClick={() => setShowTruckModal(true)}
              >
                + Register a truck
              </button>
            </div>

            <div className="sd-cards">
              {trucks.map((truck) => {
                const availabilityBusy =
                  actionLoading === `availability-${truck.id}`;
                const tone = truckTone(truck.availability);
                const registeredLabel = fmtDate(truck.createdAt);

                return (
                  <article className="sd-card sd-truck-card" key={truck.id}>
                    {/* Card head — eyebrow + title left, plate + avatar right */}
                    <div className="sd-card-head">
                      <div className="sd-card-head-text">
                        <span className={`sd-eyebrow tone-${tone}`}>Truck</span>
                        <h3 className="sd-card-title" title={truck.truckType || 'Truck'}>
                          {truck.truckType || 'Truck'}
                        </h3>
                        {truck.operatingArea && (
                          <p className="sd-card-sub">{truck.operatingArea}</p>
                        )}
                      </div>

                      <div className="sd-card-head-party">
                        <div className="sd-party-info">
                          <span className="sd-party-role">Plate</span>
                          <span className="sd-party-name">{truck.registration}</span>
                        </div>
                        <div className={`sd-avatar tone-${tone}`} aria-hidden="true">
                          {initialsOf(truck.truckType || truck.registration)}
                        </div>
                      </div>
                    </div>

                    <div className="sd-card-body">
                      {/* Block 1 — Availability */}
                      <section className="sd-card-block">
                        <div className="sd-card-block-title">
                          <h4>Availability</h4>
                          <span className="sd-card-block-note">{truck.capacity}t capacity</span>
                        </div>
                        <div className="sd-card-block-body">
                          <div className="sd-pills">
                            <span className={`sd-pill tone-${tone}`}>
                              <span className="sd-pill-dot" aria-hidden="true" />
                              {truck.availability}
                            </span>
                            {truck.verificationStatus && (
                              <span className={`sd-pill tone-${verificationTone(truck.verificationStatus)}`}>
                                {truck.verificationStatus}
                              </span>
                            )}
                          </div>
                        </div>
                      </section>

                      {/* Block 2 — Fleet details */}
                      <section className="sd-card-block">
                        <div className="sd-card-block-title">
                          <h4>Fleet details</h4>
                        </div>
                        <div className="sd-card-block-body">
                          <div className="sd-facts-row">
                            <div className="sd-fact">
                              <span>Capacity</span>
                              <strong>{truck.capacity}t</strong>
                            </div>
                            <div className="sd-fact">
                              <span>Routes</span>
                              <strong>{truck.operatingArea || 'Any'}</strong>
                            </div>
                          </div>
                        </div>
                      </section>

                      {registeredLabel && (
                        <p className="sd-card-foot">Registered {registeredLabel}</p>
                      )}

                      {/* Footer */}
                      <div className="sd-card-actions">
                        <button
                          type="button"
                          className="sd-btn sd-btn-outline"
                          disabled={availabilityBusy || truck.availability === 'AVAILABLE'}
                          onClick={() => setAvailability(truck.id, 'AVAILABLE')}
                        >
                          Available
                        </button>
                        <button
                          type="button"
                          className="sd-btn sd-btn-outline"
                          disabled={availabilityBusy || truck.availability === 'BUSY'}
                          onClick={() => setAvailability(truck.id, 'BUSY')}
                        >
                          Busy
                        </button>
                        <button
                          type="button"
                          className="sd-btn sd-btn-outline"
                          disabled={availabilityBusy || truck.availability === 'OFFLINE'}
                          onClick={() => setAvailability(truck.id, 'OFFLINE')}
                        >
                          Offline
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}

              {trucks.length === 0 && (
                <div className="sd-empty-state">
                  <div className="sd-empty-icon" aria-hidden="true">🚛</div>
                  <h3>No trucks registered yet</h3>
                  <p className="sd-muted">
                    Register your first truck to start receiving suitable MarketBridge transport requests.
                  </p>
                  <button
                    type="button"
                    className="sd-btn sd-btn-primary"
                    onClick={() => setShowTruckModal(true)}
                  >
                    Register your first truck
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* =======================================================
            AVAILABLE JOBS
        ======================================================= */}

        {activeTab === 'available' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">MARKETPLACE</span>
                <h2>Open transport requests</h2>
                <p className="sd-muted">
                  Buyer-, seller-, or jointly-arranged requests looking for a transporter.
                </p>
              </div>
            </div>

            <div className="sd-cards">
              {openJobs.map((job) => {
                const quoting = actionLoading === `job-${job.id}-QUOTE`;

                const myLeaf = leafTransportQuote(job.quotes);
                const leafExpired = isQuoteExpired(myLeaf);
                // A quote the requester already accepted is settled (payment
                // pending); show that instead of offering to quote again.
                const hasAgreement = Boolean(myLeaf) && myLeaf.status === 'ACCEPTED';
                const hasActiveThread =
                  myLeaf && !leafExpired && ['PENDING', 'SELECTED', 'COUNTERED'].includes(myLeaf.status);
                const isMyTurn =
                  hasActiveThread &&
                  myLeaf.status === 'COUNTERED' &&
                  myLeaf.counteredBy === 'REQUESTER';
                const respondBusy = myLeaf && actionLoading === `quote-${myLeaf.id}`;

                const quoteAmount = hasActiveThread
                  ? fmtMoney(
                      myLeaf.status === 'COUNTERED'
                        ? (myLeaf.counterAmount ?? myLeaf.amount)
                        : myLeaf.amount
                    )
                  : null;

                const arranger = arrangerShort(job.arrangingParty);
                const createdLabel = fmtDate(job.createdAt);
                const showFooter = (!hasActiveThread && !hasAgreement) || isMyTurn;

                return (
                  <article className="sd-card sd-job-card" key={job.id}>
                    {/* Card head */}
                    <div className="sd-card-head">
                      <div className="sd-card-head-text">
                        <span className="sd-eyebrow tone-info">Open request</span>
                        <h3 className="sd-card-title" title={job.load || 'Produce'}>
                          {job.load || 'Produce'}
                        </h3>
                        {createdLabel && <p className="sd-card-sub">{createdLabel}</p>}
                      </div>

                      <div className="sd-card-head-party">
                        <div className="sd-party-info">
                          <span className="sd-party-role">Arranged by</span>
                          <span className="sd-party-name">{arranger.name}</span>
                        </div>
                        <div className="sd-avatar tone-success" aria-hidden="true">
                          {arranger.initials}
                        </div>
                      </div>
                    </div>

                    <div className="sd-card-body">
                      {/* Block 1 — Route */}
                      <section className="sd-card-block">
                        <div className="sd-card-block-title">
                          <h4>Route</h4>
                        </div>
                        <div className="sd-card-block-body">
                          <RouteStrip
                            pickup={job.pickupLocation}
                            destination={job.destination}
                          />
                        </div>
                      </section>

                      {/* Block 2 — Load details */}
                      <section className="sd-card-block">
                        <div className="sd-card-block-title">
                          <h4>Load details</h4>
                        </div>
                        <div className="sd-card-block-body">
                          <div className="sd-job-meta">
                            <div className="sd-job-meta-item">
                              <span>Load</span>
                              <strong>{job.load || 'Produce'}</strong>
                            </div>
                            {job.requiredCapacity && (
                              <div className="sd-job-meta-item">
                                <span>Capacity</span>
                                <strong>{job.requiredCapacity}t+</strong>
                              </div>
                            )}
                            <div className="sd-job-meta-item">
                              <span>Arrangement</span>
                              <strong>{getArrangingPartyLabel(job.arrangingParty)}</strong>
                            </div>
                          </div>

                          {job.specialRequirements && (
                            <div className="sd-job-requirements">
                              <span className="sd-job-requirements-label">Requirements</span>
                              <p>{job.specialRequirements}</p>
                            </div>
                          )}
                        </div>
                      </section>

                      {/* Block 3 — Your quote (only while a thread is live) */}
                      {hasActiveThread && (
                        <section className="sd-card-block">
                          <div className="sd-card-block-title">
                            <h4>{isMyTurn ? 'Counter-offer' : 'Your quote'}</h4>
                            <span className="sd-card-block-note">
                              {isMyTurn ? 'Your turn' : 'Waiting'}
                            </span>
                          </div>
                          <div className="sd-card-block-body">
                            <AmountRow value={quoteAmount} />
                            <p className="sd-amount-note">
                              {isMyTurn
                                ? 'The requester countered this price.'
                                : 'Waiting on the requester’s decision.'}
                            </p>
                          </div>
                        </section>
                      )}

                      {hasAgreement && (
                        <section className="sd-card-block">
                          <div className="sd-card-block-title">
                            <h4>Agreement reached</h4>
                            <span className="sd-card-block-note">Provisional</span>
                          </div>
                          <div className="sd-card-block-body">
                            <AmountRow value={fmtMoney(myLeaf.counterAmount ?? myLeaf.amount)} />
                            <p className="sd-amount-note">
                              Your price was accepted. The deal becomes final once the requester pays for transport.
                            </p>
                          </div>
                        </section>
                      )}

                      {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                      {/* Footer */}
                      {showFooter && (
                        <div className="sd-card-actions">
                          {!hasActiveThread && !hasAgreement && (
                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              disabled={quoting}
                              onClick={() => respondToJob(job)}
                            >
                              {quoting ? 'Sending…' : 'Submit transport quote'}
                            </button>
                          )}

                          {isMyTurn && (
                            <>
                              <button
                                type="button"
                                className="sd-btn sd-btn-primary"
                                disabled={respondBusy}
                                onClick={() => acceptTransportQuote(myLeaf.id)}
                              >
                                {respondBusy ? 'Accepting…' : 'Accept'}
                              </button>
                              <button
                                type="button"
                                className="sd-btn sd-btn-outline"
                                disabled={respondBusy}
                                onClick={() => counterTransportQuote(myLeaf.id)}
                              >
                                {respondBusy ? 'Sending…' : 'Counter'}
                              </button>
                              <button
                                type="button"
                                className="sd-btn sd-btn-outline"
                                disabled={respondBusy}
                                onClick={() => rejectTransportQuote(myLeaf.id)}
                              >
                                {respondBusy ? 'Rejecting…' : 'Reject'}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}

              {openJobs.length === 0 && (
                <div className="sd-empty-state">
                  <div className="sd-empty-icon" aria-hidden="true">📭</div>
                  <h3>No open transport requests</h3>
                  <p className="sd-muted">
                    New requests will appear here when buyers or sellers choose <strong>Hire Transporter</strong> through MarketBridge.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* =======================================================
            MY JOBS
        ======================================================= */}

        {activeTab === 'jobs' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">MY JOBS</span>
                <h2>Active and completed trips</h2>
                <p className="sd-muted">
                  Manage accepted transport jobs from pickup through delivery.
                </p>
              </div>
            </div>

            {/* ── Active trips (cards) ─────────────────────────── */}

            {activeJobs.length > 0 && (
              <section className="sd-jobs-section">
                <div className="sd-jobs-section-head">
                  <span className="sd-eyebrow">IN PROGRESS</span>
                  <h3 className="sd-jobs-section-title">
                    Active trips
                    <span className="sd-jobs-count">{activeJobs.length}</span>
                  </h3>
                </div>

                <div className="sd-cards">
                  {activeJobs.map((job) => {
                    const arranger = arrangerShort(job.arrangingParty);
                    const createdLabel = fmtDate(job.createdAt);
                    const tone = jobTone(job.status);
                    const steps = jobProgress(job.status);
                    const orderRef = shortOrder(job.orderId);
                    const amount = jobAmount(job);

                    return (
                      <article className="sd-card sd-job-card" key={job.id}>
                        {/* Card head */}
                        <div className="sd-card-head">
                          <div className="sd-card-head-text">
                            <span className={`sd-eyebrow tone-${tone}`}>Active trip</span>
                            <h3 className="sd-card-title" title={job.load || 'Produce'}>
                              {job.load || 'Produce'}
                            </h3>
                            {createdLabel && <p className="sd-card-sub">{createdLabel}</p>}
                          </div>

                          <div className="sd-card-head-party">
                            <div className="sd-party-info">
                              <span className="sd-party-role">Arranged by</span>
                              <span className="sd-party-name">{arranger.name}</span>
                            </div>
                            <div className={`sd-avatar tone-${tone}`} aria-hidden="true">
                              {arranger.initials}
                            </div>
                          </div>
                        </div>

                        <div className="sd-card-body">
                          {/* Block 1 — Trip status */}
                          <section className="sd-card-block">
                            <div className="sd-card-block-title">
                              <h4>Trip status</h4>
                              {orderRef && <span className="sd-card-block-note">{orderRef}</span>}
                            </div>
                            <div className="sd-card-block-body">
                              <div className="sd-pills">
                                <span className={`sd-pill tone-${tone}`}>
                                  <span className="sd-pill-dot" aria-hidden="true" />
                                  {job.status.replace(/_/g, ' ')}
                                </span>
                              </div>

                              <div className="sd-progress" aria-label="Trip progress">
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

                          {/* Block 2 — Route */}
                          <section className="sd-card-block">
                            <div className="sd-card-block-title">
                              <h4>Route</h4>
                            </div>
                            <div className="sd-card-block-body">
                              <RouteStrip
                                compact
                                pickup={job.pickupLocation || '—'}
                                destination={job.destination || '—'}
                              />
                            </div>
                          </section>

                          {/* Block 3 — Details */}
                          <section className="sd-card-block">
                            <div className="sd-card-block-title">
                              <h4>Trip details</h4>
                            </div>
                            <div className="sd-card-block-body">
                              <div className="sd-job-meta">
                                <div className="sd-job-meta-item">
                                  <span>Arrangement</span>
                                  <strong>{getArrangingPartyLabel(job.arrangingParty)}</strong>
                                </div>
                                {job.requiredCapacity && (
                                  <div className="sd-job-meta-item">
                                    <span>Capacity</span>
                                    <strong>{job.requiredCapacity}t+</strong>
                                  </div>
                                )}
                              </div>
                            </div>
                          </section>

                          {/* Block 4 — Amount */}
                          {amount && (
                            <section className="sd-card-block">
                              <div className="sd-card-block-title">
                                <h4>Amount</h4>
                              </div>
                              <div className="sd-card-block-body">
                                <AmountRow value={amount} />
                              </div>
                            </section>
                          )}

                          {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                          {/* Footer */}
                          <div className="sd-card-actions">
                            {renderJobActionButtons(job)}
                            <Link
                              to={`/orders/${job.orderId}`}
                              className="sd-btn sd-btn-outline"
                            >
                              View order
                              <ArrowIcon />
                            </Link>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Completed trips (table) ──────────────────────── */}

            {completedJobs.length > 0 && (
              <section className="sd-jobs-section">
                <div className="sd-jobs-section-head">
                  <span className="sd-eyebrow">HISTORY</span>
                  <h3 className="sd-jobs-section-title">
                    Completed trips
                    <span className="sd-jobs-count">{completedJobs.length}</span>
                  </h3>
                </div>

                <div className="sd-panel sd-table-wrap">
                  <table className="sd-table sd-table--mobile-cards">
                    <thead>
                      <tr>
                        <th>Load</th>
                        <th>Route</th>
                        <th>Arranged by</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {completedJobs.map((job) => (
                        <tr key={job.id}>
                          <td data-label="Load">
                            <strong>{job.load}</strong>
                          </td>
                          <td data-label="Route">
                            {job.pickupLocation} → {job.destination}
                          </td>
                          <td data-label="Arranged by">
                            {getArrangingPartyLabel(job.arrangingParty)}
                          </td>
                          <td data-label="Status">
                            <span className={getStatusClass(job.status)}>
                              {job.status}
                            </span>
                          </td>
                          <td data-label="Action">
                            <Link
                              to={`/orders/${job.orderId}`}
                              className="sd-table-action"
                            >
                              View order
                              <ArrowIcon />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ── Empty state ──────────────────────────────────── */}

            {myJobs.length === 0 && (
              <div className="sd-empty-state">
                <div className="sd-empty-icon" aria-hidden="true">📋</div>
                <h3>No transport jobs yet</h3>
                <p className="sd-muted">
                  Once a requester accepts your quote, the job will appear here with the next steps.
                </p>
                <button
                  type="button"
                  className="sd-btn sd-btn-primary"
                  onClick={() => setActiveTab('available')}
                >
                  Browse available jobs
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* =========================================================
          TOAST
      ========================================================= */}

      {toastMsg && (
        <div className="sd-toast" role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}

      {/* =========================================================
          TRUCK REGISTRATION MODAL
      ========================================================= */}

      {showTruckModal && (
        <div
          className="sd-report-backdrop"
          role="presentation"
          onClick={() => setShowTruckModal(false)}
        >
          <div
            className="sd-report-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="truck-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sd-report-header">
              <h2 id="truck-modal-title">Register a truck</h2>
              <button
                type="button"
                className="btn btn-light btn-sm"
                aria-label="Close registration form"
                onClick={() => setShowTruckModal(false)}
                disabled={actionLoading === 'register-truck'}
              >
                Close
              </button>
            </div>

            <p className="muted small">
              Register a truck so buyers and sellers can request it for transport jobs.
            </p>

            <form onSubmit={registerTruck}>
              <div className="sd-form-grid">
                <div>
                  <label htmlFor="registration">Registration plate</label>
                  <input
                    id="registration"
                    required
                    value={truckForm.registration}
                    onChange={(e) =>
                      setTruckForm({ ...truckForm, registration: e.target.value })
                    }
                    placeholder="e.g. ET-12345"
                  />
                </div>

                <div>
                  <label htmlFor="truckType">Truck type</label>
                  <input
                    id="truckType"
                    required
                    value={truckForm.truckType}
                    onChange={(e) =>
                      setTruckForm({ ...truckForm, truckType: e.target.value })
                    }
                    placeholder="e.g. Flatbed, Isuzu, FSR"
                  />
                </div>

                <div>
                  <label htmlFor="capacity">Capacity (tons)</label>
                  <input
                    id="capacity"
                    required
                    min="0.1"
                    step="0.1"
                    type="number"
                    value={truckForm.capacity}
                    onChange={(e) =>
                      setTruckForm({ ...truckForm, capacity: e.target.value })
                    }
                    placeholder="e.g. 18"
                  />
                </div>

                <div>
                  <label htmlFor="operatingArea">Operating area / routes</label>
                  <input
                    id="operatingArea"
                    value={truckForm.operatingArea}
                    onChange={(e) =>
                      setTruckForm({ ...truckForm, operatingArea: e.target.value })
                    }
                    placeholder="e.g. Addis Ababa – Jimma"
                  />
                </div>
              </div>

              <div className="sd-modal-actions sd-report-actions">
                <button
                  type="button"
                  className="sd-btn sd-btn-outline"
                  onClick={() => setShowTruckModal(false)}
                  disabled={actionLoading === 'register-truck'}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sd-btn sd-btn-primary"
                  disabled={actionLoading === 'register-truck'}
                >
                  {actionLoading === 'register-truck' ? 'Registering…' : 'Register truck'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================
          EVIDENCE CAPTURE MODAL
      ========================================================= */}

      {evidenceModal && (
        <div
          className="sd-report-backdrop"
          role="presentation"
          onClick={closeEvidenceModal}
        >
          <div
            className="sd-report-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sd-report-header">
              <h2 id="evidence-modal-title">
                {evidenceModal.type === 'PICKUP'
                  ? 'Pickup evidence'
                  : 'Delivery evidence'}
              </h2>
              <button
                type="button"
                className="btn btn-light btn-sm"
                aria-label="Close evidence form"
                onClick={closeEvidenceModal}
              >
                Close
              </button>
            </div>

            <p className="muted small">
              A photo, video, GPS location or note is required before this trip can be marked{' '}
              {evidenceModal.nextStatus === 'IN_TRANSIT' ? 'in transit' : 'delivered'}.
            </p>

            {evidenceError && <div className="alert error">{evidenceError}</div>}

            <EvidenceUploader
              uploadUrl={`/transport/${evidenceModal.jobId}/evidence/media`}
              disabled={submittingEvidence}
              onUploaded={({ photoKeys, videoKeys }) =>
                setEvidenceKeys((prev) => ({
                  photoKeys: [...prev.photoKeys, ...photoKeys],
                  videoKeys: [...prev.videoKeys, ...videoKeys],
                }))
              }
            />

            {(evidenceKeys.photoKeys.length > 0 ||
              evidenceKeys.videoKeys.length > 0) && (
              <p className="muted small">
                {evidenceKeys.photoKeys.length} photo(s),{' '}
                {evidenceKeys.videoKeys.length} video(s) ready to submit
              </p>
            )}

            <div className="sd-form-grid">
              <div>
                <label>GPS location (optional)</label>
                <input
                  value={evidenceGps}
                  onChange={(e) => setEvidenceGps(e.target.value)}
                  placeholder="lat,lng"
                />
              </div>
              <div>
                <label>Notes (optional)</label>
                <input
                  value={evidenceNotes}
                  onChange={(e) => setEvidenceNotes(e.target.value)}
                  placeholder="Condition on pickup/delivery…"
                />
              </div>
            </div>

            <div className="sd-modal-actions sd-report-actions">
              <button
                type="button"
                className="sd-btn sd-btn-primary"
                disabled={submittingEvidence}
                onClick={submitEvidenceAndAdvance}
              >
                {submittingEvidence
                  ? 'Submitting…'
                  : `Submit & mark ${
                      evidenceModal.nextStatus === 'IN_TRANSIT'
                        ? 'in transit'
                        : 'delivered'
                    }`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
