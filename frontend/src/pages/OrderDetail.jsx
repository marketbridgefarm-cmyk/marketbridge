import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import api from '../api/client';
import {
  startChapaPayment,
  chapaInitializeAndRedirect,
} from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';

import InspectionCoordinationSeller from '../components/InspectionCoordinationSeller.jsx';
import OrderDecisionPanel from '../components/OrderDecisionPanel.jsx';
import {
  TransportLoadingReportSummary,
} from '../components/TransportLoadingReport.jsx';
import TransportCoordinationSeller from '../components/TransportCoordinationSeller.jsx';
import ProviderReleaseDialog from '../components/ProviderReleaseDialog.jsx';

import RatingBox from '../components/RatingBox.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import ActionCenter from '../components/ActionCenter.jsx';

import OrderTimeline from '../components/OrderTimeline.jsx';
import PaymentCenter from '../components/PaymentCenter.jsx';
import TransportSetup from '../components/TransportSetup.jsx';
import { InspectionRequestSummary, TransportRequestSummary } from '../components/RequestScopeSummary.jsx';
import { DEADLINE_WINDOWS, QUANTITY_VALUES, deadlineFromWindow } from '../components/RequestOptions.js';
import RefundStatusCard from '../components/RefundStatusCard.jsx';

import './order-details/OrderDetail.css';

import {
  pad2,
  shortId,
  label,
  money,
  formatDateTime,
  getError,
  statusTone,
  initials,
  scrollToId,
  leafQuotes,
} from './order-details/orderDetailUtils.js';

import {
  Modal,
  Card,
  Section,
  Avatar,
  PartyBadge,
  Pill,
  Finding,
  Facts,
  Fact,
  YouTag,
  Actions,
  SideLabel,
  Notice,
  Button,
  useNowUntil,
} from './order-details/OrderDetailPrimitives.jsx';

import TransportCard from './order-details/TransportCard.jsx';
import InspectionCard from './order-details/InspectionCard.jsx';
import OverviewCard from './order-details/OverviewCard.jsx';
import InspectionRequestForm from './order-details/InspectionRequestForm.jsx';

const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

const DISPUTE_TYPES = [
  ['NOT_DELIVERED', 'Goods not delivered'],
  ['QUALITY_ISSUE', 'Quality issue'],
  ['DAMAGED_GOODS', 'Damaged goods'],
  ['PAYMENT_ISSUE', 'Payment issue'],
  ['TRANSPORT_ISSUE', 'Transport issue'],
  ['OTHER', 'Other'],
];

/* ========================================================================
   2. UI primitives
   ======================================================================== */

/* ========================================================================
   3. Payout card
   ======================================================================== */

function PayoutStatusCard({ payouts, names, you }) {
  const parties = [
    { key: 'seller', label: 'SR', name: names.seller, you: you.seller, payout: payouts.seller },
    payouts.inspector && { key: 'inspector', label: 'IR', name: names.inspector, you: you.inspector, payout: payouts.inspector },
    payouts.transporter && { key: 'transporter', label: 'TR', name: names.transporter, you: you.transporter, payout: payouts.transporter },
  ]
    .filter(Boolean)
    .map((p) => ({ ...p, status: p.payout?.status || null }));

  const releaseMs = (payout) => {
    const t = payout?.releaseAt ? new Date(payout.releaseAt).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  };

  const dueTimes = parties
    .filter((p) => ['HELD', 'RELEASED', 'PAID_OUT'].includes(p.status))
    .map((p) => releaseMs(p.payout))
    .filter((t) => t !== null);
  const dueMs = dueTimes.length ? Math.max(...dueTimes) : null;
  const now = useNowUntil(dueMs);

  const anyDispute = parties.some((p) => p.status === 'ON_HOLD_DISPUTE');
  const holdNotStarted = parties.every((p) => !p.payout);

  const badgeOf = ({ status, payout }) => {
    if (!status) return { text: 'Pending', tone: 'neutral' };
    if (status === 'HELD') {
      const at = releaseMs(payout);
      return at !== null && now >= at ? { text: 'Released', tone: 'good' } : { text: 'Held', tone: 'wait' };
    }
    if (status === 'RELEASED') return { text: 'Released', tone: 'good' };
    if (status === 'PAID_OUT') return { text: 'Paid out', tone: 'good' };
    if (status === 'ON_HOLD_DISPUTE') return { text: 'Dispute hold', tone: 'bad' };
    if (status === 'CANCELLED') return { text: 'Cancelled', tone: 'bad' };
    return { text: label(status), tone: 'neutral' };
  };

  const anyFraction = parties.some((p) => p.payout?.amount != null && Number(p.payout.amount) % 1 !== 0);
  const amountText = (v) =>
    Number(v || 0).toLocaleString(undefined, {
      minimumFractionDigits: anyFraction ? 2 : 0,
      maximumFractionDigits: 2,
    });

  const remainingMs = dueMs !== null ? Math.max(0, dueMs - now) : 0;
  const secs = Math.floor(remainingMs / 1000);
  const clock = `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
  const dueDate =
    dueMs !== null
      ? new Date(dueMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
  const duePassed = dueMs !== null && remainingMs === 0;

  return (
    <Card
      id="order-payout-status"
      eyebrow="Order Payout"
      title="After Buyer Paid"
      side={dueDate && <SideLabel name="Due Date"><span className="od-card-side-value">{dueDate}</span></SideLabel>}
    >
      <Section title="Order Payout Status">
        <table className="payout-table">
          <thead>
            <tr>
              <th scope="col">Party</th>
              <th scope="col" className="payout-amount-col">Amount</th>
              <th scope="col" className="payout-status-col">Status</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const { key, name, payout, status } = party;
              const badge = badgeOf(party);
              const currency = payout?.currency && payout.currency !== 'ETB' ? payout.currency : null;
              return (
                <tr key={key}>
                  <th scope="row" className="payout-party">
                    <div className="payout-party-body">
                      <span className="payout-party-line">
                        {name && <Avatar small name={name} />}
                        <span className="payout-party-role">{party.label}</span>
                        {name && <span className="payout-party-name">{name}</span>}
                        {party.you && <YouTag />}
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
                    <Pill tone={badge.tone}>{badge.text}</Pill>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {dueMs !== null && (
        <div className="od-payout-due" role="group" aria-label="Due date">
          <span className="od-payout-due-label">Due Date</span>
          <div className="od-payout-due-clock" role="timer" aria-live="off">
            {duePassed ? (
              <span className="od-payout-due-digits is-cleared">Hold cleared</span>
            ) : (
              <>
                <span className="od-payout-due-digits">{clock}</span>
                <span className="od-payout-due-unit">left</span>
              </>
            )}
          </div>
        </div>
      )}

      {dueMs === null && holdNotStarted && (
        <div className="od-payout-due" role="group" aria-label="Due date">
          <span className="od-payout-due-label">Due Date</span>
          <span className="od-payout-due-placeholder">Starts after payment settles</span>
        </div>
      )}

      {anyDispute && (
        <p className="od-payout-dispute-note">
          One or more payouts are frozen while a dispute is open.
        </p>
      )}

      <div className="od-payout-notice">
        <span className="od-payout-notice-prefix">Notice:</span>
        <ol className="od-payout-notice-list">
          <li className="od-payout-notice-item">
            <span className="od-payout-notice-num">1)</span>
            Each payout is held for 3 days after its payment settles.
          </li>
          <li className="od-payout-notice-item">
            <span className="od-payout-notice-num">2)</span>
            Buyer payment is separate from each payout below.
          </li>
          <li className="od-payout-notice-item">
            <span className="od-payout-notice-num">3)</span>
            No manual action is required.
          </li>
        </ol>
      </div>
    </Card>
  );
}

/* ========================================================================
   4. Order overview
   ======================================================================== */

/* ========================================================================
   5. Inspection — request form (popup) + status card
   ======================================================================== */

/* ========================================================================
   7. Offer, receipt, dispute, completed, admin
   ======================================================================== */

function OfferCard({ amount, setAmount, reference, submitting, onSubmit }) {
  return (
    <Card id="make-offer" eyebrow="Product marketplace" title="Make an offer" subtitle="Your offer enters the seller's competition. It does not charge you or reserve the product.">
      <form onSubmit={onSubmit} className="form">
        <label htmlFor="offer-amount">Offer amount (ETB)</label>
        <AmountPicker id="offer-amount" reference={reference} min={1} placeholder="Select your offer" value={amount} onChange={setAmount} disabled={submitting} required ariaLabel="Offer amount in ETB" />
        <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Make offer'}</button>
      </form>
    </Card>
  );
}

function ReceiptCard({ marketplacePaid, transportBlocked, busy, onConfirm }) {
  return (
    <Card id="confirm-receipt" eyebrow="Final step" title="Confirm receipt" subtitle="Confirm only after you have physically received the produce or product.">
      {!marketplacePaid && <div className="alert error">Marketplace payment must be confirmed before receipt can be completed.</div>}
      {transportBlocked && <div className="alert error">Transport payment must be confirmed before receipt can be completed.</div>}
      <Button variant="primary" className="btn btn-primary btn-block" disabled={busy === 'receipt' || !marketplacePaid || transportBlocked} busy={busy === 'receipt'} busyText="Confirming…" onClick={onConfirm}>
        Confirm receipt & complete order
      </Button>
    </Card>
  );
}

function DisputeCard({ order, d }) {
  if (order.status === 'DISPUTED') {
    return (
      <Card id="raise-dispute" tone="warning" eyebrow="Dispute" title="Dispute open">
        <p className="muted">
          An admin is reviewing this order. <strong>Payments, transport, inspection and payouts are paused</strong> while
          the dispute is open. The order will either resume or be cancelled and refunded after review.
        </p>
      </Card>
    );
  }
  if (!d.canRaise) return null;

  return (
    <Card id="raise-dispute" eyebrow="Dispute" title="Raise a dispute" subtitle="Use this if something went wrong — goods not delivered, quality issues, or a payment problem.">
      {d.submitted ? (
        <div className="alert success">Dispute submitted. The order is marked as disputed while an admin reviews it.</div>
      ) : (
        <form onSubmit={d.submit} className="form">
          <label htmlFor="dispute-against">Dispute against</label>
          <select id="dispute-against" className="field" value={d.againstId} onChange={(e) => d.setAgainstId(e.target.value)} required>
            <option value="">Select who this is about…</option>
            {d.counterparties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </select>
          <label htmlFor="dispute-type">Type</label>
          <select id="dispute-type" className="field" value={d.type} onChange={(e) => d.setType(e.target.value)}>
            {DISPUTE_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          <label htmlFor="dispute-description">What happened?</label>
          <select id="dispute-description" className="field" value={d.description} onChange={(e) => d.setDescription(e.target.value)} required><option value="">Select a dispute reason</option><option value="ITEM_NOT_AS_DESCRIBED">Item differs from agreed description</option><option value="INSPECTION_CONCERN">Inspection or quality concern</option><option value="PAYMENT_ISSUE">Payment issue</option><option value="DELIVERY_ISSUE">Delivery or transport issue</option><option value="DAMAGE_OR_LOSS">Damage or loss</option><option value="OTHER_REVIEW_REQUIRED">Other issue requiring admin review</option></select>
          <button type="submit" className="btn btn-outline" disabled={d.submitting}>{d.submitting ? 'Submitting…' : 'Raise dispute'}</button>
        </form>
      )}
    </Card>
  );
}

/* ========================================================================
   7b. MarketBridge Order Protection banner (buyer)
   ======================================================================== */

function BuyerConfidenceCard({ order, recoveryRequests }) {
  const latest = [...(recoveryRequests || [])].sort((a, b) =>
    new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  )[0];
  const hasOpenDispute = order?.status === 'DISPUTED';
  const recoveryPending = latest?.status === 'PENDING';
  const formReleased = Boolean(latest?.formReleasedAt) || latest?.status === 'APPROVED';
  const recoveryRejected = latest?.status === 'REJECTED';

  let status = 'Order remains active';
  let detail = 'If an inspection or transport arrangement changes, the affected service can be reviewed separately. Your goods order is not automatically cancelled.';
  let tone = 'safe';

  if (hasOpenDispute) {
    status = 'Admin review in progress';
    detail = 'The case is under review. Payments affected by the dispute remain protected while the decision is pending. You will see the next permitted action here after review.';
    tone = 'review';
  } else if (recoveryPending) {
    status = 'Waiting for admin approval';
    detail = `Your ${String(latest.type || 'service').toLowerCase()} recovery request has been submitted. A fresh competition is not opened until an administrator approves it.`;
    tone = 'review';
  } else if (formReleased) {
    status = 'Fresh competition available';
    detail = 'Admin approved recovery. Follow the released form to invite new bids. The replacement provider must have its own agreement and payment.';
    tone = 'safe';
  } else if (recoveryRejected) {
    status = 'Recovery request reviewed';
    detail = 'The latest recovery request was not approved. Review the decision and reason, then contact MarketBridge support if you need help.';
    tone = 'review';
  }

  return (
    <section className={`od-protection od-protection--${tone}`} aria-live="polite">
      <span className="od-protection-icon" aria-hidden="true">
        {tone === 'review' ? 'i' : '✓'}
      </span>

      <div className="od-protection-body">
        <span className="od-protection-eyebrow">MarketBridge Order Protection</span>
        <h2 className="od-protection-title">{status}</h2>
        <p className="od-protection-text">{detail}</p>

        <ul className="od-protection-promises">
          <li>Service issues reviewed separately</li>
          <li>No automatic replacement charge</li>
          <li>Payment and refund status stays visible</li>
        </ul>
      </div>
    </section>
  );
}

/* ========================================================================
   8. Page
   ======================================================================== */

export default function OrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [recoveryRequests, setRecoveryRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [activeModal, setActiveModal] = useState(null);

  const [providerReleaseTarget, setProviderReleaseTarget] = useState(null);

  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const [counterInputs, setCounterInputs] = useState({});
  const [evidence, setEvidence] = useState({ photoKeys: [], videoKeys: [] });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  const [offerAmount, setOfferAmount] = useState('');
  const [submittingOffer, setSubmittingOffer] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState(false);
  const [inspectionWorkDetails, setInspectionWorkDetails] = useState({
    workCategory: 'GENERAL_QUALITY',
    quantityValue: '',
    quantityUnit: 'kg',
    lotCount: '',
    checks: ['QUALITY_GRADE', 'VISIBLE_DEFECTS', 'PHOTOGRAPHS'],
    reportFormat: 'CHECKLIST_PHOTOS',
    requiredBy: '',
  });

  const [loadingReport, setLoadingReport] = useState(null);
  const [loadingReportEvidence, setLoadingReportEvidence] = useState(null);

  const [disputeAgainstId, setDisputeAgainstId] = useState('');
  const [disputeType, setDisputeType] = useState('NOT_DELIVERED');
  const [disputeDescription, setDisputeDescription] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);

  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!orderId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const orderRes = await api.get(`/orders/${orderId}`);
        const nextOrder = orderRes.data?.order || null;
        setOrder(nextOrder);
        if (!silent) setLoading(false);

        const [workflowRes, recoveryRes] = await Promise.allSettled([
          api.get(`/orders/${orderId}/workflow`),
          api.get(`/recovery-requests/order/${orderId}`),
        ]);

        setWorkflow(
          workflowRes.status === 'fulfilled'
            ? workflowRes.value.data?.workflow || null
            : null
        );
        setRecoveryRequests(
          recoveryRes.status === 'fulfilled'
            ? recoveryRes.value.data?.recoveryRequests || []
            : []
        );

        const job = nextOrder?.transportJob || null;
        if (job && ['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status)) {
          try {
            const lr = await api.get(`/transport/${job.id}/loading-report`);
            setLoadingReport(lr.data?.loadingReport || null);
            setLoadingReportEvidence(lr.data?.evidence || null);
          } catch (_) {
            setLoadingReport(null);
            setLoadingReportEvidence(null);
          }
        } else {
          setLoadingReport(null);
          setLoadingReportEvidence(null);
        }
      } catch (err) {
        setError(getError(err, 'Could not load order'));
      } finally {
        if (silent) setRefreshing(false);
        else setLoading(false);
      }
    },
    [orderId]
  );

  useEffect(() => { load(); }, [load]);
  const reload = useCallback(() => load({ silent: true }), [load]);

  const goToSection = (id, delay = 0) => {
    const needsInspectionForm =
      id === 'inspection-section' && !currentInspection && (inspections.length === 0 || inspectionFormReleased);
    const needsTransportForm =
      id === 'transport-section' && !transportJob && order && order.status !== 'CANCELLED' && !transportBlockedReason && (isPhysicalGoods ? isBuyer : isBuyer || isSeller);
    scrollToId(id, delay);
    if (needsInspectionForm) setActiveModal('inspection-request-form');
    else if (needsTransportForm) setActiveModal('transport-setup-form');
  };

  useEffect(() => {
    if (loading) return;
    const id = location.hash?.replace('#', '');
    if (id) goToSection(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, location.hash]);

  const run = async (key, fn, fallback) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(getError(err, fallback));
      return false;
    } finally {
      setBusy('');
    }
  };

  const currentUserId = user?.id || user?.userId || user?._id || null;
  const isAdmin = (Array.isArray(user?.roles) ? user.roles : []).includes('ADMIN');
  const isBuyer = Boolean(order && currentUserId && currentUserId === order.buyerId);
  const isSeller = Boolean(order && currentUserId && currentUserId === order.sellerId);
  const isParticipant = isBuyer || isSeller;
  const buyerIdentityMismatch = Boolean(order && currentUserId && !isParticipant && !isAdmin);

  const isAgricultural = order?.listing?.category === 'AGRICULTURAL';

  const isProduct = order?.listing?.category === 'PRODUCT';
  const inspectionRequiredByFlag = Boolean(order?.listing?.inspectionRequired);
  const hasInspectionRequest =
    (order?.inspectionRequests?.length || 0) > 0 ||
    (order?.listing?.inspectionRequests?.length || 0) > 0;
  const inspectionApplies =
    isAgricultural ||
    inspectionRequiredByFlag ||
    hasInspectionRequest;
  const title = order?.listing?.title || order?.listing?.cropType || 'Order';
  const allInspections = useMemo(
    () =>
      (order?.inspectionRequests || order?.listing?.inspectionRequests || [])
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [order?.inspectionRequests, order?.listing?.inspectionRequests]
  );
  const inspections = allInspections;
  const currentInspection = inspections[0] || null;
  const assignedInspection = inspections.find((r) => r.inspectorId === currentUserId) || null;
  const isInspector = Boolean(assignedInspection);
  const inspectionFormReleased = recoveryRequests.some((r) => r.type === 'INSPECTION' && r.status === 'APPROVED' && r.formReleasedAt);
  const inspectorName = (order?.inspectionRequests || inspections).find((r) => r?.inspector?.name)?.inspector?.name || null;

  const inspectionGateMet =
    !inspectionApplies || Boolean(currentInspection && currentInspection.status === 'COMPLETED' && currentInspection.report);
  const decisionRequired = inspectionApplies;
  const decisionGateMet = !decisionRequired || order?.buyerDecision === 'BUY';
  const negotiatedGateMet = !isProduct || Boolean(order?.agreedOfferId);

  const rawJob = order?.transportJob || null;
  const transportJob = rawJob?.status === 'CANCELLED' ? null : rawJob;
  const isTransporter = Boolean(transportJob?.truckOwnerId && transportJob.truckOwnerId === currentUserId);
  const isTransportArranger = Boolean(
    transportJob &&
      ((transportJob.arrangingParty === 'BUYER' && isBuyer) ||
        (transportJob.arrangingParty === 'SELLER' && isSeller) ||
        (transportJob.arrangingParty === 'JOINT' && isParticipant))
  );
  const isPhysicalGoods = isAgricultural || isProduct;
  const inspectionReportDone = Boolean(currentInspection && currentInspection.status === 'COMPLETED' && currentInspection.report);
  const paidInspections = inspections.filter((r) => r.fee != null && Number(r.fee) > 0);
  const inspectionFeesPaid =
    !paidInspections.every((r) => Array.isArray(r.payments)) ||
    paidInspections.every((r) => r.payments.some((p) => p.type === 'INSPECTOR' && p.status === 'PAID'));

  const transportBlockedReason = !isPhysicalGoods
    ? null
    : !decisionGateMet
      ? 'Arrange transport after the buyer confirms the purchase decision.'
      : null;

  const transportInMotion = Boolean(transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(transportJob.status));
  const acceptedQuote = Array.isArray(transportJob?.quotes) ? transportJob.quotes.find((q) => q.status === 'ACCEPTED') : null;

  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const active = (p) => ['PENDING', 'PROCESSING'].includes(p.status);
  const pick = (list) => list.find(active) || list.find((p) => p.status === 'PAID') || null;

  const marketplacePayments = useMemo(() => payments.filter((p) => p.type === 'MARKETPLACE'), [payments]);
  const transportPayments = useMemo(() => payments.filter((p) => p.type === 'TRANSPORT'), [payments]);
  const marketplacePayment = useMemo(() => pick(marketplacePayments), [marketplacePayments]);
  const transportPayment = useMemo(() => pick(transportPayments), [transportPayments]);

  const installmentPlan = useMemo(
    () =>
      marketplacePayments.find(
        (p) => p.installmentCount != null && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
      ) || null,
    [marketplacePayments]
  );
  const installmentPayments = useMemo(
    () =>
      payments
        .filter(
          (p) =>
            p.type === 'MARKETPLACE_INSTALLMENT' &&
            p.installmentSequence != null &&
            (!installmentPlan || p.parentPaymentId === installmentPlan.id)
        )
        .sort((a, b) => (a.installmentSequence || 0) - (b.installmentSequence || 0)),
    [payments, installmentPlan]
  );

  const planHealRef = useRef(null);
  useEffect(() => {
    if (
      !installmentPlan ||
      installmentPlan.status !== 'PENDING' ||
      installmentPayments.length !== installmentPlan.installmentCount ||
      !installmentPayments.every((p) => p.status === 'PAID') ||
      planHealRef.current === installmentPlan.id
    ) return;
    planHealRef.current = installmentPlan.id;
    api.get(`/payments/${installmentPlan.id}/chapa/verify`).then(reload).catch(() => {});
  }, [installmentPlan, installmentPayments, reload]);

  const marketplacePaid = marketplacePayments.some((p) => p.status === 'PAID');
  const marketplacePending = marketplacePayments.some(active);
  const marketplaceProcessing = marketplacePayments.some((p) => p.status === 'PROCESSING');
  const transportPaid = transportPayments.some((p) => p.status === 'PAID');
  const transportPending = transportPayments.some(active);
  const transportProcessing = transportPayments.some((p) => p.status === 'PROCESSING');
  const hiredTransport = transportJob?.method === 'HIRE_TRANSPORTER';

  const goodsPaymentUnlocked = transportJob
    ? (hiredTransport
        ? Boolean(transportJob.buyerLoadingConfirmedAt)
        : Boolean(transportJob.sellerPickupConfirmedAt))
    : false;

  const missingPayments = useMemo(() => {
    const missing = [];
    if (!marketplacePaid) missing.push('MARKETPLACE');
    for (const r of inspections) {
      if (r.fee == null || Number(r.fee) <= 0) continue;
      const paid = (r.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID');
      if (!paid) missing.push(`INSPECTOR:${r.id}`);
    }
    if (hiredTransport && !transportPaid) missing.push('TRANSPORT');
    return missing;
  }, [marketplacePaid, inspections, hiredTransport, transportPaid]);

  const allOrderPaymentsSettled = missingPayments.length === 0;

  const canPayMarketplace =
    Boolean(order) &&
    !['COMPLETED', 'CANCELLED'].includes(order.status) &&
    isBuyer &&
    inspectionGateMet &&
    decisionGateMet &&
    negotiatedGateMet &&
    goodsPaymentUnlocked &&
    !marketplacePayments.some((p) => ['PENDING', 'PROCESSING', 'PAID'].includes(p.status));

  const marketplaceBlockedReason =
    isProduct && !negotiatedGateMet
      ? 'This product must first be won through seller bidding and bilateral negotiation before payment.'
      : inspectionApplies && !inspectionGateMet
      ? !currentInspection
        ? 'Request and complete the inspection before paying for the goods.'
        : 'Complete the current inspection and make sure its report is published before paying for the goods.'
      : decisionRequired && !decisionGateMet
      ? `Choose BUY after reviewing the ${isAgricultural ? 'agricultural ' : ''}inspection report before paying for the goods.`
      : !goodsPaymentUnlocked
      ? hiredTransport
        ? 'The goods payment unlocks once the transporter submits the loading-preparation report and the buyer approves it.'
        : 'The goods payment unlocks once the seller confirms the goods are ready for pickup.'
      : null;

  const canStartTransportPayment =
    Boolean(transportJob) &&
    hiredTransport &&
    Boolean(transportJob.truckOwnerId) &&
    Boolean(acceptedQuote) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    transportJob.status === 'ACCEPTED' &&
    !transportPayments.some((p) => ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)) &&
    isBuyer;

  const payouts = order?.payouts || [];
  const payoutBy = (role) => payouts.find((p) => p.payeeRole === role) || null;
  const refunds = order?.refunds || [];

  const checkPayment = (paymentId, key) =>
    paymentId &&
    (async () => {
      setBusy(key);
      setError('');
      try {
        const res = await api.get(`/payments/${paymentId}/chapa/verify`);
        await reload();
        if (res.data?.status === 'PENDING') {
          setError('Chapa has not confirmed this payment yet. If you cancelled or the checkout failed, return to the order and retry once the payment shows FAILED.');
        }
      } catch (err) {
        setError(getError(err, 'Could not check payment status'));
      } finally {
        setBusy('');
      }
    })();

  const resumePayment = (paymentId, key) =>
    paymentId && run(key, () => chapaInitializeAndRedirect(paymentId), 'Could not resume payment');

  const payMarketplace = () => {
    if (!isBuyer) return setError('Only the buyer can make the marketplace payment');
    const amount = Number(order.finalPrice);
    if (!Number.isFinite(amount) || amount <= 0) return setError('Invalid marketplace payment amount');
    return run('pay-marketplace', () => startChapaPayment({ type: 'MARKETPLACE', orderId: order.id, amount, method: payMethod }), 'Could not start marketplace payment');
  };

  const payTransport = () => {
    if (!isParticipant) return setError('You are not authorized to pay for this transport');
    if (!hiredTransport) return setError('Transport payment is only required for hired transport');
    if (!transportJob.truckOwnerId) return setError('A transporter must be selected before transport payment');
    const amount = Number(transportJob.agreedAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setError('Invalid transport payment amount');
    return run('pay-transport', () => startChapaPayment({ type: 'TRANSPORT', orderId: order.id, amount, method: payMethod }), 'Could not start transport payment');
  };

  const payInspection = (request) => {
    if (!request?.id || !request.fee) return;
    if (!request.sellerConfirmedAt) {
      setError('The seller must confirm the inspector and agreed fee before payment can begin.');
      return;
    }
    if (!request.inspectorOnSiteConfirmedAt) {
      setError('The seller must confirm the inspector is on site and ready to start before inspection payment can begin.');
      return;
    }
    const obligation = (order?.paymentObligations || []).find(
      (o) => o.type === 'INSPECTOR' &&
        o.inspectionRequestId === request.id &&
        o.payerId === currentUserId &&
        o.status !== 'PAID' &&
        o.payment?.status !== 'PAID'
    );
    const amount = obligation?.amount != null
      ? Number(obligation.amount)
      : request.feePayer === 'SPLIT'
        ? Number(currentUserId === order.buyerId ? request.buyerFeeAmount : request.sellerFeeAmount)
        : Number(request.fee);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('No payable inspection obligation is assigned to your account.');
      return;
    }
    return run(`pay-inspection-${request.id}`, () =>
      startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, orderId: order.id, amount, method: payMethod }),
      'Could not start inspector payment');
  };

  const startInstallments = () => {
    if (!isBuyer) return setError('Only the buyer can make the marketplace payment');
    return run('start-installments', () =>
      api.post('/payments', { type: 'MARKETPLACE', orderId: order.id, amount: Number(order.finalPrice), method: payMethod, installments: true }),
      'Could not set up installments');
  };

  const retryInstallment = (inst) =>
    inst?.id && run(`installment-${inst.id}`, () => api.post(`/payments/${inst.id}/retry-installment`), 'Could not retry this installment');

  const marketplaceObligation = {
    amount: order?.finalPrice,
    paid: marketplacePaid,
    pending: marketplacePending,
    processing: marketplaceProcessing,
    canPay: canPayMarketplace,
    canResume: Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PENDING' && isBuyer,
    canCheck: Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PROCESSING' && isBuyer,
    onPay: payMarketplace,
    onResume: () => resumePayment(marketplacePayment?.id, 'resume-marketplace'),
    onCheck: () => checkPayment(marketplacePayment?.id, 'check-marketplace'),
    installmentPlan,
    installments: installmentPayments,
    canStartInstallments: canPayMarketplace,
    onStartInstallments: startInstallments,
    onPayInstallment: (i) => resumePayment(i?.id, `installment-${i?.id}`),
    onCheckInstallment: (i) => checkPayment(i?.id, `installment-${i?.id}`),
    onRetryInstallment: retryInstallment,
  };

  const transportObligation = transportJob
    ? {
        required: hiredTransport,
        readyToPay: canStartTransportPayment,
        amount: transportJob.agreedAmount,
        paid: transportPaid,
        pending: transportPending,
        processing: transportProcessing,
        note:
          !hiredTransport ? null
          : transportPaid ? null
          : transportJob.status !== 'ACCEPTED'
            ? 'Transport payment becomes available once the transporter quote is accepted.'
            : null,
        canStart: canStartTransportPayment,
        canResume: Boolean(transportPayment) && transportPayment.status === 'PENDING' && isBuyer,
        canCheck: Boolean(transportPayment) && transportPayment.status === 'PROCESSING' && isBuyer,
        onStart: payTransport,
        onResume: () => resumePayment(transportPayment?.id, 'resume-transport'),
        onCheck: () => checkPayment(transportPayment?.id, 'check-transport'),
      }
    : null;

  const inspectionPaymentGroups = inspectionApplies && currentInspection && Number(currentInspection.fee) > 0
    ? [currentInspection].map((request) => {
        const obligations = (order?.paymentObligations || []).filter(
          (o) => o.type === 'INSPECTOR' && o.inspectionRequestId === request.id
        );
        const mine = obligations.find((o) => o.payerId === currentUserId) || null;
        const open = mine?.payment || null;
        const key = `${open?.status === 'PROCESSING' ? 'check' : open ? 'resume' : 'pay'}-inspection-${request.id}`;
        const allPaid = obligations.length > 0 && obligations.every((o) => o.status === 'PAID' || o.payment?.status === 'PAID');
        const arrivalConfirmed = Boolean(request.inspectorOnSiteConfirmedAt);
        const sellerConfirmed = Boolean(request.sellerConfirmedAt);
        const viewerIsPayer = Boolean(mine && mine.payerId === currentUserId);
        const canPay = Boolean(
          sellerConfirmed &&
          arrivalConfirmed &&
          viewerIsPayer &&
          mine &&
          mine.status !== 'PAID' &&
          !['PENDING', 'PROCESSING'].includes(open?.status)
        );
        return {
          id: request.id,
          label: `${request.inspector?.name || 'Inspector'} — inspection fee`,
          amount: mine?.amount ?? request.fee,
          paid: allPaid,
          pending: Boolean(open && ['PENDING', 'PROCESSING'].includes(open.status)),
          processing: open?.status === 'PROCESSING',
          note: !sellerConfirmed
            ? 'Waiting for seller confirmation before inspection payment can begin.'
            : !arrivalConfirmed
              ? 'Waiting for the seller to confirm the inspector is on site and ready to start.'
              : !mine
                ? 'No inspection payment obligation is assigned to your account.'
                : !viewerIsPayer
                  ? 'Only the designated payer for this inspection can pay.'
                  : request.feePayer === 'SPLIT'
                    ? `Your share of the inspection fee is ${Number(mine.amount).toLocaleString()} ETB.`
                    : null,
          busyKey: key,
          canPay,
          canCheck: Boolean(open) && open.status === 'PROCESSING',
          canResume: Boolean(open) && open.status !== 'PROCESSING',
          onCheck: () => checkPayment(open?.id, key),
          onResume: () => resumePayment(open?.id, key),
          onPay: () => payInspection(request),
        };
      })
    : [];

  const submitProviderRelease = async ({ reason, note }) => {
    if (!providerReleaseTarget) return false;
    const { service, quoteId, inspectionRequestId, transportJobId } = providerReleaseTarget;
    if (!quoteId) {
      setError('No provisional agreement is available to release.');
      return false;
    }
    const url = service === 'INSPECTION'
      ? `/inspections/${inspectionRequestId}/quotes/${quoteId}/withdraw`
      : `/transport/${transportJobId}/quotes/${quoteId}/withdraw`;
    const key = service === 'INSPECTION'
      ? `withdraw-inspection-${inspectionRequestId}`
      : `withdraw-transport-${transportJobId}`;
    const ok = await run(
      key,
      () => api.patch(url, { reason, note: note || undefined }),
      `Could not release ${service.toLowerCase()} agreement`
    );
    if (ok) setProviderReleaseTarget(null);
    return ok;
  };

  const openProviderRelease = (target) => setProviderReleaseTarget(target);

  const decide = async (decision) => {
    if (!order || !isBuyer || !decisionRequired) return false;
    if (decision === 'BUY' && !(currentInspection?.report && currentInspection.status === 'COMPLETED')) {
      setError('Review the completed inspection report before choosing BUY.');
      return false;
    }
    if (decision === 'CANCEL' && !window.confirm('Cancel this purchase after reviewing the inspection report? This cannot be undone.')) return false;
    const ok = await run(
      `buyer-decision-${decision.toLowerCase()}`,
      () => api.patch(`/orders/${order.id}/buyer-decision`, { decision }),
      `Could not record ${decision === 'BUY' ? 'BUY' : 'cancellation'} decision`
    );
    if (ok) scrollToId(decision === 'BUY' ? 'transport-section' : 'inspection-section', 120);
    return ok;
  };

  const inspectionActions = {
    request: async (mode) => {
      if (!order?.listing) return false;
      setRequestingInspection(true);
      setError('');
      try {
        await api.post('/inspections', {
          orderId: order.id,
          listingId: order.listing.id,
          mode,
          workDetails: inspectionWorkDetails,
        });
        await reload();
        return true;
      } catch (err) {
        setError(getError(err, 'Could not request inspection'));
        return false;
      } finally {
        setRequestingInspection(false);
      }
    },
    cancel: () =>
      currentInspection &&
      window.confirm('Cancel this inspection request without cancelling the order? You can open a new request afterward.') &&
      run(`cancel-inspection-${currentInspection.id}`, () => api.patch(`/inspections/${currentInspection.id}/cancel`), 'Could not cancel inspection request'),
    reopenBidding: () =>
      currentInspection &&
      window.confirm('Reopen inspection bidding? Previous bids will expire and inspectors can submit fresh bids.') &&
      run(`reopen-inspection-${currentInspection.id}`, () => api.patch(`/inspections/${currentInspection.id}/reopen-bidding`), 'Could not reopen inspection bidding'),
    decide,
    isBuyer,
    isSeller,
    isParticipant,
    createPriceReview: (proposedPrice, reasonCode) => run(
      'price-review-create',
      () => api.post(`/orders/${order.id}/price-reviews`, { proposedPrice, reasonCode }),
      'Could not submit price review'
    ),
    respondPriceReview: (reviewId, action, proposedPrice, reasonCode) => run(
      `price-review-${reviewId}-${action.toLowerCase()}`,
      () => api.patch(`/orders/${order.id}/price-reviews/${reviewId}/respond`, { action, ...(proposedPrice ? { proposedPrice, reasonCode } : {}) }),
      'Could not respond to price review'
    ),
    selectInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-select`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/select`),
        'Could not select inspection bid'
      );
    },
    acceptInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-accept`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/accept`),
        'Could not accept inspection quote'
      );
    },
    counterInspectionQuote: async (quoteId, counterKey) => {
      if (!currentInspection) return;
      const amount = Number(counterInputs[counterKey] || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Enter a valid counter amount before sending.');
        return;
      }
      const ok = await run(
        `inspection-quote-${quoteId}-counter`,
        () =>
          api.post(`/inspections/${currentInspection.id}/quotes/${quoteId}/counter`, {
            counterAmount: amount,
          }),
        'Could not send counter-offer'
      );
      if (ok) setCounterInputs((prev) => ({ ...prev, [counterKey]: '' }));
    },
    rejectInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-reject`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/reject`),
        'Could not reject inspection quote'
      );
    },
    withdrawInspectionAgreement: (requestId, { reason, note } = {}) => {
      if (!currentInspection) return;
      const accepted = leafQuotes(currentInspection.quotes).find(
        (q) => q.status === 'ACCEPTED'
      );
      if (!accepted) return;
      return run(
        `withdraw-inspection-${requestId}`,
        () =>
          api.patch(`/inspections/${requestId}/quotes/${accepted.id}/withdraw`, {
            reason,
            note: note || undefined,
          }),
        'Could not release inspection agreement'
      );
    },
    confirmSellerInspection: (requestId) =>
      run(
        `seller-confirm-${requestId}`,
        () => api.post(`/inspections/${requestId}/seller-confirm`),
        'Could not confirm the inspector'
      ),
    declineSellerInspection: (requestId) =>
      run(
        `seller-decline-${requestId}`,
        () => api.post(`/inspections/${requestId}/seller-decline`),
        'Could not decline the inspection'
      ),
    confirmInspectorArrived: (requestId) =>
      run(
        `inspector-arrived-${requestId}`,
        () => api.post(`/inspections/${requestId}/inspector-arrived`),
        'Could not confirm inspector arrival'
      ),
    payInspection: (request) => payInspection(request),
    currentUserId,
    counterInputs,
    setCounterInputs,
    openProviderRelease,
    canPayInspection: Boolean(
      currentInspection &&
      currentInspection.status === 'ACCEPTED' &&
      currentInspection.fee != null &&
      currentInspection.sellerConfirmedAt != null &&
      currentInspection.inspectorOnSiteConfirmedAt != null &&
      (order?.paymentObligations || []).some(
        (o) => o.type === 'INSPECTOR' &&
          o.inspectionRequestId === currentInspection.id &&
          o.payerId === currentUserId &&
          o.status !== 'PAID' &&
          o.payment?.status !== 'PAID' &&
          !['PENDING', 'PROCESSING'].includes(o.payment?.status)
      )
    ),

    onBuy: () => decide('BUY'),
    onCancel: () => decide('CANCEL'),
    onProposePrice: (proposedPrice, reasonCode) =>
      run(
        'price-review-create',
        () => api.post(`/orders/${order.id}/price-reviews`, { proposedPrice, reasonCode }),
        'Could not submit price review'
      ),
    onRespondReview: (reviewId, action, proposedPrice, reasonCode) =>
      run(
        `price-review-${reviewId}-${action.toLowerCase()}`,
        () => api.patch(`/orders/${order.id}/price-reviews/${reviewId}/respond`, { action, ...(proposedPrice ? { proposedPrice, reasonCode } : {}) }),
        'Could not respond to price review'
      ),
    onScrollToPayment: () => scrollToId('payment-center', 150),
  };

  const canCancelOrder = Boolean(
    order &&
      !['COMPLETED', 'CANCELLED'].includes(order.status) &&
      !transportInMotion &&
      (isAdmin ||
        (isBuyer && order.status === 'PENDING_PAYMENT') ||
        (isSeller && ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)))
  );

  const cancelOrder = () => {
    if (!canCancelOrder) return;
    if (!window.confirm('Cancel this order? This cannot be undone. The listing becomes available again and completed payments are flagged for refund.')) return;
    const reason = window.prompt('Optional: add a reason for cancelling (shown in the order history).') || undefined;
    return run('cancel', () => api.patch(`/orders/${order.id}/cancel`, reason ? { reason } : {}), 'Could not cancel order');
  };

  const confirmReceipt = () => {
    if (!isBuyer) return setError('Only the buyer can confirm receipt');
    if (!marketplacePaid) return setError('Marketplace payment must be confirmed before receipt');
    if (hiredTransport && !transportPaid) return setError('Transport payment must be confirmed before receipt');
    return run('receipt', () => api.patch(`/orders/${order.id}/confirm-receipt`), 'Could not confirm receipt');
  };

  const submitOffer = async (event) => {
    event.preventDefault();
    const amount = Number(offerAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !order?.listingId) {
      return setError('Enter a valid offer amount before submitting.');
    }
    setSubmittingOffer(true);
    const ok = await run('offer', () => api.post('/offers', { listingId: order.listingId, amount }), 'Could not submit your offer');
    setSubmittingOffer(false);
    if (ok) {
      setOfferAmount('');
      setError('Offer submitted. The seller can select it and begin negotiation.');
    }
  };

  const refundAction = (refund) =>
    run(`refund-${refund.id}`, () => {
      const base = `/admin/financial/refunds/${refund.id}`;
      if (refund.status === 'PROCESSING') return api.post(`${base}/verify`);
      if (refund.status === 'FAILED') return api.post(`${base}/retry`);
      return api.post(`${base}/process`);
    }, 'Could not process or verify the refund with Chapa');

  const failRefund = (refund) => {
    const reason = window.prompt('Why did this refund fail?', '');
    if (reason === null) return;
    if (!reason.trim()) return setError('Enter a reason before marking a refund as failed.');
    return run(`refund-${refund.id}`, () => api.patch(`/admin/financial/refunds/${refund.id}/fail`, { failureReason: reason.trim() }), 'Could not mark the refund as failed');
  };

  const disputeCounterparties = useMemo(() => {
    if (!order) return [];
    return [
      order.buyer && { id: order.buyer.id, name: order.buyer.name, role: 'Buyer' },
      order.seller && { id: order.seller.id, name: order.seller.name, role: 'Seller' },
      ...inspections.filter((r) => r.inspector).map((r) => ({ id: r.inspector.id, name: r.inspector.name, role: 'Inspector' })),
      transportJob?.truckOwner && { id: transportJob.truckOwner.id, name: transportJob.truckOwner.name, role: 'Truck owner' },
    ]
      .filter(Boolean)
      .filter((p) => p.id !== currentUserId);
  }, [order, transportJob, inspections, currentUserId]);

  const canRaiseDispute = Boolean(
    order &&
      !['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(order.status) &&
      (isBuyer || isSeller || isInspector || isTransporter) &&
      disputeCounterparties.length > 0
  );

  const submitDispute = async (event) => {
    event.preventDefault();
    if (!canRaiseDispute) return;
    if (!disputeAgainstId) return setError('Choose who the dispute is against');
    if (!disputeDescription.trim()) return setError('Describe what went wrong');
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
      await reload();
    } catch (err) {
      const message = getError(err, 'Could not raise dispute');
      if (/cannot be disputed/i.test(message) || /already has an open dispute/i.test(message)) {
        setError(`${message} If the order was cancelled, any payments already made (including an inspection fee) are refunded automatically — check the Payment Center for its status instead of disputing.`);
        await reload();
      } else {
        setError(message);
      }
    } finally {
      setSubmittingDispute(false);
    }
  };

  if (loading) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <div className="card loading"><p>Loading order…</p></div>
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <div className="alert error">{error || 'Order not found'}</div>
        </div>
      </main>
    );
  }

  const orderOpen = !['COMPLETED', 'CANCELLED'].includes(order.status);

  const inspectionProps = {
    all: allInspections,
    current: currentInspection,
    formReleased: inspectionFormReleased,
    requesting: requestingInspection,
    workDetails: inspectionWorkDetails,
    setWorkDetails: setInspectionWorkDetails,
    isBuyer,
    isAdmin,
    isParticipant,
    isAgricultural,
    decisionRequired,
    busy,
    onOpenModal: setActiveModal,
    ...inspectionActions,
  };

  const transportProps = {
    job: transportJob,
    currentUserId,
    isBuyer,
    isSeller,
    isTransporter,
    isArranger: isTransportArranger,
    canArrange: Boolean(!transportJob && order.status !== 'CANCELLED' && (isPhysicalGoods ? isBuyer : isParticipant)),
    blockedReason: transportBlockedReason,
    buyerOnly: isPhysicalGoods,
    canChooseQuote: Boolean(transportJob && isTransportArranger && ['REQUESTED', 'QUOTED'].includes(transportJob.status)),
    canStartPayment: canStartTransportPayment,
    canResumePayment: Boolean(transportPayment) && transportPayment.status === 'PENDING' && isBuyer,
    paid: transportPaid,
    paidAmount: transportPayments.find((p) => p.status === 'PAID')?.amount,
    pending: transportPending,
    payment: transportPayment,
    payMethod,
    setPayMethod,
    pay: payTransport,
    resume: resumePayment,
    busy,
    reload,
    recoveryRequests,
    counterInputs,
    setCounterInputs,
    evidence,
    setEvidence,
    notes: evidenceNotes,
    setNotes: setEvidenceNotes,
    evidenceBusy,
    loadingReport,
    loadingReportEvidence,
    allOrderPaymentsSettled,
    marketplacePaid,
    missingPayments,
    onOpenModal: setActiveModal,
    openProviderRelease,
    run,
  };

  const disputeProps = {
    canRaise: canRaiseDispute,
    counterparties: disputeCounterparties,
    againstId: disputeAgainstId,
    setAgainstId: setDisputeAgainstId,
    type: disputeType,
    setType: setDisputeType,
    description: disputeDescription,
    setDescription: setDisputeDescription,
    submitting: submittingDispute,
    submitted: disputeSubmitted,
    submit: submitDispute,
  };

  return (
    <main className="section order-detail-page">
      <div className="container-narrow">
        <div className="row-between page-bar">
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <Button size="sm" disabled={refreshing} busy={refreshing} busyText="Refreshing…" onClick={reload}>Refresh</Button>
        </div>

        <div className="od-page-grid">
          <div className="od-span-all">
            <OverviewCard
              order={order}
              title={title}
              flags={{ isBuyer, isSeller, marketplacePaid, marketplacePending, transportJob }}
              canCancel={canCancelOrder}
              busy={busy}
              onCancel={cancelOrder}
              inspectionApplies={inspectionApplies}
            />
          </div>

          {isBuyer && (
            <div className="od-span-all">
              <BuyerConfidenceCard order={order} recoveryRequests={recoveryRequests} />
            </div>
          )}

          {workflow ? (
            <ActionCenter workflow={workflow} onScroll={goToSection} onActionComplete={reload} />
          ) : (
            isInspector && (
              <Card id="next-action" tone="accent" eyebrow="Next step" title="Inspector action">
                {assignedInspection.status === 'ACCEPTED' && <p>Start the accepted inspection.</p>}
                {assignedInspection.status === 'IN_PROGRESS' && <p>Complete the inspection and publish the evidence report.</p>}
                {assignedInspection.status === 'COMPLETED' && <p>The report is published. The buyer can now complete any required inspection payment and continue.</p>}
                <Actions><Link className="btn btn-primary" to="/dashboard/inspector">Open inspection dashboard</Link></Actions>
              </Card>
            )
          )}

          {isProduct && isBuyer && !order.agreedOfferId && (
            <OfferCard
              amount={offerAmount}
              setAmount={setOfferAmount}
              reference={Number(order.listing?.askingPrice ?? order.listing?.price)}
              submitting={submittingOffer}
              onSubmit={submitOffer}
            />
          )}

          {inspectionApplies && isParticipant && orderOpen && (
            <InspectionCard order={order} title={title} i={inspectionProps} />
          )}

          <div className="od-span-all">
            <TransportCard order={order} t={transportProps} />
          </div>

          {(!isProduct || order.agreedOfferId) && (
            <div className="od-span-all">
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
            </div>
          )}

          {order.status === 'DELIVERED' && isBuyer && (
            <ReceiptCard
              marketplacePaid={marketplacePaid}
              transportBlocked={hiredTransport && !transportPaid}
              busy={busy}
              onConfirm={confirmReceipt}
            />
          )}

          <div className="od-span-all">
            <PayoutStatusCard
              payouts={{ seller: payoutBy('SELLER'), inspector: payoutBy('INSPECTOR'), transporter: payoutBy('TRANSPORTER') }}
              names={{ seller: order.seller?.name || null, inspector: inspectorName, transporter: transportJob?.truckOwner?.name || null }}
              you={{ seller: isSeller, inspector: isInspector, transporter: isTransporter }}
            />
          </div>

          <RefundStatusCard
            refunds={refunds}
            payouts={payouts}
            people={{
              SELLER: { name: order.seller?.name || null, you: isSeller },
              INSPECTOR: { name: inspectorName, you: isInspector },
              TRANSPORTER: { name: transportJob?.truckOwner?.name || null, you: isTransporter },
            }}
            isAdmin={isAdmin}
            busy={busy}
            onComplete={refundAction}
            onFail={failRefund}
          />

          {workflow && (
            <div className="od-span-all">
              <Card eyebrow="History" title="Order timeline" subtitle="Everything that has happened on this order">
                <OrderTimeline steps={workflow.timeline?.steps} events={workflow.timeline?.events} />
              </Card>
            </div>
          )}

          <DisputeCard order={order} d={disputeProps} />

          {order.status === 'COMPLETED' && (
            <Card eyebrow="Closed" title="Order completed">
              <Notice title="✓ This order has been completed.">
                <p className="muted">Receipt was confirmed by the buyer.</p>
              </Notice>
            </Card>
          )}

          <RatingBox order={order} userId={currentUserId} onRated={reload} />

          {isAdmin && (
            <Card eyebrow="Admin" title="Administrator view" subtitle="You are viewing this order with administrator access." />
          )}
        </div>
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────── */}

      <Modal
        isOpen={activeModal === 'inspection-request-form'}
        onClose={() => setActiveModal(null)}
        title="Request an Inspection"
      >
        <InspectionRequestForm
          workDetails={inspectionWorkDetails}
          setWorkDetails={setInspectionWorkDetails}
          requesting={requestingInspection}
          isBuyer={isBuyer}
          onCancel={() => setActiveModal(null)}
          request={async (mode) => {
            const ok = await inspectionProps.request(mode);
            if (ok) setActiveModal(null);
          }}
        />
      </Modal>

      <Modal
        isOpen={activeModal === 'transport-setup-form'}
        onClose={() => setActiveModal(null)}
        title="Arrange Transport"
      >
        <TransportSetup
          orderId={order.id}
          pickupDefault={order.listing?.location}
          loadDefault={[order.listing?.title, order.listing?.cropType].filter(Boolean)[0] || ''}
          destinationDefault={order.buyer?.location}
          canBuyer={isBuyer}
          canSeller={isSeller}
          buyerOnlyCompetition={isPhysicalGoods}
          onCreated={() => {
            reload();
            setActiveModal(null);
          }}
        />
      </Modal>

      <Modal
        isOpen={activeModal === 'inspection-coordination'}
        onClose={() => setActiveModal(null)}
        title="Inspection Coordination"
      >
        {currentInspection?.id && (
          <InspectionCoordinationSeller inspectionRequestId={currentInspection.id} />
        )}
      </Modal>

      <Modal
        isOpen={activeModal === 'seller-transport-coordination'}
        onClose={() => setActiveModal(null)}
        title="Pickup Handoff (Seller)"
      >
        {transportJob?.id && <TransportCoordinationSeller transportJobId={transportJob.id} />}
      </Modal>

      <ProviderReleaseDialog
        open={Boolean(providerReleaseTarget)}
        serviceLabel={providerReleaseTarget?.service === 'INSPECTION' ? 'inspection' : 'transport'}
        busy={Boolean(busy)}
        onConfirm={submitProviderRelease}
        onClose={() => setProviderReleaseTarget(null)}
      />

      {error && (
        <div className="order-detail-toast" role="alert" aria-live="assertive">
          <span className="order-detail-toast-icon" aria-hidden="true">!</span>
          <span className="order-detail-toast-message">{error}</span>
          <button type="button" className="order-detail-toast-close" onClick={() => setError('')} aria-label="Dismiss message">×</button>
        </div>
      )}
    </main>
  );
}
