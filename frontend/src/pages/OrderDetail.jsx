import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import api from '../api/client';
import {
  startChapaPayment,
  chapaInitializeAndRedirect,
} from '../utils/chapaCheckout';

import { useAuth } from '../context/AuthContext.jsx';
import RatingBox from '../components/RatingBox.jsx';
import MessageThread from '../components/MessageThread.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import ActionCenter from '../components/ActionCenter.jsx';
import OrderTimeline from '../components/OrderTimeline.jsx';
import PaymentCenter from '../components/PaymentCenter.jsx';
import TransportSetup from '../components/TransportSetup.jsx';
import RefundStatusCard from '../components/RefundStatusCard.jsx';

const shortId = (id) => id?.slice(0, 8) || '—';

const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const getError = (error, fallback) =>
  error?.response?.data?.error ||
  error?.response?.data?.message ||
  error?.message ||
  fallback;

// Maps a raw order status string to a small set of visual "tones" so the
// status pill reads at a glance (green = good/moving, gold = waiting on
// someone, red = problem, grey = closed) without hard-coding every status
// string the backend might ever send.
const statusTone = (status) => {
  const value = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'PAID', 'ACCEPTED', 'CONFIRMED'].includes(value)) return 'good';
  if (['CANCELLED', 'REJECTED', 'FAILED', 'DISPUTED'].includes(value)) return 'bad';
  if (['PENDING', 'AWAITING_PAYMENT', 'IN_PROGRESS', 'PROCESSING'].includes(value)) return 'wait';
  return 'neutral';
};

/**
 * Ticks once a second until `targetMs` has passed, then stops. Lets the
 * payout card flip Held -> Released the moment the hold clears, without a
 * page refresh (the backend release job runs on its own schedule).
 */
function useNowUntil(targetMs) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetMs || Number.isNaN(targetMs)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [targetMs]);

  return now;
}

const PAYOUT_PAD = (n) => String(n).padStart(2, '0');

/**
 * Order payout card: Parties / Amount / Status table, then one common due
 * date with a live countdown.
 *
 * Status is time-aware. A payout the backend still marks HELD reads
 * "Held" before its release time and "Released" after it. Every other
 * backend status (paid out, dispute hold, cancelled) is shown as-is, since
 * a dispute freezes the payout no matter what the clock says.
 *
 * Hours in the countdown are NOT capped at 24 — a 3-day hold can read up to
 * ~72 hours remaining (e.g. 63:34:48).
 */
function PayoutStatusCard({
  sellerPayout,
  inspectorPayout,
  transporterPayout,
  sellerName,
  inspectorName,
  transporterName,
  isSeller,
  isInspector,
  isTransporter,
  formatDateTime,
}) {
  const parties = [
    { key: 'seller', label: 'Seller', name: sellerName, you: isSeller, payout: sellerPayout },
    inspectorPayout && { key: 'inspector', label: 'Inspector', name: inspectorName, you: isInspector, payout: inspectorPayout },
    transporterPayout && { key: 'transporter', label: 'Transporter', name: transporterName, you: isTransporter, payout: transporterPayout },
  ]
    .filter(Boolean)
    .map((party) => ({ ...party, status: party.payout?.status || null }));

  const releaseMs = (payout) => {
    const t = payout?.releaseAt ? new Date(payout.releaseAt).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  };

  // The common due is the moment the LAST live payout clears its hold, so
  // when the clock reaches zero every row reads Released. Frozen (dispute)
  // and cancelled payouts don't count towards it.
  const dueTimes = parties
    .filter((p) => ['HELD', 'RELEASED', 'PAID_OUT'].includes(p.status))
    .map((p) => releaseMs(p.payout))
    .filter((t) => t !== null);
  const dueMs = dueTimes.length ? Math.max(...dueTimes) : null;

  const now = useNowUntil(dueMs);

  const anyDispute = parties.some((p) => p.status === 'ON_HOLD_DISPUTE');
  const holdNotStarted = parties.every((p) => !p.payout);

  const statusOf = (party) => {
    const { status, payout } = party;
    if (!status) return { label: 'Pending', tone: 'tone-neutral' };
    if (status === 'HELD') {
      const at = releaseMs(payout);
      return at !== null && now >= at
        ? { label: 'Released', tone: 'tone-good' }
        : { label: 'Held', tone: 'tone-wait' };
    }
    if (status === 'RELEASED') return { label: 'Released', tone: 'tone-good' };
    if (status === 'PAID_OUT') return { label: 'Paid out', tone: 'tone-good' };
    if (status === 'ON_HOLD_DISPUTE') return { label: 'Dispute hold', tone: 'tone-bad' };
    if (status === 'CANCELLED') return { label: 'Cancelled', tone: 'tone-bad' };
    return { label: status.replace(/_/g, ' '), tone: 'tone-neutral' };
  };

  // Keep amounts aligned: show 2 decimals only when any amount needs them.
  const anyFraction = parties.some(
    (p) => p.payout?.amount != null && Number(p.payout.amount) % 1 !== 0
  );
  const amountText = (value) =>
    Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: anyFraction ? 2 : 0,
      maximumFractionDigits: 2,
    });

  const remainingMs = dueMs !== null ? Math.max(0, dueMs - now) : 0;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const clock = `${PAYOUT_PAD(Math.floor(totalSeconds / 3600))}:${PAYOUT_PAD(
    Math.floor((totalSeconds % 3600) / 60)
  )}:${PAYOUT_PAD(totalSeconds % 60)}`;
  const dueDate =
    dueMs !== null
      ? new Date(dueMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
  const duePassed = dueMs !== null && remainingMs === 0;

  return (
    <div className="card payout-summary-card" id="order-payout-status">
      <h2>Order Payout Status</h2>

      <p className="payout-intro">
        Buyer payment is separate from each payout below. Once the relevant payment settles, a{' '}
        <span className="payout-hold-chip">3-day</span> hold applies to every payout during the
        post-payment protection window.{' '}
        {anyDispute
          ? 'One or more payouts are frozen while a dispute is open.'
          : 'No manual action is required.'}
      </p>

      <table className="payout-table">
        <thead>
          <tr>
            <th scope="col">Parties</th>
            <th scope="col" className="payout-amount-col">Amount (ETB)</th>
            <th scope="col" className="payout-status-col">Status</th>
          </tr>
        </thead>
        <tbody>
          {parties.map((party) => {
            const { key, label, name, you, payout, status } = party;
            const badge = statusOf(party);
            const currency = payout?.currency && payout.currency !== 'ETB' ? payout.currency : null;
            return (
              <tr key={key}>
                <th scope="row" className="payout-party">
                  <div className="payout-party-body">
                    <span className="payout-party-line">
                      <span className="payout-party-role">{label}</span>
                      {name && <span className="payout-party-name">({name})</span>}
                      {you && <span className="party-you">You</span>}
                    </span>
                    {status === 'RELEASED' && payout?.releasedAt && (
                      <span className="payout-party-note">Released {formatDateTime(payout.releasedAt)}</span>
                    )}
                    {status === 'PAID_OUT' && payout?.paidOutAt && (
                      <span className="payout-party-note">Paid out {formatDateTime(payout.paidOutAt)}</span>
                    )}
                    {payout?.payoutReference && (
                      <span className="payout-party-note">Ref {payout.payoutReference}</span>
                    )}
                  </div>
                </th>
                <td className="payout-amount">
                  {payout?.amount != null ? (
                    <>
                      {amountText(payout.amount)}
                      {currency && <span className="payout-currency">{currency}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="payout-status">
                  <span className={`status-pill ${badge.tone}`}>{badge.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {dueMs !== null && (
        <div
          className={`payout-due${duePassed ? ' payout-due-done' : ''}`}
          role="group"
          aria-label="Common due"
        >
          <div className="payout-due-when">
            <span className="payout-due-label">Common due</span>
            <time className="payout-due-date" dateTime={new Date(dueMs).toISOString()}>
              {dueDate}
            </time>
          </div>
          <div className="payout-due-clock" role="timer" aria-live="off">
            {duePassed ? (
              <span className="payout-due-digits payout-due-digits-now">Hold cleared</span>
            ) : (
              <>
                <span className="payout-due-digits">{clock}</span>
                <span className="payout-due-unit">left</span>
              </>
            )}
          </div>
        </div>
      )}

      {dueMs === null && holdNotStarted && (
        <div className="payout-due payout-due-idle" role="group" aria-label="Common due">
          <div className="payout-due-when">
            <span className="payout-due-label">Common due</span>
            <span className="payout-due-date">Starts after payment settles</span>
          </div>
        </div>
      )}
    </div>
  );
}

const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';

/*
 * These are frontend payment-method labels only.
 *
 * Chapa credentials/secrets MUST remain on the backend.
 * The frontend only sends the selected method to POST /payments.
 */
const PAYMENT_METHODS = [
  {
    value: 'TELEBIRR',
    label: 'Telebirr via Chapa',
  },
  {
    value: 'QR',
    label: 'QR Code',
  },
];

export default function OrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [transportCounterInputs, setTransportCounterInputs] = useState({});
  const [transportEvidence, setTransportEvidence] = useState({ photoKeys: [], videoKeys: [] });
  const [transportEvidenceNotes, setTransportEvidenceNotes] = useState('');
  const [transportEvidenceBusy, setTransportEvidenceBusy] = useState(false);

  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const [inspectorId, setInspectorId] = useState('');
  const [inspectionFee, setInspectionFee] = useState('');
  const [findingInspector, setFindingInspector] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState(false);

  const [disputeAgainstId, setDisputeAgainstId] = useState('');
  const [disputeType, setDisputeType] = useState('NOT_DELIVERED');
  const [disputeDescription, setDisputeDescription] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);

  const errorToastTimer = useRef(null);

  // Action-triggered errors (e.g. clicking "Pay seller / order now" while
  // inspection is still pending) surface as a brief popup near the bottom
  // of the screen rather than a persistent banner pushed into the page,
  // so they auto-dismiss instead of sticking around after the user has
  // already read them.
  useEffect(() => {
    if (errorToastTimer.current) {
      window.clearTimeout(errorToastTimer.current);
      errorToastTimer.current = null;
    }

    if (error) {
      errorToastTimer.current = window.setTimeout(() => {
        setError('');
      }, 3000);
    }

    return () => {
      if (errorToastTimer.current) {
        window.clearTimeout(errorToastTimer.current);
      }
    };
  }, [error]);

  // ==========================================================================
  // LOAD ORDER
  // ==========================================================================

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!orderId) return;

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError('');

      try {
        const [orderResponse, workflowResponse] = await Promise.allSettled([
          api.get(`/orders/${orderId}`),
          api.get(`/orders/${orderId}/workflow`),
        ]);

        if (orderResponse.status === 'fulfilled') {
          setOrder(orderResponse.value.data?.order || null);
        } else {
          throw orderResponse.reason;
        }

        // The workflow endpoint is a summary of the same order — if it
        // fails for some reason the page still works from `order` alone,
        // it just falls back to no Action Center / timeline / payment
        // summary rather than blocking the whole page.
        setWorkflow(
          workflowResponse.status === 'fulfilled'
            ? workflowResponse.value.data?.workflow || null
            : null
        );
      } catch (err) {
        setError(
          getError(err, 'Could not load order')
        );
      } finally {
        if (silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    [orderId]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Cross-page links (e.g. SellerDashboard's "Arrange transport" button) now
  // point at /orders/:id#transport-section instead of the old dedicated
  // /orders/:id/transport route. React Router doesn't scroll to a URL hash
  // on client-side navigation the way a full page load would, and the
  // target element doesn't exist until `order` has loaded, so this waits
  // for loading to finish before scrolling.
  useEffect(() => {
    if (loading) return;
    const id = location.hash?.replace('#', '');
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading, location.hash]);

  // ==========================================================================
  // DERIVED DATA
  // ==========================================================================

  const transportJob = order?.transportJob || null;
  const payments = Array.isArray(order?.payments)
    ? order.payments
    : [];

  // AuthContext normally exposes user.id. Keep the fallbacks so payment
  // controls do not disappear if an older session shape is still cached.
  const currentUserId = user?.id || user?.userId || user?._id || null;
  const userRoles = Array.isArray(user?.roles) ? user.roles : [];

  const isAdmin = userRoles.includes('ADMIN');

  const isBuyer = Boolean(
    order &&
    currentUserId &&
    currentUserId === order.buyerId
  );

  const isSeller = Boolean(
    order &&
    currentUserId &&
    currentUserId === order.sellerId
  );

  const isParticipant = isBuyer || isSeller;

  // A payment button must only be shown to the authenticated buyer.
  // If the session is stale/mismatched, show a clear explanation instead of
  // silently hiding every payment action.
  const buyerIdentityMismatch = Boolean(
    order &&
    currentUserId &&
    !isBuyer &&
    !isSeller &&
    !isAdmin
  );

  const isAgricultural =
    order?.listing?.category === 'AGRICULTURAL';

  const inspectionRequests = useMemo(
    () =>
      (order?.listing?.inspectionRequests || [])
        .filter((request) => request.status !== 'CANCELLED')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [order?.listing?.inspectionRequests]
  );

  // The order has one canonical inspection workflow: the newest active
  // request. Older requests are retained for audit/history but must not
  // create a second payment gate or another set of request buttons.
  const currentInspectionRequest = inspectionRequests[0] || null;

  const assignedInspection = useMemo(
    () =>
      inspectionRequests.find(
        (request) => request.inspectorId === currentUserId
      ) || null,
    [inspectionRequests, currentUserId]
  );

  const isInspector = Boolean(assignedInspection);
  const isTransporter = Boolean(
    transportJob?.truckOwnerId &&
    transportJob.truckOwnerId === currentUserId
  );

  const inspectionPaymentRows = useMemo(
    () =>
      currentInspectionRequest &&
      currentInspectionRequest.fee != null &&
      Number(currentInspectionRequest.fee) > 0
        ? [currentInspectionRequest]
        : [],
    [currentInspectionRequest]
  );

  const inspectionPaymentsComplete = inspectionPaymentRows.every(
    (request) =>
      (request.payments || []).some(
        (payment) =>
          payment.type === 'INSPECTOR' &&
          payment.status === 'PAID'
      )
  );

  // Row-shaped view of each fee-bearing inspection request for the
  // PaymentCenter component — same paid/pending lookups the inline JSX used
  // to do itself, just computed once here instead of per-render inside JSX.
  const inspectionPaymentGroups = useMemo(
    () =>
      isAgricultural
        ? inspectionPaymentRows.map((request) => {
            const requestPayment =
              (request.payments || []).find(
                (payment) =>
                  payment.type === 'INSPECTOR' &&
                  ['PENDING', 'PROCESSING'].includes(payment.status)
              ) || null;
            const paid = (request.payments || []).some(
              (payment) => payment.type === 'INSPECTOR' && payment.status === 'PAID'
            );
            const busyKey = `${requestPayment?.status === 'PROCESSING' ? 'check' : requestPayment ? 'resume' : 'pay'}-inspection-${request.id}`;

            return {
              id: request.id,
              label: `${request.inspector?.name || 'Inspector'} — inspection fee`,
              amount: request.fee,
              paid,
              pending: Boolean(requestPayment),
              processing: requestPayment?.status === 'PROCESSING',
              note:
                request.status !== 'COMPLETED'
                  ? `Inspection status: ${request.status}`
                  : null,
              busyKey,
              canCheck: requestPayment?.status === 'PROCESSING',
              canResume: Boolean(requestPayment) && requestPayment.status !== 'PROCESSING',
              onCheck: () => checkPaymentStatus(requestPayment?.id, busyKey),
              onResume: () => resumePayment(requestPayment?.id, busyKey),
              onPay: () => payInspection(request),
            };
          })
        : [],
    [isAgricultural, inspectionPaymentRows]
  );

  const isTransportArranger = Boolean(
    transportJob &&
    (
      (transportJob.arrangingParty === 'BUYER' && isBuyer) ||
      (transportJob.arrangingParty === 'SELLER' && isSeller) ||
      (transportJob.arrangingParty === 'JOINT' && isParticipant)
    )
  );

  const inspectionPaid = Boolean(
    order?.listing?.inspectionRequests?.some(
      (request) =>
        request.payments?.some(
          (payment) =>
            payment.type === 'INSPECTOR' &&
            payment.status === 'PAID'
        )
    )
  );

  const title =
    order?.listing?.title ||
    order?.listing?.cropType ||
    'Order';

  // ==========================================================================
  // PAYMENT GROUPS
  // ==========================================================================

  const marketplacePayments = useMemo(
    () =>
      payments.filter(
        (payment) =>
          payment.type === 'MARKETPLACE'
      ),
    [payments]
  );

  const transportPayments = useMemo(
    () =>
      payments.filter(
        (payment) =>
          payment.type === 'TRANSPORT'
      ),
    [payments]
  );

  /*
   * Prefer the most recent active payment.
   */
  const marketplacePayment = useMemo(() => {
    return (
      marketplacePayments.find((payment) => ['PENDING', 'PROCESSING'].includes(payment.status)) ||
      marketplacePayments.find((payment) => payment.status === 'PAID') ||
      null
    );
  }, [marketplacePayments]);

  const transportPayment = useMemo(() => {
    return (
      transportPayments.find(
        (payment) =>
          ['PENDING', 'PROCESSING'].includes(payment.status)
      ) ||
      transportPayments.find(
        (payment) =>
          payment.status === 'PAID'
      ) ||
      null
    );
  }, [transportPayments]);

  const marketplacePaid =
    marketplacePayments.some(
      (payment) =>
        payment.status === 'PAID'
    );

  const marketplacePending =
    marketplacePayments.some((payment) =>
      ['PENDING', 'PROCESSING'].includes(payment.status)
    );

  const marketplaceProcessing =
    marketplacePayments.some((payment) => payment.status === 'PROCESSING');

  const transportPaid =
    transportPayments.some(
      (payment) =>
        payment.status === 'PAID'
    );

  // An order can carry up to three payout rows — seller, hired transporter,
  // inspector — whichever of those roles were actually paid on this order.
  const payouts = order?.payouts || [];
  const sellerPayout = payouts.find((p) => p.payeeRole === 'SELLER') || null;
  const transporterPayout = payouts.find((p) => p.payeeRole === 'TRANSPORTER') || null;
  const inspectorPayout = payouts.find((p) => p.payeeRole === 'INSPECTOR') || null;
  const payoutStatus = sellerPayout?.status || null;
  const refunds = order?.refunds || [];

  const formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  };

  const transportPending =
    transportPayments.some(
      (payment) =>
        ['PENDING', 'PROCESSING'].includes(payment.status)
    );

  const transportProcessing =
    transportPayments.some((payment) => payment.status === 'PROCESSING');

  // ==========================================================================
  // TRANSPORT PERMISSIONS
  // ==========================================================================

  /*
   * Buyer or seller can create a transport job. Joint arrangements
   * are supported through the transport workflow.
   */
  const canArrangeTransport =
    Boolean(order) &&
    !transportJob &&
    order.status !== 'CANCELLED' &&
    isParticipant;

  /*
   * Only the arranging buyer/seller can select a quote.
   *
   * The backend accepts:
   * PATCH /transport/quotes/:quoteId
   * { action: 'ACCEPT' }
   */
  const canChooseQuote =
    Boolean(transportJob) &&
    isTransportArranger &&
    ['REQUESTED', 'QUOTED'].includes(
      transportJob.status
    ) &&
    !transportJob.truckOwnerId;

  /*
   * Transport payment is ONLY for hired transport.
   *
   * OWN_TRUCK does not create a separate transport payment.
   *
   * Marketplace and transport payments are independent. Both must be
   * PAID before the transporter can mark the load PICKUP (i.e. before the
   * truck is allowed to collect the goods).
   */
  const canStartTransportPayment =
    Boolean(transportJob) &&
    transportJob.method ===
      'HIRE_TRANSPORTER' &&
    Boolean(transportJob.truckOwnerId) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    transportJob.status === 'ACCEPTED' &&
    !transportPayments.some(
      (payment) =>
        payment.status === 'PENDING' ||
        payment.status === 'PROCESSING' ||
        payment.status === 'PAID'
    ) &&
    isBuyer;

  /*
   * Resume an existing pending transport payment.
   */
  const canResumeTransportPayment =
    Boolean(transportPayment) &&
    transportPayment.status === 'PENDING' &&
    isBuyer;

  /*
   * A transport payment already reached Chapa (PROCESSING) — same shape as
   * canCheckMarketplacePayment. Don't let the buyer start a second payment;
   * point them at checking the status of this one instead.
   */
  const canCheckTransportPayment =
    Boolean(transportPayment) &&
    transportPayment.status === 'PROCESSING' &&
    isBuyer;

  // ==========================================================================
  // MARKETPLACE PAYMENT PERMISSIONS
  // ==========================================================================

  /*
   * Marketplace payment can only be initiated by the buyer.
   *
   * Agricultural marketplace payment is independent from transport.
   * Required payments are separately tracked and the transport state machine
   * prevents PICKUP until all required payments are PAID.
   */
  // Agricultural goods payment becomes available after the current
  // inspection report is complete. The backend is authoritative and applies
  // the same gate, so a stale UI can never bypass it.
  const agriculturalGateMet =
    !isAgricultural ||
    (currentInspectionRequest &&
      currentInspectionRequest.status === 'COMPLETED' &&
      Boolean(currentInspectionRequest.report) &&
      order?.buyerDecision === 'BUY');

  const canPayMarketplace =
    Boolean(order) &&
    order.status !== 'COMPLETED' &&
    order.status !== 'CANCELLED' &&
    isBuyer &&
    agriculturalGateMet &&
    !marketplacePayments.some((payment) =>
      ['PENDING', 'PROCESSING', 'PAID'].includes(payment.status)
    );

  const marketplaceBlockedReason =
    isAgricultural && !agriculturalGateMet
      ? (!currentInspectionRequest || currentInspectionRequest.status !== 'COMPLETED' || !currentInspectionRequest.report
        ? 'Complete the current agricultural inspection and make sure its report is published before paying for the goods.'
        : 'Choose BUY after reviewing the inspection report before paying for the goods.')
      : null;

  /*
   * Resume an already-created pending marketplace payment.
   */
  const canResumeMarketplacePayment =
    Boolean(marketplacePayment) &&
    marketplacePayment.status === 'PENDING' &&
    isBuyer;

  const canCheckMarketplacePayment =
    Boolean(marketplacePayment) &&
    marketplacePayment.status === 'PROCESSING' &&
    isBuyer;

  // ==========================================================================
  // COUNTERPARTY
  // ==========================================================================

  const counterpartId = isBuyer
    ? order?.sellerId
    : isSeller
      ? order?.buyerId
      : null;

  const counterpartName = isBuyer
    ? order?.seller?.name
    : isSeller
      ? order?.buyer?.name
      : null;

  // ==========================================================================
  // ACCEPT TRANSPORT QUOTE
  // ==========================================================================

  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  const acceptQuote = async (quoteId) => {
    if (!quoteId) return;

    setBusy(`quote-${quoteId}`);
    setError('');

    try {
      /*
       * Correct backend contract:
       *
       * PATCH /transport/quotes/:quoteId
       * {
       *   action: 'ACCEPT'
       * }
       */
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'ACCEPT' });
      await load({ silent: true });
      window.setTimeout(() => document.getElementById('payment-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } catch (err) {
      setError(
        getError(
          err,
          'Could not accept transport quote'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // A quote's negotiation thread is only "live" at its leaf: the row that
  // no later counter-quote points back to as a parent.
  // Transport negotiations are immutable parent -> child chains. The
  // actionable quote is every quote with no child; never use the root quote
  // after a counter has been created.
  const leafTransportQuotes = (quotes) => {
    const list = Array.isArray(quotes) ? quotes : [];
    const parentIds = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
    return list.filter((q) => !parentIds.has(q.id));
  };

  const counterQuote = async (quoteId) => {
    if (!quoteId) return;
    const amount = Number(transportCounterInputs[quoteId]);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter a valid counter amount before sending.');
      return;
    }

    setBusy(`quote-${quoteId}`);
    setError('');

    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'COUNTER', counterAmount: amount });
      setTransportCounterInputs((q) => ({ ...q, [quoteId]: '' }));
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not send counter-offer'));
    } finally {
      setBusy('');
    }
  };

  const rejectQuote = async (quoteId) => {
    if (!quoteId) return;

    setBusy(`quote-${quoteId}`);
    setError('');

    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'REJECT' });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not reject transport quote'));
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // START MARKETPLACE PAYMENT
  // ==========================================================================

  const payMarketplace = async () => {
    if (!order) return;

    if (!isBuyer) {
      setError(
        'Only the buyer can make the marketplace payment'
      );
      return;
    }

    const amount = Number(order.finalPrice);

    if (!Number.isFinite(amount) || amount <= 0) {
      setError(
        'Invalid marketplace payment amount'
      );
      return;
    }

    setBusy('pay-marketplace');
    setError('');

    try {
      /*
       * startChapaPayment:
       *
       * POST /payments
       * then
       * POST /payments/:paymentId/chapa/initialize
       *
       * Chapa secrets remain on the backend.
       */
      await startChapaPayment({
        type: 'MARKETPLACE',
        orderId: order.id,
        amount,
        method: payMethod,
      });

      /*
       * Normally the browser is redirected to Chapa.
       * This refresh is useful if the backend returns without
       * navigating, or for future payment providers.
       */
      await load({ silent: true });
    } catch (err) {
      setError(
        getError(
          err,
          'Could not start marketplace payment'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // REQUEST INSPECTION (from the order, once the listing is no longer
  // reachable from the marketplace because it is reserved/sold)
  // ==========================================================================

  const findInspector = async () => {
    if (!order?.listing) return;

    setFindingInspector(true);
    setError('');

    try {
      const response = await api.get('/inspections/inspectors', {
        params: { location: order.listing.location },
      });

      const options = response.data?.inspectors || [];

      if (!options.length) {
        setError('No inspectors were found in this area.');
        return;
      }

      setInspectorId(options[0].id);
    } catch (err) {
      setError(getError(err, 'Could not load inspectors'));
    } finally {
      setFindingInspector(false);
    }
  };

  const requestInspection = async (mode) => {
    if (!order?.listing) return;

    setError('');

    if (inspectorId && (!inspectionFee || Number(inspectionFee) <= 0)) {
      setError('Enter the agreed inspection fee before requesting this inspector.');
      return;
    }

    setRequestingInspection(true);

    try {
      const body = { orderId: order.id, listingId: order.listing.id, mode };

      if (inspectorId) {
        body.inspectorId = inspectorId;
        body.fee = Number(inspectionFee);
      }

      await api.post('/inspections', body);

      setInspectorId('');
      setInspectionFee('');

      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not request inspection'));
    } finally {
      setRequestingInspection(false);
    }
  };

  // ==========================================================================
  // TRANSPORT EVIDENCE / MOVEMENT
  // ==========================================================================

  const submitTransportEvidence = async (type, nextStatus) => {
    if (!transportJob || !isTransporter) return;

    const { photoKeys, videoKeys } = transportEvidence;
    if (!photoKeys.length && !videoKeys.length && !transportEvidenceNotes.trim()) {
      setError(`Add at least one ${type.toLowerCase()} photo/video or note before continuing.`);
      return;
    }

    setTransportEvidenceBusy(true);
    setError('');

    try {
      await api.post(`/transport/${transportJob.id}/evidence`, {
        type,
        photos: photoKeys,
        videos: videoKeys,
        notes: transportEvidenceNotes.trim() || undefined,
      });

      if (nextStatus) {
        await api.patch(`/transport/${transportJob.id}/status`, {
          status: nextStatus,
        });
      }

      setTransportEvidence({ photoKeys: [], videoKeys: [] });
      setTransportEvidenceNotes('');
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, `Could not submit ${type.toLowerCase()} evidence`));
    } finally {
      setTransportEvidenceBusy(false);
    }
  };

  // ==========================================================================
  // START TRANSPORT PAYMENT
  // ==========================================================================

  const payTransport = async () => {
    if (!order || !transportJob) return;

    if (!isParticipant) {
      setError(
        'You are not authorized to pay for this transport'
      );
      return;
    }

    if (
      transportJob.method !==
      'HIRE_TRANSPORTER'
    ) {
      setError(
        'Transport payment is only required for hired transport'
      );
      return;
    }

    if (!transportJob.truckOwnerId) {
      setError(
        'A transporter must be selected before transport payment'
      );
      return;
    }

    const amount = Number(
      transportJob.agreedAmount
    );

    if (!Number.isFinite(amount) || amount <= 0) {
      setError(
        'Invalid transport payment amount'
      );
      return;
    }

    setBusy('pay-transport');
    setError('');

    try {
      await startChapaPayment({
        type: 'TRANSPORT',
        orderId: order.id,
        amount,
        method: payMethod,
      });

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(
          err,
          'Could not start transport payment'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // Pay a fee-bearing inspection request. Extracted from an inline onClick
  // (previously duplicated the same startChapaPayment shape as
  // payMarketplace/payTransport) so PaymentCenter can call it directly per
  // row instead of re-declaring it in JSX.
  const payInspection = async (request) => {
    if (!request?.id || !request.fee) return;

    setBusy(`pay-inspection-${request.id}`);
    setError('');
    try {
      await startChapaPayment({
        type: 'INSPECTOR',
        inspectionRequestId: request.id,
        orderId: order.id,
        amount: Number(request.fee),
        method: payMethod,
      });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not start inspector payment'));
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // CHECK PROCESSING PAYMENT
  // ==========================================================================

  const checkMarketplacePayment = async () => {
    if (!marketplacePayment?.id) return;

    setBusy('check-marketplace');
    setError('');
    try {
      const response = await api.get(`/payments/${marketplacePayment.id}/chapa/verify`);
      await load({ silent: true });
      const status = response.data?.status;
      if (status === 'PENDING') {
        setError('Chapa has not confirmed the seller payment yet. If you cancelled or the checkout failed, return to the order and retry once the payment shows FAILED.');
      }
    } catch (err) {
      setError(getError(err, 'Could not check seller payment status'));
    } finally {
      setBusy('');
    }
  };

  // Same PROCESSING-status check as checkMarketplacePayment above, but for
  // any payment id (inspection or transport). marketplacePayment used its
  // own dedicated handler because it's looked up once via useMemo; this one
  // takes the id directly since inspection payments are found per-row.
  const checkPaymentStatus = async (paymentId, busyKey) => {
    if (!paymentId) return;

    setBusy(busyKey);
    setError('');
    try {
      const response = await api.get(`/payments/${paymentId}/chapa/verify`);
      await load({ silent: true });
      const status = response.data?.status;
      if (status === 'PENDING') {
        setError('Chapa has not confirmed this payment yet. If you cancelled or the checkout failed, return to the order and retry once the payment shows FAILED.');
      }
    } catch (err) {
      setError(getError(err, 'Could not check payment status'));
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // RESUME PAYMENT
  // ==========================================================================

  const resumePayment = async (
    paymentId,
    busyKey
  ) => {
    if (!paymentId) return;

    setBusy(busyKey);
    setError('');

    try {
      await chapaInitializeAndRedirect(
        paymentId
      );

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(
          err,
          'Could not resume payment'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // ADMIN: SETTLE A REFUND
  // ==========================================================================
  // Refunds are durable requests; only an admin can confirm the money went
  // back (or record that the provider refused). Both call the existing admin
  // refund endpoints — the Refund card shows the buttons to admins only.

  const completeRefundAsAdmin = async (refund) => {
    const reference = window.prompt(
      'Provider reference for this refund (optional):',
      ''
    );
    if (reference === null) return;

    setBusy(`refund-${refund.id}`);
    setError('');
    try {
      await api.patch(`/admin/financial/refunds/${refund.id}/complete`, {
        providerRefundId: reference.trim() || undefined,
      });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not mark the refund as completed'));
    } finally {
      setBusy('');
    }
  };

  const failRefundAsAdmin = async (refund) => {
    const reason = window.prompt('Why did this refund fail?', '');
    if (reason === null) return;
    if (!reason.trim()) {
      setError('Enter a reason before marking a refund as failed.');
      return;
    }

    setBusy(`refund-${refund.id}`);
    setError('');
    try {
      await api.patch(`/admin/financial/refunds/${refund.id}/fail`, {
        failureReason: reason.trim(),
      });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not mark the refund as failed'));
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // RAISE DISPUTE
  // ==========================================================================
  // PDF recommendation #5/#18: RAISE_DISPUTE is already reported as an
  // available action by GET /orders/:id/workflow and POST /disputes already
  // exists on the backend, but there was previously no UI anywhere to raise
  // one. Every other participant on this order (buyer, seller, and the
  // hired truck owner if one is assigned) is a valid target.

  const disputeCounterparties = useMemo(() => {
    if (!order) return [];
    const parties = [
      order.buyer && { id: order.buyer.id, name: order.buyer.name, role: 'Buyer' },
      order.seller && { id: order.seller.id, name: order.seller.name, role: 'Seller' },
      transportJob?.truckOwner && {
        id: transportJob.truckOwner.id,
        name: transportJob.truckOwner.name,
        role: 'Truck owner',
      },
    ].filter(Boolean);
    return parties.filter((p) => p.id !== currentUserId);
  }, [order, transportJob, currentUserId]);

  const canRaiseDispute = Boolean(
    order &&
    !['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(order.status) &&
    (isBuyer || isSeller || isTransporter) &&
    disputeCounterparties.length > 0
  );

  const raiseDispute = async (event) => {
    event.preventDefault();
    if (!order || !canRaiseDispute) return;

    if (!disputeAgainstId) {
      setError('Choose who the dispute is against');
      return;
    }

    if (!disputeDescription.trim()) {
      setError('Describe what went wrong');
      return;
    }

    setSubmittingDispute(true);
    setError('');

    try {
      await api.post('/disputes', {
        orderId: order.id,
        againstId: disputeAgainstId,
        disputeType,
        description: disputeDescription.trim(),
      });

      setDisputeSubmitted(true);
      setDisputeDescription('');
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not raise dispute'));
    } finally {
      setSubmittingDispute(false);
    }
  };

  // ==========================================================================
  // CONFIRM RECEIPT
  // ==========================================================================

  const confirmReceipt = async () => {
    if (!order) return;

    if (!isBuyer) {
      setError(
        'Only the buyer can confirm receipt'
      );
      return;
    }

    if (!marketplacePaid) {
      setError(
        'Marketplace payment must be confirmed before receipt'
      );
      return;
    }

    if (
      transportJob?.method ===
        'HIRE_TRANSPORTER' &&
      !transportPaid
    ) {
      setError(
        'Transport payment must be confirmed before receipt'
      );
      return;
    }

    setBusy('receipt');
    setError('');

    try {
      await api.patch(
        `/orders/${order.id}/confirm-receipt`
      );

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(
          err,
          'Could not confirm receipt'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // CANCEL ORDER
  // ==========================================================================

  // Mirrors the backend's rules in routes/orders.js so the button only shows
  // up when the call is actually going to succeed. The backend is still the
  // source of truth / re-checks all of this itself.
  const transportInMotion = Boolean(
    transportJob &&
    ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(transportJob.status)
  );

  const canCancelOrder = Boolean(
    order &&
    order.status !== 'COMPLETED' &&
    order.status !== 'CANCELLED' &&
    !transportInMotion &&
    (
      isAdmin ||
      (isBuyer && order.status === 'PENDING_PAYMENT') ||
      (isSeller && ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status))
    )
  );

  const cancelOrder = async () => {
    if (!order || !canCancelOrder) return;

    const confirmed = window.confirm(
      'Cancel this order? This cannot be undone. The listing will become available again and any completed payments will be flagged for refund.'
    );

    if (!confirmed) return;

    const reason = window.prompt(
      'Optional: add a reason for cancelling (shown in the order history).'
    ) || undefined;

    setBusy('cancel');
    setError('');

    try {
      await api.patch(
        `/orders/${order.id}/cancel`,
        reason ? { reason } : {}
      );

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(
          err,
          'Could not cancel order'
        )
      );
    } finally {
      setBusy('');
    }
  };

  // ==========================================================================
  // PAYMENT CENTER PROPS
  // ==========================================================================
  // Package the already-computed gating flags/handlers above into the shape
  // PaymentCenter expects, one object per obligation. No new gating logic —
  // this is purely so the render below passes one prop instead of wiring
  // ~15 individual flags/handlers by hand in JSX.

  const marketplaceObligation = {
    amount: order?.finalPrice,
    paid: marketplacePaid,
    pending: marketplacePending,
    processing: marketplaceProcessing,
    canPay: canPayMarketplace,
    canResume: canResumeMarketplacePayment,
    canCheck: canCheckMarketplacePayment,
    onPay: payMarketplace,
    onResume: () => resumePayment(marketplacePayment?.id, 'resume-marketplace'),
    onCheck: checkMarketplacePayment,
  };

  const transportObligation = transportJob
    ? {
        required: transportJob.method === 'HIRE_TRANSPORTER',
        readyToPay: transportJob.status === 'ACCEPTED' && transportJob.agreedAmount != null,
        amount: transportJob.agreedAmount,
        paid: transportPaid,
        pending: transportPending,
        processing: transportProcessing,
        note:
          transportJob.method === 'HIRE_TRANSPORTER' &&
          transportJob.status !== 'ACCEPTED' &&
          !transportPaid &&
          !transportPending
            ? 'Transporter payment becomes available after the transporter quote is accepted.'
            : null,
        canStart: canStartTransportPayment,
        canResume: canResumeTransportPayment,
        canCheck: canCheckTransportPayment,
        onStart: payTransport,
        onResume: () => resumePayment(transportPayment?.id, 'resume-transport'),
        onCheck: () => checkPaymentStatus(transportPayment?.id, 'check-transport'),
      }
    : null;

  // ==========================================================================
  // LOADING
  // ==========================================================================

  if (loading) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <div className="card loading">
            <p>Loading order…</p>
          </div>
        </div>
      </main>
    );
  }

  // ==========================================================================
  // NOT FOUND
  // ==========================================================================

  if (!order) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <button
            type="button"
            className="back-link"
            onClick={() => navigate(-1)}
          >
            ← Back
          </button>

          <div className="alert error">
            {error || 'Order not found'}
          </div>
        </div>
      </main>
    );
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <main className="section order-detail-page">
      <div className="container-narrow">

        {/* ================================================================== */}
        {/* HEADER */}
        {/* ================================================================== */}

        <div
          className="row-between"
          style={{ marginBottom: 16 }}
        >
          <button
            type="button"
            className="back-link"
            onClick={() => navigate(-1)}
          >
            ← Back
          </button>

          <button
            type="button"
            className="btn btn-sm"
            disabled={refreshing}
            onClick={() =>
              load({ silent: true })
            }
          >
            {refreshing
              ? 'Refreshing…'
              : 'Refresh'}
          </button>
        </div>

        <div className="order-hero">
          <div className="order-hero-main">
            <span className="eyebrow order-hero-eyebrow">
              ORDER {shortId(order.id)}
            </span>

            <h1 className="order-hero-title">{title}</h1>

            <div className="order-hero-meta">
              <span className={`status-pill tone-${statusTone(order.status)}`}>
                <span className="status-pill-dot" aria-hidden="true" />
                {String(order.status || '').replace(/_/g, ' ')}
              </span>

              {order.listing?.cropType && (
                <span className="order-hero-chip">{order.listing.cropType}</span>
              )}

              {order.listing?.quantity != null && (
                <span className="order-hero-chip">{order.listing.quantity} units</span>
              )}
            </div>
          </div>

          <div className="order-hero-side">
            <span className="order-hero-price-label">Order total</span>
            <span className="order-hero-price">{money(order.finalPrice)} <small>ETB</small></span>

            {canCancelOrder && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy === 'cancel'}
                onClick={cancelOrder}
              >
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
              </button>
            )}
          </div>
        </div>

        {/* ================================================================== */}
        {/* NEXT ACTION CENTER */}
        {/* ================================================================== */}
        {/* Driven by GET /orders/:id/workflow (orderWorkflowService.js) rather */}
        {/* than reconstructing these rules per role here. See ActionCenter.jsx. */}

        {workflow ? (
          <ActionCenter
            workflow={workflow}
            onScroll={scrollToSection}
            onActionComplete={() => load({ silent: true })}
          />
        ) : (
          isInspector && (
            <div className="card next-action-card" id="next-action">
              <span className="eyebrow">NEXT STEP</span>
              <h2 style={{ marginBottom: 6 }}>Inspector action</h2>
              {assignedInspection.status === 'ACCEPTED' && <p>Start the accepted inspection.</p>}
              {assignedInspection.status === 'IN_PROGRESS' && <p>Complete the inspection and publish the evidence report.</p>}
              {assignedInspection.status === 'COMPLETED' && <p>Inspection report is published. The buyer can now complete any required inspection payment and continue the order.</p>}
              <div className="next-action-buttons">
                <Link className="btn btn-primary" to="/dashboard/inspector">Open inspection dashboard</Link>
              </div>
            </div>
          )
        )}

        {/* ================================================================== */}
        {/* TIMELINE */}
        {/* ================================================================== */}
        {/* Payment status now lives only in the Payment Center card below — */}
        {/* it used to also render here (via <PaymentStatus>) and again as a */}
        {/* flat ledger near the bottom, three places for the same numbers. */}

        {workflow && (
          <div className="card">
            <h2>Order timeline</h2>
            <OrderTimeline steps={workflow.timeline?.steps} events={workflow.timeline?.events} />
          </div>
        )}

        {/* ================================================================== */}
        {/* ORDER DETAILS */}
        {/* ================================================================== */}

        <div className="card-grid two-col order-summary-grid">
          <div className="card">
            <h2>Order details</h2>

            <div className="detail-facts">
              <div>
                <span>Order</span>
                <strong>
                  {shortId(order.id)}
                </strong>
              </div>

              <div>
                <span>Status</span>
                <strong>
                  {order.status}
                </strong>
              </div>

              <div>
                <span>Amount</span>
                <strong>
                  {money(order.finalPrice)} ETB
                </strong>
              </div>

              {order.listing?.cropType && (
                <div>
                  <span>Product</span>
                  <strong>
                    {order.listing.cropType}
                  </strong>
                </div>
              )}

              {order.listing?.quantity != null && (
                <div>
                  <span>Quantity</span>
                  <strong>
                    {order.listing.quantity}
                  </strong>
                </div>
              )}
            </div>
          </div>

          {/* ================================================================ */}
          {/* PARTIES */}
          {/* ================================================================ */}

          <div className="card">
            <h2>Parties</h2>

            <div className="party-list">
              <div className="party-row">
                <span className="party-avatar" aria-hidden="true">{initials(order.buyer?.name)}</span>
                <div>
                  <span className="party-role">Buyer</span>
                  <strong className="party-name">{order.buyer?.name || '—'}</strong>
                </div>
                {isBuyer && <span className="party-you">You</span>}
              </div>

              <div className="party-row">
                <span className="party-avatar party-avatar-seller" aria-hidden="true">{initials(order.seller?.name)}</span>
                <div>
                  <span className="party-role">Seller</span>
                  <strong className="party-name">{order.seller?.name || '—'}</strong>
                </div>
                {isSeller && <span className="party-you">You</span>}
              </div>
            </div>
          </div>
        </div>

        {/* ================================================================== */}
        {/* REQUEST INSPECTION */}
        {/* ================================================================== */}
        {/* Once an offer is accepted the listing becomes unavailable to new */}
        {/* buyers, which also hides the "Request inspection" controls on the */}
        {/* listing page. Buyer and seller can still request an inspection */}
        {/* from here for as long as the order isn't finished. */}

        <div id="inspection-section">
        {isAgricultural && isParticipant && order.status !== 'COMPLETED' && order.status !== 'CANCELLED' && (
          currentInspectionRequest ? (
            <div className="card">
              <h2>Inspection</h2>
              <p className="muted">An inspection already exists for this order. Continue with this inspection; a second request is not needed.</p>
              <div className="detail-facts">
                <div><span>Status</span><strong>{currentInspectionRequest.status}</strong></div>
                {currentInspectionRequest.inspector?.name && <div><span>Inspector</span><strong>{currentInspectionRequest.inspector.name}</strong></div>}
                {currentInspectionRequest.fee != null && <div><span>Fee</span><strong>{money(currentInspectionRequest.fee)} ETB</strong></div>}
              </div>
              {currentInspectionRequest.status === 'COMPLETED' && currentInspectionRequest.report && (
                <p className="muted" style={{ marginTop: 10 }}>Inspection report is available. The buyer can now proceed to the goods payment.</p>
              )}
            </div>
          ) : (
            <div className="card">
              <h2>Request inspection</h2>
              <p className="muted">Request an independent quality check for this order.</p>
              {inspectorId && (
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  placeholder="Agreed fee (ETB)"
                  value={inspectionFee}
                  onChange={(event) => setInspectionFee(event.target.value)}
                  style={{ marginBottom: 8, width: '100%' }}
                />
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={requestingInspection}
                  onClick={() => requestInspection(isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}
                >
                  {requestingInspection ? 'Requesting…' : 'Request inspection'}
                </button>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={findingInspector}
                  onClick={findInspector}
                >
                  {findingInspector ? 'Searching…' : 'Find an inspector'}
                </button>
              </div>
            </div>
          )
        )}
        </div>

        {/* ================================================================== */}
        {/* TRANSPORT */}
        {/* ================================================================== */}

        <div className="card" id="transport-section">
          <div className="row-between">
            <div>
              <h2>Transport</h2>

              <p className="muted">
                The buyer or seller arranges
                transport. MarketBridge does not
                automatically assign a transporter.
              </p>
            </div>
          </div>

          {!transportJob ? (
            canArrangeTransport ? (
              <TransportSetup
                orderId={order.id}
                pickupDefault={order.listing?.location}
                destinationDefault={order.buyer?.location}
                canBuyer={isBuyer}
                canSeller={isSeller}
                onCreated={() => load({ silent: true })}
              />
            ) : (
              <div className="notice">
                <p>
                  No transport arrangement recorded
                  yet.
                </p>
              </div>
            )
          ) : (
            <>
              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT SUMMARY */}
              {/* ------------------------------------------------------------ */}

              <div className="detail-facts">
                <div>
                  <span>Arranged by</span>
                  <strong>
                    {transportJob.arrangingParty ||
                      '—'}
                  </strong>
                </div>

                <div>
                  <span>Method</span>
                  <strong>
                    {transportJob.method || '—'}
                  </strong>
                </div>

                <div>
                  <span>Status</span>
                  <strong>
                    <span className="badge">
                      {transportJob.status}
                    </span>
                  </strong>
                </div>

                <div>
                  <span>Pickup</span>
                  <strong>
                    {transportJob.pickupLocation ||
                      '—'}
                  </strong>
                </div>

                <div>
                  <span>Destination</span>
                  <strong>
                    {transportJob.destination ||
                      '—'}
                  </strong>
                </div>

                {transportJob.load && (
                  <div>
                    <span>Load</span>
                    <strong>
                      {transportJob.load}
                    </strong>
                  </div>
                )}

                {transportJob.requiredCapacity !=
                  null && (
                  <div>
                    <span>Required capacity</span>
                    <strong>
                      {transportJob.requiredCapacity}
                    </strong>
                  </div>
                )}
              </div>

              {/* ------------------------------------------------------------ */}
              {/* ASSIGNED TRANSPORTER */}
              {/* ------------------------------------------------------------ */}

              {transportJob.truckOwner && (
                <div className="notice">
                  <h3>Transporter</h3>

                  <p>
                    <strong>
                      {transportJob.truckOwner
                        .name || '—'}
                    </strong>
                  </p>

                  {transportJob.truckOwner
                    .phone && (
                    <p className="muted">
                      Phone:{' '}
                      {
                        transportJob
                          .truckOwner.phone
                      }
                    </p>
                  )}

                  {transportJob.truck && (
                    <p>
                      Truck:{' '}
                      <strong>
                        {transportJob.truck
                          .registration ||
                          '—'}
                      </strong>
                      {' · '}
                      {transportJob.truck
                        .truckType ||
                        'Truck'}
                      {transportJob.truck
                        .capacity != null &&
                        ` · ${transportJob.truck.capacity}t`}
                    </p>
                  )}

                  {transportJob.agreedAmount !=
                    null && (
                    <p>
                      Agreed transport fee:{' '}
                      <strong>
                        {money(
                          transportJob.agreedAmount
                        )}{' '}
                        ETB
                      </strong>
                    </p>
                  )}
                </div>
              )}

              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT EVIDENCE */}
              {/* ------------------------------------------------------------ */}

              <div className="notice">
                <h3>Pickup / delivery evidence</h3>
                <p className="muted">
                  Pickup evidence is required before the transporter can move this trip from <strong>PICKUP</strong> to <strong>IN TRANSIT</strong>. Upload a photo or video here, then submit it with the status change.
                </p>

                {isTransporter && transportJob.status === 'PICKUP' && (
                  <div className="notice" style={{ marginTop: 10 }}>
                    <strong>Pickup evidence required</strong>
                    <EvidenceUploader
                      uploadUrl={`/transport/${transportJob.id}/evidence/media`}
                      disabled={transportEvidenceBusy}
                      onUploaded={({ photoKeys, videoKeys }) =>
                        setTransportEvidence((prev) => ({
                          photoKeys: [...prev.photoKeys, ...photoKeys],
                          videoKeys: [...prev.videoKeys, ...videoKeys],
                        }))
                      }
                    />

                    {(transportEvidence.photoKeys.length > 0 || transportEvidence.videoKeys.length > 0) && (
                      <p className="muted small">
                        {transportEvidence.photoKeys.length} photo(s), {transportEvidence.videoKeys.length} video(s) ready.
                      </p>
                    )}

                    <textarea
                      value={transportEvidenceNotes}
                      onChange={(event) => setTransportEvidenceNotes(event.target.value)}
                      placeholder="Optional pickup condition / handover notes..."
                      rows={3}
                      disabled={transportEvidenceBusy}
                      style={{ width: '100%', marginTop: 8 }}
                    />

                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={transportEvidenceBusy || (!transportEvidence.photoKeys.length && !transportEvidence.videoKeys.length && !transportEvidenceNotes.trim())}
                      onClick={() => submitTransportEvidence('PICKUP', 'IN_TRANSIT')}
                      style={{ marginTop: 8 }}
                    >
                      {transportEvidenceBusy ? 'Submitting…' : 'Submit pickup evidence & mark in transit'}
                    </button>
                  </div>
                )}

                {isTransporter && transportJob.status === 'IN_TRANSIT' && (
                  <div className="notice" style={{ marginTop: 10 }}>
                    <strong>Delivery evidence</strong>
                    <p className="muted">Upload delivery evidence before marking the trip DELIVERED.</p>
                    <EvidenceUploader
                      uploadUrl={`/transport/${transportJob.id}/evidence/media`}
                      disabled={transportEvidenceBusy}
                      onUploaded={({ photoKeys, videoKeys }) =>
                        setTransportEvidence((prev) => ({
                          photoKeys: [...prev.photoKeys, ...photoKeys],
                          videoKeys: [...prev.videoKeys, ...videoKeys],
                        }))
                      }
                    />
                    {(transportEvidence.photoKeys.length > 0 || transportEvidence.videoKeys.length > 0) && (
                      <p className="muted small">
                        {transportEvidence.photoKeys.length} photo(s), {transportEvidence.videoKeys.length} video(s) ready.
                      </p>
                    )}
                    <textarea
                      value={transportEvidenceNotes}
                      onChange={(event) => setTransportEvidenceNotes(event.target.value)}
                      placeholder="Optional delivery condition / handover notes..."
                      rows={3}
                      disabled={transportEvidenceBusy}
                      style={{ width: '100%', marginTop: 8 }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={transportEvidenceBusy || (!transportEvidence.photoKeys.length && !transportEvidence.videoKeys.length && !transportEvidenceNotes.trim())}
                      onClick={() => submitTransportEvidence('DELIVERY', 'DELIVERED')}
                      style={{ marginTop: 8 }}
                    >
                      {transportEvidenceBusy ? 'Submitting…' : 'Submit delivery evidence & mark delivered'}
                    </button>
                  </div>
                )}

                <EvidenceGallery
                  listUrl={`/transport/${transportJob.id}/evidence`}
                  mediaUrl={(evidenceId) => `/transport/${transportJob.id}/evidence/${evidenceId}/media`}
                />
              </div>

              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT PAYMENT */}
              {/* ------------------------------------------------------------ */}

              {transportJob.method ===
                'OWN_TRUCK' && (
                <div className="notice">
                  <h3>Transport payment</h3>

                  <p>
                    <strong>
                      No separate transporter payment
                      is required.
                    </strong>
                  </p>

                  <p className="muted">
                    This order is using the owner's
                    own truck. OWN_TRUCK transport does
                    not create a separate transport
                    payment.
                  </p>
                </div>
              )}

              {transportJob.method ===
                'HIRE_TRANSPORTER' &&
                !transportPaid && (
                  <div className="notice">
                    <h3>Transport payment</h3>

                    <p className="muted">
                      Transport payment is separate from the seller payment. You may pay it as soon as the transport quote is accepted. The transporter cannot start the trip until every required payment is confirmed.
                    </p>

                    {transportJob.agreedAmount !=
                      null && (
                      <p>
                        Transport fee:{' '}
                        <strong>
                          {money(
                            transportJob.agreedAmount
                          )}{' '}
                          ETB
                        </strong>
                      </p>
                    )}
                  </div>
                )}

              {canStartTransportPayment && (
                <div className="notice">
                  <h3>
                    Transport payment
                  </h3>

                  <p>
                    Transport fee due:{' '}
                    <strong>
                      {money(
                        transportJob.agreedAmount
                      )}{' '}
                      ETB
                    </strong>
                  </p>

                  <p className="muted">
                    Pay the agreed transporter fee. This payment is independent from the seller and inspection payments. All required payments must be PAID before the truck can pick up the goods.
                  </p>

                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <select
                      value={payMethod}
                      onChange={(event) =>
                        setPayMethod(
                          event.target.value
                        )
                      }
                      disabled={
                        busy ===
                        'pay-transport'
                      }
                    >
                      {PAYMENT_METHODS.map(
                        (method) => (
                          <option
                            key={method.value}
                            value={method.value}
                          >
                            {method.label}
                          </option>
                        )
                      )}
                    </select>

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={
                        busy ===
                        'pay-transport'
                      }
                      onClick={payTransport}
                    >
                      {busy ===
                      'pay-transport'
                        ? 'Submitting…'
                        : 'Pay for transport'}
                    </button>
                  </div>
                </div>
              )}

              {/* ------------------------------------------------------------ */}
              {/* RESUME TRANSPORT PAYMENT */}
              {/* ------------------------------------------------------------ */}

              {canResumeTransportPayment && (
                <div className="notice">
                  <h3>
                    Transport payment pending
                  </h3>

                  <p>
                    Amount:{' '}
                    <strong>
                      {money(
                        transportPayment.amount
                      )}{' '}
                      ETB
                    </strong>
                  </p>

                  <p>
                    Method:{' '}
                    <strong>
                      {transportPayment.method ||
                        '—'}
                    </strong>
                  </p>

                  <p className="muted">
                    The payment was started but
                    has not completed yet.
                  </p>

                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={
                      busy ===
                      'resume-transport'
                    }
                    onClick={() =>
                      resumePayment(
                        transportPayment.id,
                        'resume-transport'
                      )
                    }
                  >
                    {busy ===
                    'resume-transport'
                      ? 'Redirecting…'
                      : 'Resume payment'}
                  </button>
                </div>
              )}

              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT PAID */}
              {/* ------------------------------------------------------------ */}

              {transportPaid && (
                <div className="notice">
                  <p>
                    <strong>
                      ✓ Transport payment confirmed.
                    </strong>
                  </p>

                  <p className="muted">
                    Paid amount:{' '}
                    {money(
                      transportPayments.find(
                        (payment) =>
                          payment.status ===
                          'PAID'
                      )?.amount
                    )}{' '}
                    ETB
                  </p>
                </div>
              )}

              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT QUOTES */}
              {/* ------------------------------------------------------------ */}

              {transportJob.method ===
                'HIRE_TRANSPORTER' &&
                !transportJob.truckOwnerId && (
                  <div className="match-box">
                    <h3>
                      Transport quotes
                    </h3>

                    {leafTransportQuotes(transportJob.quotes)
                      ?.length ? (
                      leafTransportQuotes(transportJob.quotes).map(
                        (quote) => {
                          const displayAmount = quote.status === 'COUNTERED' ? (quote.counterAmount ?? quote.amount) : quote.amount;
                          const isArrangerTurn = quote.status === 'PENDING' || (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');
                          const isWaitingOnTransporter = quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';
                          return (
                          <div
                            className="transporter"
                            key={quote.id}
                          >
                            <div>
                              <strong>
                                {quote
                                  .truckOwner
                                  ?.name ||
                                  'Truck owner'}
                              </strong>

                              <p>
                                {quote.truck
                                  ?.truckType ||
                                  'Truck'}
                                {' · '}
                                {quote.truck
                                  ?.capacity !=
                                null
                                  ? `${quote.truck.capacity}t`
                                  : 'Capacity —'}
                                {' · '}
                                {quote.truck
                                  ?.registration ||
                                  'Registration —'}
                                {' · '}
                                ★{' '}
                                {typeof quote
                                  .truckOwner
                                  ?.rating ===
                                'number'
                                  ? quote.truckOwner.rating.toFixed(
                                      1
                                    )
                                  : '—'}
                              </p>

                              {quote.message && (
                                <p className="muted">
                                  {quote.message}
                                </p>
                              )}

                              <p>
                                Status:{' '}
                                <span className="badge">
                                  {quote.status ||
                                    'PENDING'}
                                </span>
                              </p>
                              {isWaitingOnTransporter && (
                                <p className="muted">
                                  You countered {money(displayAmount)} ETB — waiting for the transporter to respond.
                                </p>
                              )}
                            </div>

                            <div>
                              <strong>
                                {money(
                                  displayAmount
                                )}{' '}
                                ETB
                              </strong>

                              {canChooseQuote &&
                                isArrangerTurn && (
                                  <div
                                    style={{
                                      marginTop: 8,
                                      display: 'flex',
                                      gap: 6,
                                      flexWrap: 'wrap',
                                      alignItems: 'center',
                                    }}
                                  >
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      disabled={
                                        busy ===
                                        `quote-${quote.id}`
                                      }
                                      onClick={() =>
                                        acceptQuote(
                                          quote.id
                                        )
                                      }
                                    >
                                      {busy ===
                                      `quote-${quote.id}`
                                        ? 'Accepting…'
                                        : 'Accept quote'}
                                    </button>
                                    <input
                                      type="number"
                                      min="1"
                                      placeholder="Counter (ETB)"
                                      style={{ width: 120 }}
                                      value={transportCounterInputs[quote.id] || ''}
                                      onChange={(e) =>
                                        setTransportCounterInputs((q) => ({ ...q, [quote.id]: e.target.value }))
                                      }
                                    />
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-light"
                                      disabled={busy === `quote-${quote.id}`}
                                      onClick={() => counterQuote(quote.id)}
                                    >
                                      {busy === `quote-${quote.id}` ? 'Sending…' : 'Counter'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-light"
                                      disabled={busy === `quote-${quote.id}`}
                                      onClick={() => rejectQuote(quote.id)}
                                    >
                                      {busy === `quote-${quote.id}` ? 'Rejecting…' : 'Reject'}
                                    </button>
                                  </div>
                                )}
                            </div>
                          </div>
                          );
                        }
                      )
                    ) : (
                      <p className="muted">
                        Waiting for registered truck
                        owners to submit quotes.
                      </p>
                    )}
                  </div>
                )}

              {/* ------------------------------------------------------------ */}
              {/* TRANSPORT STATUS */}
              {/* ------------------------------------------------------------ */}

              {transportJob.status ===
                'DELIVERED' && (
                <div className="notice">
                  <p>
                    <strong>
                      ✓ Transport marked as
                      delivered.
                    </strong>
                  </p>

                  {transportJob
                    .deliveredConfirmedAt && (
                    <p className="muted">
                      Delivery confirmed.
                    </p>
                  )}
                </div>
              )}

              {transportJob.incidentNotes && (
                <div className="alert">
                  <strong>
                    Transport notes:
                  </strong>{' '}
                  {transportJob.incidentNotes}
                </div>
              )}
            </>
          )}
        </div>

        {/* ================================================================== */}
        {/* ORDER PAYOUT STATUS                                               */}
        {/* Seller, transporter and inspector payouts combined into a single */}
        {/* summary card. Visible to every order participant — not just the  */}
        {/* payee themselves — since the buyer funded these payouts and      */}
        {/* should be able to see they're on hold too.                       */}
        {/* ================================================================== */}

        {order && (
          <PayoutStatusCard
            sellerPayout={sellerPayout}
            inspectorPayout={inspectorPayout}
            transporterPayout={transporterPayout}
            sellerName={order.seller?.name || null}
            inspectorName={
              (order.inspectionRequests || inspectionRequests).find((r) => r?.inspector?.name)
                ?.inspector?.name || null
            }
            transporterName={transportJob?.truckOwner?.name || null}
            isSeller={isSeller}
            isInspector={isInspector}
            isTransporter={isTransporter}
            formatDateTime={formatDateTime}
          />
        )}

        {/* ================================================================== */}
        {/* REFUND STATUS                                                     */}
        {/* Only renders when a refund exists or a payout is frozen by a      */}
        {/* dispute — the "what happens to a held payout" follow-up card.     */}
        {/* ================================================================== */}

        {order && (
          <RefundStatusCard
            refunds={refunds}
            payouts={payouts}
            people={{
              SELLER: { name: order.seller?.name || null, you: isSeller },
              INSPECTOR: {
                name:
                  (order.inspectionRequests || inspectionRequests).find((r) => r?.inspector?.name)
                    ?.inspector?.name || null,
                you: isInspector,
              },
              TRANSPORTER: { name: transportJob?.truckOwner?.name || null, you: isTransporter },
            }}
            isAdmin={isAdmin}
            busy={busy}
            onComplete={completeRefundAsAdmin}
            onFail={failRefundAsAdmin}
          />
        )}

        {/* ================================================================== */}
        {/* PAYMENT CENTER */}
        {/* ================================================================== */}

        <PaymentCenter
          workflowPayments={workflow?.payments}
          rawPayments={payments}
          isBuyer={isBuyer}
          buyerIdentityMismatch={buyerIdentityMismatch}
          marketplaceBlockedReason={marketplaceBlockedReason}
          payMethod={payMethod}
          setPayMethod={setPayMethod}
          paymentMethods={PAYMENT_METHODS}
          busy={busy}
          marketplace={marketplaceObligation}
          inspections={inspectionPaymentGroups}
          transport={transportObligation}
        />

        {/* ================================================================== */}
        {/* CONFIRM RECEIPT */}
        {/* ================================================================== */}

        {order.status === 'DELIVERED' &&
          isBuyer && (
            <div className="card" id="confirm-receipt">
              <h2>
                Confirm receipt
              </h2>

              <p className="muted">
                Confirm only after you have physically
                received the produce/product.
              </p>

              {!marketplacePaid && (
                <div className="alert error">
                  Marketplace payment must be
                  confirmed before receipt can be
                  completed.
                </div>
              )}

              {transportJob?.method ===
                'HIRE_TRANSPORTER' &&
                !transportPaid && (
                  <div className="alert error">
                    Transport payment must be
                    confirmed before receipt can be
                    completed.
                  </div>
                )}

              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy === 'receipt' ||
                  !marketplacePaid ||
                  (
                    transportJob?.method ===
                      'HIRE_TRANSPORTER' &&
                    !transportPaid
                  )
                }
                onClick={confirmReceipt}
              >
                {busy === 'receipt'
                  ? 'Confirming…'
                  : 'Confirm receipt & complete order'}
              </button>
            </div>
          )}

        {/* ================================================================== */}
        {/* RAISE DISPUTE */}
        {/* ================================================================== */}

        {order.status === 'DISPUTED' ? (
          <div className="card card-warning" id="raise-dispute">
            <h2>Dispute open</h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              An admin is reviewing this order. It will resume its previous
              status once the dispute is resolved.
            </p>
          </div>
        ) : (
          canRaiseDispute && (
            <div className="card" id="raise-dispute">
              <h2>Raise a dispute</h2>
              <p className="muted">
                Use this if something went wrong with this order — for
                example goods not delivered, quality issues, or a payment
                problem. An admin will review it.
              </p>

              {disputeSubmitted ? (
                <div className="alert success">
                  Dispute submitted. The order is now marked as disputed
                  while an admin reviews it.
                </div>
              ) : (
                <form onSubmit={raiseDispute}>
                  <label>
                    Dispute against
                    <select
                      value={disputeAgainstId}
                      onChange={(e) => setDisputeAgainstId(e.target.value)}
                      required
                    >
                      <option value="">Select who this is about…</option>
                      {disputeCounterparties.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name} ({party.role})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Type
                    <select
                      value={disputeType}
                      onChange={(e) => setDisputeType(e.target.value)}
                    >
                      <option value="NOT_DELIVERED">Goods not delivered</option>
                      <option value="QUALITY_ISSUE">Quality issue</option>
                      <option value="DAMAGED_GOODS">Damaged goods</option>
                      <option value="PAYMENT_ISSUE">Payment issue</option>
                      <option value="TRANSPORT_ISSUE">Transport issue</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>

                  <label>
                    What happened?
                    <textarea
                      value={disputeDescription}
                      onChange={(e) => setDisputeDescription(e.target.value)}
                      rows={4}
                      placeholder="Describe the issue in detail"
                      required
                    />
                  </label>

                  <button
                    type="submit"
                    className="btn btn-outline"
                    disabled={submittingDispute}
                  >
                    {submittingDispute ? 'Submitting…' : 'Raise dispute'}
                  </button>
                </form>
              )}
            </div>
          )
        )}

        {/* ================================================================== */}
        {/* COMPLETED */}
        {/* ================================================================== */}

        {order.status === 'COMPLETED' && (
          <div className="card">
            <h2>
              Order completed
            </h2>

            <div className="notice">
              <p>
                <strong>
                  ✓ This order has been completed.
                </strong>
              </p>

              <p className="muted">
                Receipt was confirmed by the
                buyer.
              </p>
            </div>
          </div>
        )}

        {/* Payment records now live inside the Payment Center's expandable */}
        {/* "Show payment history" toggle above, instead of a separate */}
        {/* always-visible card repeating the same rows. */}

        {/* ================================================================== */}
        {/* RATING */}
        {/* ================================================================== */}

        <RatingBox
          order={order}
          userId={currentUserId}
          onRated={() =>
            load({ silent: true })
          }
        />

        {/* ================================================================== */}
        {/* MESSAGES */}
        {/* ================================================================== */}

        {counterpartId && (
          <MessageThread
            orderId={order.id}
            messages={order.messages || []}
            counterpartId={counterpartId}
            counterpartName={counterpartName}
            currentUserId={currentUserId}
            onSent={() =>
              load({ silent: true })
            }
          />
        )}

        {/* ================================================================== */}
        {/* ADMIN INDICATOR */}
        {/* ================================================================== */}

        {isAdmin && (
          <div className="card">
            <p className="muted">
              You are viewing this order with
              administrator access.
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="sd-toast" role="alert">
          {error}
        </div>
      )}
    </main>
  );
}
