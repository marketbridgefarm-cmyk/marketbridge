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

import './order-details/OrderDetail.css';

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

const statusTone = (status) => {
  const value = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'PAID', 'ACCEPTED', 'CONFIRMED'].includes(value)) return 'good';
  if (['CANCELLED', 'REJECTED', 'FAILED', 'DISPUTED'].includes(value)) return 'bad';
  if (['PENDING', 'AWAITING_PAYMENT', 'IN_PROGRESS', 'PROCESSING'].includes(value)) return 'wait';
  return 'neutral';
};

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
      <header className="card-head">
        <div className="card-head-text">
          <span className="eyebrow">PAYOUTS</span>
          <h2>Order Payout Status</h2>
        </div>
      </header>

      <div className="card-body">
        <section className="card-block">
          <div className="card-block-title">
            <h3>How the hold works</h3>
          </div>
          <div className="card-block-body">
            <p className="payout-intro">
              Buyer payment is separate from each payout below. Once the relevant payment settles, a{' '}
              <span className="payout-hold-chip">3-day</span> hold applies to every payout during the
              post-payment protection window.{' '}
              {anyDispute
                ? 'One or more payouts are frozen while a dispute is open.'
                : 'No manual action is required.'}
            </p>
          </div>
        </section>

        <section className="card-block">
          <div className="card-block-title">
            <h3>Breakdown by party</h3>
          </div>
          <div className="card-block-body">
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
          </div>
        </section>

        {dueMs !== null && (
          <section className="card-block">
            <div className="card-block-title">
              <h3>Common due</h3>
            </div>
            <div className="card-block-body">
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
            </div>
          </section>
        )}

        {dueMs === null && holdNotStarted && (
          <section className="card-block">
            <div className="card-block-title">
              <h3>Common due</h3>
            </div>
            <div className="card-block-body">
              <div className="payout-due payout-due-idle" role="group" aria-label="Common due">
                <div className="payout-due-when">
                  <span className="payout-due-label">Common due</span>
                  <span className="payout-due-date">Starts after payment settles</span>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
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

const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
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
  const [offerAmount, setOfferAmount] = useState('');
  const [offerMessage, setOfferMessage] = useState('');
  const [submittingOffer, setSubmittingOffer] = useState(false);

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
      if (errorToastTimer.current) window.clearTimeout(errorToastTimer.current);
    };
  }, [error]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!orderId) return;
      if (silent) setRefreshing(true); else setLoading(true);
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
        setWorkflow(
          workflowResponse.status === 'fulfilled'
            ? workflowResponse.value.data?.workflow || null
            : null
        );
      } catch (err) {
        setError(getError(err, 'Could not load order'));
      } finally {
        if (silent) setRefreshing(false); else setLoading(false);
      }
    },
    [orderId]
  );

  useEffect(() => { load(); }, [load]);

  async function submitProductOffer(event) {
    event.preventDefault();
    const amount = Number(offerAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !order?.listingId) {
      setError('Enter a valid offer amount before submitting.');
      return;
    }
    setSubmittingOffer(true);
    setError('');
    try {
      await api.post('/offers', {
        listingId: order.listingId,
        amount,
        message: offerMessage.trim() || undefined,
      });
      setOfferAmount('');
      setOfferMessage('');
      await load({ silent: true });
      setError('Offer submitted. The seller can select it and begin negotiation.');
    } catch (err) {
      setError(getError(err, 'Could not submit your offer'));
    } finally {
      setSubmittingOffer(false);
    }
  }

  useEffect(() => {
    if (loading) return;
    const id = location.hash?.replace('#', '');
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading, location.hash]);

  const transportJob = order?.transportJob || null;
  const payments = Array.isArray(order?.payments) ? order.payments : [];

  const currentUserId = user?.id || user?.userId || user?._id || null;
  const userRoles = Array.isArray(user?.roles) ? user.roles : [];
  const isAdmin = userRoles.includes('ADMIN');

  const isBuyer = Boolean(order && currentUserId && currentUserId === order.buyerId);
  const isSeller = Boolean(order && currentUserId && currentUserId === order.sellerId);
  const isParticipant = isBuyer || isSeller;

  const buyerIdentityMismatch = Boolean(
    order && currentUserId && !isBuyer && !isSeller && !isAdmin
  );

  const isAgricultural = order?.listing?.category === 'AGRICULTURAL';
  const isProductsMarketplace = order?.listing?.category === 'PRODUCT';
  const inspectionApplies = isAgricultural || isProductsMarketplace;

  const inspectionRequests = useMemo(
    () =>
      (order?.inspectionRequests || order?.listing?.inspectionRequests || [])
        .filter((request) => request.status !== 'CANCELLED')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [order?.listing?.inspectionRequests]
  );

  const currentInspectionRequest = inspectionRequests[0] || null;

  const assignedInspection = useMemo(
    () => inspectionRequests.find((request) => request.inspectorId === currentUserId) || null,
    [inspectionRequests, currentUserId]
  );

  const isInspector = Boolean(assignedInspection);
  const isTransporter = Boolean(
    transportJob?.truckOwnerId && transportJob.truckOwnerId === currentUserId
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

  const inspectionPaymentGroups = useMemo(
    () =>
      inspectionApplies
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
              note: request.status !== 'COMPLETED' ? `Inspection status: ${request.status}` : null,
              busyKey,
              canCheck: requestPayment?.status === 'PROCESSING',
              canResume: Boolean(requestPayment) && requestPayment.status !== 'PROCESSING',
              onCheck: () => checkPaymentStatus(requestPayment?.id, busyKey),
              onResume: () => resumePayment(requestPayment?.id, busyKey),
              onPay: () => payInspection(request),
            };
          })
        : [],
    [inspectionApplies, inspectionPaymentRows]
  );

  const isTransportArranger = Boolean(
    transportJob &&
    (
      (transportJob.arrangingParty === 'BUYER' && isBuyer) ||
      (transportJob.arrangingParty === 'SELLER' && isSeller) ||
      (transportJob.arrangingParty === 'JOINT' && isParticipant)
    )
  );

  const title = order?.listing?.title || order?.listing?.cropType || 'Order';

  const marketplacePayments = useMemo(
    () => payments.filter((payment) => payment.type === 'MARKETPLACE'),
    [payments]
  );

  const transportPayments = useMemo(
    () => payments.filter((payment) => payment.type === 'TRANSPORT'),
    [payments]
  );

  const marketplacePayment = useMemo(() => {
    return (
      marketplacePayments.find((payment) => ['PENDING', 'PROCESSING'].includes(payment.status)) ||
      marketplacePayments.find((payment) => payment.status === 'PAID') ||
      null
    );
  }, [marketplacePayments]);

  const installmentPlan = useMemo(
    () =>
      marketplacePayments.find(
        (payment) =>
          payment.installmentCount != null &&
          ['PENDING', 'PROCESSING', 'PAID'].includes(payment.status)
      ) || null,
    [marketplacePayments]
  );

  const installmentPayments = useMemo(
    () =>
      payments
        .filter(
          (payment) =>
            payment.type === 'MARKETPLACE_INSTALLMENT' &&
            payment.installmentSequence != null &&
            (!installmentPlan || payment.parentPaymentId === installmentPlan.id)
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
      !installmentPayments.every((payment) => payment.status === 'PAID') ||
      planHealRef.current === installmentPlan.id
    ) return;

    planHealRef.current = installmentPlan.id;
    api.get(`/payments/${installmentPlan.id}/chapa/verify`)
      .then(() => load({ silent: true }))
      .catch(() => {});
  }, [installmentPlan, installmentPayments]); // eslint-disable-line react-hooks/exhaustive-deps

  const transportPayment = useMemo(() => {
    return (
      transportPayments.find((payment) => ['PENDING', 'PROCESSING'].includes(payment.status)) ||
      transportPayments.find((payment) => payment.status === 'PAID') ||
      null
    );
  }, [transportPayments]);

  const marketplacePaid = marketplacePayments.some((payment) => payment.status === 'PAID');
  const marketplacePending = marketplacePayments.some((payment) =>
    ['PENDING', 'PROCESSING'].includes(payment.status)
  );
  const marketplaceProcessing = marketplacePayments.some((payment) => payment.status === 'PROCESSING');
  const transportPaid = transportPayments.some((payment) => payment.status === 'PAID');

  const payouts = order?.payouts || [];
  const sellerPayout = payouts.find((p) => p.payeeRole === 'SELLER') || null;
  const transporterPayout = payouts.find((p) => p.payeeRole === 'TRANSPORTER') || null;
  const inspectorPayout = payouts.find((p) => p.payeeRole === 'INSPECTOR') || null;
  const refunds = order?.refunds || [];

  const formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  const transportPending = transportPayments.some((payment) =>
    ['PENDING', 'PROCESSING'].includes(payment.status)
  );
  const transportProcessing = transportPayments.some((payment) => payment.status === 'PROCESSING');

  const canArrangeTransport =
    Boolean(order) && !transportJob && order.status !== 'CANCELLED' && isParticipant;

  const canChooseQuote =
    Boolean(transportJob) &&
    isTransportArranger &&
    ['REQUESTED', 'QUOTED'].includes(transportJob.status);

  const acceptedTransportQuote = Array.isArray(transportJob?.quotes)
    ? transportJob.quotes.find((quote) => quote.status === 'ACCEPTED')
    : null;

  const canStartTransportPayment =
    Boolean(transportJob) &&
    transportJob.method === 'HIRE_TRANSPORTER' &&
    Boolean(transportJob.truckOwnerId) &&
    Boolean(acceptedTransportQuote) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    ['QUOTED', 'ACCEPTED'].includes(transportJob.status) &&
    !transportPayments.some((payment) =>
      ['PENDING', 'PROCESSING', 'PAID'].includes(payment.status)
    ) &&
    isBuyer;

  const canResumeTransportPayment =
    Boolean(transportPayment) && transportPayment.status === 'PENDING' && isBuyer;

  const canCheckTransportPayment =
    Boolean(transportPayment) && transportPayment.status === 'PROCESSING' && isBuyer;

  const inspectionPurchaseGateMet = !inspectionApplies
    ? true
    : Boolean(
        currentInspectionRequest &&
        currentInspectionRequest.status === 'COMPLETED' &&
        currentInspectionRequest.report
      );

  const buyerDecisionRequired = isAgricultural || isProductsMarketplace;
  const buyerDecisionGateMet = !buyerDecisionRequired || order?.buyerDecision === 'BUY';
  const negotiatedProductGateMet = !isProductsMarketplace || Boolean(order?.agreedOfferId);

  const canPayMarketplace =
    Boolean(order) &&
    order.status !== 'COMPLETED' &&
    order.status !== 'CANCELLED' &&
    isBuyer &&
    inspectionPurchaseGateMet &&
    buyerDecisionGateMet &&
    negotiatedProductGateMet &&
    !marketplacePayments.some((payment) =>
      ['PENDING', 'PROCESSING', 'PAID'].includes(payment.status)
    );

  const marketplaceBlockedReason =
    isProductsMarketplace && !negotiatedProductGateMet
      ? 'This product must first be won through seller bidding and bilateral negotiation before payment.'
      : inspectionApplies && !inspectionPurchaseGateMet
      ? (!currentInspectionRequest
        ? 'Request and complete the inspection before paying for the goods.'
        : 'Complete the current inspection and make sure its report is published before paying for the goods.')
      : buyerDecisionRequired && !buyerDecisionGateMet
        ? `Choose BUY after reviewing the ${isAgricultural ? 'agricultural ' : ''}inspection report before paying for the goods.`
        : null;

  const canResumeMarketplacePayment =
    Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PENDING' && isBuyer;

  const canCheckMarketplacePayment =
    Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PROCESSING' && isBuyer;

  const counterpartId = isBuyer ? order?.sellerId : isSeller ? order?.buyerId : null;
  const counterpartName = isBuyer ? order?.seller?.name : isSeller ? order?.buyer?.name : null;

  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const selectTransportQuote = async (quoteId) => {
    if (!quoteId) return;
    setBusy(`quote-${quoteId}`);
    setError('');
    try {
      await api.patch(`/transport/quotes/${quoteId}/select`);
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not select transport bid'));
    } finally {
      setBusy('');
    }
  };

  const releaseTransportAgreement = async (quoteId) => {
    if (!quoteId) return;
    setBusy(`quote-${quoteId}`);
    setError('');
    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'WITHDRAW' });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not release the transporter agreement'));
    } finally {
      setBusy('');
    }
  };

  const acceptQuote = async (quoteId) => {
    if (!quoteId) return;
    setBusy(`quote-${quoteId}`);
    setError('');
    try {
      await api.patch(`/transport/quotes/${quoteId}`, { action: 'ACCEPT' });
      await load({ silent: true });
      window.setTimeout(() => document.getElementById('payment-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } catch (err) {
      setError(getError(err, 'Could not accept transport quote'));
    } finally {
      setBusy('');
    }
  };

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

  const payMarketplace = async () => {
    if (!order) return;
    if (!isBuyer) { setError('Only the buyer can make the marketplace payment'); return; }
    const amount = Number(order.finalPrice);
    if (!Number.isFinite(amount) || amount <= 0) { setError('Invalid marketplace payment amount'); return; }
    setBusy('pay-marketplace');
    setError('');
    try {
      await startChapaPayment({
        type: 'MARKETPLACE',
        orderId: order.id,
        amount,
        method: payMethod,
      });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not start marketplace payment'));
    } finally {
      setBusy('');
    }
  };

  const findInspector = async () => {
    if (!order?.listing) return;
    setFindingInspector(true);
    setError('');
    try {
      const response = await api.get('/inspections/inspectors', {
        params: { location: order.listing.location },
      });
      const options = response.data?.inspectors || [];
      if (!options.length) { setError('No inspectors were found in this area.'); return; }
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
    setRequestingInspection(true);
    try {
      const body = { orderId: order.id, listingId: order.listing.id, mode };
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
        await api.patch(`/transport/${transportJob.id}/status`, { status: nextStatus });
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

  const payTransport = async () => {
    if (!order || !transportJob) return;
    if (!isParticipant) { setError('You are not authorized to pay for this transport'); return; }
    if (transportJob.method !== 'HIRE_TRANSPORTER') { setError('Transport payment is only required for hired transport'); return; }
    if (!transportJob.truckOwnerId) { setError('A transporter must be selected before transport payment'); return; }
    const amount = Number(transportJob.agreedAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setError('Invalid transport payment amount'); return; }
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
      setError(getError(err, 'Could not start transport payment'));
    } finally {
      setBusy('');
    }
  };

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

  const resumePayment = async (paymentId, busyKey) => {
    if (!paymentId) return;
    setBusy(busyKey);
    setError('');
    try {
      await chapaInitializeAndRedirect(paymentId);
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not resume payment'));
    } finally {
      setBusy('');
    }
  };

  const startInstallments = async () => {
    if (!order) return;
    if (!isBuyer) { setError('Only the buyer can make the marketplace payment'); return; }
    setBusy('start-installments');
    setError('');
    try {
      await api.post('/payments', {
        type: 'MARKETPLACE',
        orderId: order.id,
        amount: Number(order.finalPrice),
        method: payMethod,
        installments: true,
      });
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not set up installments'));
    } finally {
      setBusy('');
    }
  };

  const retryInstallment = async (installment) => {
    if (!installment?.id) return;
    setBusy(`installment-${installment.id}`);
    setError('');
    try {
      await api.post(`/payments/${installment.id}/retry-installment`);
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not retry this installment'));
    } finally {
      setBusy('');
    }
  };

  const payInstallment = (installment) =>
    resumePayment(installment?.id, `installment-${installment?.id}`);

  const checkInstallment = (installment) =>
    checkPaymentStatus(installment?.id, `installment-${installment?.id}`);

  const completeRefundAsAdmin = async (refund) => {
    setBusy(`refund-${refund.id}`);
    setError('');
    try {
      if (refund.status === 'PROCESSING') {
        await api.post(`/admin/financial/refunds/${refund.id}/verify`);
      } else if (refund.status === 'FAILED') {
        await api.post(`/admin/financial/refunds/${refund.id}/retry`);
      } else {
        await api.post(`/admin/financial/refunds/${refund.id}/process`);
      }
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not process or verify the refund with Chapa'));
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

  const disputeCounterparties = useMemo(() => {
    if (!order) return [];
    const parties = [
      order.buyer && { id: order.buyer.id, name: order.buyer.name, role: 'Buyer' },
      order.seller && { id: order.seller.id, name: order.seller.name, role: 'Seller' },
      ...(inspectionRequests || [])
        .filter((request) => request.inspector)
        .map((request) => ({
          id: request.inspector.id,
          name: request.inspector.name,
          role: 'Inspector',
        })),
      transportJob?.truckOwner && {
        id: transportJob.truckOwner.id,
        name: transportJob.truckOwner.name,
        role: 'Truck owner',
      },
    ].filter(Boolean);
    return parties.filter((p) => p.id !== currentUserId);
  }, [order, transportJob, inspectionRequests, currentUserId]);

  const canRaiseDispute = Boolean(
    order &&
    !['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(order.status) &&
    (isBuyer || isSeller || isInspector || isTransporter) &&
    disputeCounterparties.length > 0
  );

  const raiseDispute = async (event) => {
    event.preventDefault();
    if (!order || !canRaiseDispute) return;
    if (!disputeAgainstId) { setError('Choose who the dispute is against'); return; }
    if (!disputeDescription.trim()) { setError('Describe what went wrong'); return; }
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
      const message = getError(err, 'Could not raise dispute');
      if (/cannot be disputed/i.test(message) || /already has an open dispute/i.test(message)) {
        setError(`${message} If the order was cancelled, any payments already made (including an inspection fee) are refunded automatically as part of that cancellation — check the Payment Center below for its status instead of disputing.`);
        await load({ silent: true });
      } else {
        setError(message);
      }
    } finally {
      setSubmittingDispute(false);
    }
  };

  const makeBuyerDecision = async (decision) => {
    if (!order || !isBuyer || !(isAgricultural || isProductsMarketplace)) return;
    if (decision === 'BUY' && (!currentInspectionRequest?.report || currentInspectionRequest?.status !== 'COMPLETED')) {
      setError('Review the completed inspection report before choosing BUY.');
      return;
    }
    if (decision === 'CANCEL') {
      const confirmed = window.confirm('Cancel this purchase after reviewing the inspection report? This cannot be undone.');
      if (!confirmed) return;
    }
    setBusy(`buyer-decision-${decision.toLowerCase()}`);
    setError('');
    try {
      await api.patch(`/orders/${order.id}/buyer-decision`, { decision });
      await load({ silent: true });
      window.setTimeout(() => {
        document.getElementById(decision === 'BUY' ? 'payment-center' : 'inspection-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    } catch (err) {
      setError(getError(err, `Could not record ${decision === 'BUY' ? 'BUY' : 'cancellation'} decision`));
    } finally {
      setBusy('');
    }
  };

  const confirmReceipt = async () => {
    if (!order) return;
    if (!isBuyer) { setError('Only the buyer can confirm receipt'); return; }
    if (!marketplacePaid) { setError('Marketplace payment must be confirmed before receipt'); return; }
    if (transportJob?.method === 'HIRE_TRANSPORTER' && !transportPaid) {
      setError('Transport payment must be confirmed before receipt');
      return;
    }
    setBusy('receipt');
    setError('');
    try {
      await api.patch(`/orders/${order.id}/confirm-receipt`);
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not confirm receipt'));
    } finally {
      setBusy('');
    }
  };

  const transportInMotion = Boolean(
    transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(transportJob.status)
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
    const confirmed = window.confirm('Cancel this order? This cannot be undone. The listing will become available again and any completed payments will be flagged for refund.');
    if (!confirmed) return;
    const reason = window.prompt('Optional: add a reason for cancelling (shown in the order history).') || undefined;
    setBusy('cancel');
    setError('');
    try {
      await api.patch(`/orders/${order.id}/cancel`, reason ? { reason } : {});
      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not cancel order'));
    } finally {
      setBusy('');
    }
  };

  const installmentStartEligible =
    Boolean(order) &&
    isBuyer &&
    !marketplacePaid &&
    !marketplaceBlockedReason &&
    Number(order.finalPrice) > Number(workflow?.payments?.marketplace?.maxOnlineAmount || 0);

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
    installmentPlan,
    installments: installmentPayments,
    canStartInstallments: installmentStartEligible,
    onStartInstallments: startInstallments,
    onPayInstallment: payInstallment,
    onCheckInstallment: checkInstallment,
    onRetryInstallment: retryInstallment,
  };

  const transportObligation = transportJob
    ? {
        required: transportJob.method === 'HIRE_TRANSPORTER',
        readyToPay: ['QUOTED', 'ACCEPTED'].includes(transportJob.status) && Boolean(acceptedTransportQuote) && transportJob.agreedAmount != null,
        amount: transportJob.agreedAmount,
        paid: transportPaid,
        pending: transportPending,
        processing: transportProcessing,
        note:
          transportJob.method === 'HIRE_TRANSPORTER' &&
          !['QUOTED', 'ACCEPTED'].includes(transportJob.status) &&
          !transportPaid &&
          !transportPending
            ? 'Transporter payment becomes available after a provisional transporter agreement is accepted.'
            : null,
        canStart: canStartTransportPayment,
        canResume: canResumeTransportPayment,
        canCheck: canCheckTransportPayment,
        onStart: payTransport,
        onResume: () => resumePayment(transportPayment?.id, 'resume-transport'),
        onCheck: () => checkPaymentStatus(transportPayment?.id, 'check-transport'),
      }
    : null;

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

  return (
    <main className="section order-detail-page">
      <div className="container-narrow">

        <div className="row-between" style={{ marginBottom: 16 }}>
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => load({ silent: true })}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="order-hero">
          <div className="order-hero-main">
            <span className="eyebrow order-hero-eyebrow">ORDER {shortId(order.id)}</span>
            <h1 className="order-hero-title">{title}</h1>
            <div className="order-hero-meta">
              <span className={`status-pill tone-${statusTone(order.status)}`}>
                <span className="status-pill-dot" aria-hidden="true" />
                {String(order.status || '').replace(/_/g, ' ')}
              </span>
              {order.listing?.cropType && <span className="order-hero-chip">{order.listing.cropType}</span>}
              {order.listing?.quantity != null && <span className="order-hero-chip">{order.listing.quantity} units</span>}
            </div>
          </div>
          <div className="order-hero-side">
            <span className="order-hero-price-label">Order total</span>
            <span className="order-hero-price">{money(order.finalPrice)} <small>ETB</small></span>
            {canCancelOrder && (
              <button type="button" className="btn btn-outline btn-sm" disabled={busy === 'cancel'} onClick={cancelOrder}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
              </button>
            )}
          </div>
        </div>

        {workflow ? (
          <ActionCenter
            workflow={workflow}
            onScroll={scrollToSection}
            onActionComplete={() => load({ silent: true })}
          />
        ) : (
          isInspector && (
            <div className="card next-action-card" id="next-action">
              <header className="card-head">
                <div className="card-head-text">
                  <span className="eyebrow">NEXT STEP</span>
                  <h2>Inspector action</h2>
                </div>
              </header>
              <div className="card-body">
                <section className="card-block">
                  <div className="card-block-title"><h3>What to do</h3></div>
                  <div className="card-block-body">
                    {assignedInspection.status === 'ACCEPTED' && <p>Start the accepted inspection.</p>}
                    {assignedInspection.status === 'IN_PROGRESS' && <p>Complete the inspection and publish the evidence report.</p>}
                    {assignedInspection.status === 'COMPLETED' && <p>Inspection report is published. The buyer can now complete any required inspection payment and continue the order.</p>}
                  </div>
                </section>
                <div className="next-action-buttons">
                  <Link className="btn btn-primary" to="/dashboard/inspector">Open inspection dashboard</Link>
                </div>
              </div>
            </div>
          )
        )}

        {workflow && (
          <div className="card">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">PROGRESS</span>
                <h2>Order timeline</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>Steps and events</h3></div>
                <div className="card-block-body">
                  <OrderTimeline steps={workflow.timeline?.steps} events={workflow.timeline?.events} />
                </div>
              </section>
            </div>
          </div>
        )}

        <div className="card order-overview-card">
          <header className="card-head">
            <div className="card-head-text">
              <span className="eyebrow">ORDER OVERVIEW</span>
              <h2>Order details</h2>
            </div>
            <span className={`status-pill tone-${statusTone(order.status)}`}>
              <span className="status-pill-dot" aria-hidden="true" />
              {String(order.status || '').replace(/_/g, ' ')}
            </span>
          </header>
          <div className="card-body">
            <section className="card-block">
              <div className="card-block-title"><h3>Order facts</h3></div>
              <div className="card-block-body">
                <div className="order-overview-facts">
                  <div className="order-overview-fact"><span>Order</span><strong>{shortId(order.id)}</strong></div>
                  <div className="order-overview-fact"><span>Amount</span><strong>{money(order.finalPrice)} ETB</strong></div>
                  {order.listing?.cropType && (
                    <div className="order-overview-fact"><span>Product</span><strong>{order.listing.cropType}</strong></div>
                  )}
                  {order.listing?.quantity != null && (
                    <div className="order-overview-fact"><span>Quantity</span><strong>{order.listing.quantity}</strong></div>
                  )}
                </div>
              </div>
            </section>
            <section className="card-block">
              <div className="card-block-title">
                <h3>Participants</h3>
                <span className="card-block-note">Buyer &amp; seller</span>
              </div>
              <div className="card-block-body">
                <div className="party-list party-list-inline">
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
            </section>
          </div>
        </div>

        <div id="inspection-section">
          {/* Note: inspection now renders for COMPLETED orders too — the
              quarterly report needs the published report to stay visible. */}
          {inspectionApplies && isParticipant && order.status !== 'CANCELLED' && (
            currentInspectionRequest ? (
              <div className="card">
                <header className="card-head">
                  <div className="card-head-text">
                    <span className="eyebrow">QUALITY</span>
                    <h2>{isProductsMarketplace ? 'Product inspection' : 'Inspection'}</h2>
                  </div>
                  <span className={`status-pill tone-${statusTone(currentInspectionRequest.status)}`}>
                    <span className="status-pill-dot" aria-hidden="true" />
                    {currentInspectionRequest.status.replace(/_/g, ' ')}
                  </span>
                </header>

                <div className="card-body">
                  <section className="card-block">
                    <div className="card-block-title"><h3>Inspection request</h3></div>
                    <div className="card-block-body">
                      <p className="muted">
                        An inspection already exists for this order. Continue with this inspection; a second request is not needed.
                      </p>
                      <div className="detail-facts">
                        <div><span>Status</span><strong>{currentInspectionRequest.status}</strong></div>
                        {currentInspectionRequest.inspector?.name && (
                          <div><span>Inspector</span><strong>{currentInspectionRequest.inspector.name}</strong></div>
                        )}
                        {currentInspectionRequest.fee != null && (
                          <div><span>Fee</span><strong>{money(currentInspectionRequest.fee)} ETB</strong></div>
                        )}
                      </div>
                    </div>
                  </section>

                  {currentInspectionRequest.status === 'COMPLETED' && currentInspectionRequest.report && (
                    <section className="card-block">
                      <div className="card-block-title">
                        <h3>{isAgricultural ? 'Agricultural inspection report' : 'Product inspection report'}</h3>
                        <span className="status-pill tone-good">
                          <span className="status-pill-dot" aria-hidden="true" />
                          Report published
                        </span>
                      </div>
                      <div className="card-block-body">
                        <div className="inspection-purchase-gate">
                          <div className="inspection-report-facts">
                            <div><span>Inspected quantity</span><strong>{currentInspectionRequest.report.quantity ?? '—'}</strong></div>
                            <div><span>{isProductsMarketplace ? 'Condition / quality' : 'Grade'}</span><strong>{currentInspectionRequest.report.grade || 'Not specified'}</strong></div>
                            {!isProductsMarketplace && (
                              <div><span>Moisture</span><strong>{currentInspectionRequest.report.moisture != null ? `${currentInspectionRequest.report.moisture}%` : 'Not recorded'}</strong></div>
                            )}
                            <div><span>Inspection status</span><strong>Completed</strong></div>
                          </div>

                          <div className="inspection-findings">
                            <div><span>Visible defects</span><p>{currentInspectionRequest.report.visibleDefects || 'No visible defects recorded.'}</p></div>
                            <div><span>Damage notes</span><p>{currentInspectionRequest.report.damageNotes || 'No damage notes recorded.'}</p></div>
                            <div><span>Packaging notes</span><p>{currentInspectionRequest.report.packagingNotes || 'No packaging notes recorded.'}</p></div>
                          </div>

                          {buyerDecisionRequired && order.buyerDecision ? (
                            <div className={`inspection-decision-state ${order.buyerDecision === 'BUY' ? 'is-buy' : 'is-cancel'}`}>
                              <span className="inspection-decision-icon" aria-hidden="true">{order.buyerDecision === 'BUY' ? '✓' : '×'}</span>
                              <div>
                                <strong>{order.buyerDecision === 'BUY' ? 'BUY decision recorded' : 'Purchase cancelled after inspection'}</strong>
                                <p>{order.buyerDecision === 'BUY' ? 'Goods payment is now unlocked. Transport can proceed only after the required payment gates are satisfied.' : 'The purchase decision is closed.'}</p>
                              </div>
                            </div>
                          ) : buyerDecisionRequired && isBuyer ? (
                            <div className="inspection-decision-panel">
                              <div>
                                <span className="eyebrow">PURCHASE DECISION</span>
                                <h3>What do you want to do with the inspected goods?</h3>
                                <p className="muted">Choose <strong>BUY</strong> only after reviewing the report. BUY unlocks goods payment; it does not by itself complete payment or arrange transport.</p>
                              </div>
                              <div className="inspection-decision-actions">
                                <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => makeBuyerDecision('BUY')}>
                                  {busy === 'buyer-decision-buy' ? 'Recording…' : 'BUY — continue purchase'}
                                </button>
                                <button type="button" className="btn btn-light" disabled={Boolean(busy)} onClick={() => makeBuyerDecision('CANCEL')}>
                                  {busy === 'buyer-decision-cancel' ? 'Cancelling…' : 'Cancel after inspection'}
                                </button>
                              </div>
                            </div>
                          ) : buyerDecisionRequired ? (
                            <div className="inspection-waiting-note">
                              <strong>Awaiting buyer decision</strong>
                              <span>The buyer must review this report and choose BUY or cancel before the purchase can move to the payment stage.</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </section>
                  )}
                </div>
              </div>
            ) : (
              <div className="card">
                <header className="card-head">
                  <div className="card-head-text">
                    <span className="eyebrow">QUALITY</span>
                    <h2>Request inspection</h2>
                  </div>
                </header>
                <div className="card-body">
                  <section className="card-block">
                    <div className="card-block-title"><h3>How it works</h3></div>
                    <div className="card-block-body">
                      <p className="muted">Request an independent quality check for this order before the purchase is finally committed.</p>
                      <p className="muted">All registered inspectors can compete for this request by submitting a sealed fee quote. You compare the bids, select one for negotiation, and only the accepted negotiated quote assigns the inspector. The inspection fee commits the inspector; the completed report is then reviewed before goods payment.</p>
                    </div>
                  </section>
                  <div className="sd-actions">
                    <button type="button" className="btn btn-primary" disabled={requestingInspection} onClick={() => requestInspection(isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}>
                      {requestingInspection ? 'Requesting…' : 'Open competitive inspection request'}
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        <div className="card transport-overview-card" id="transport-section">
          <header className="card-head">
            <div className="card-head-text">
              <div className="transport-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="presentation">
                  <path d="M3 6.5h11v9H3zM14 9h3.2l3 3.2V15H14z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                  <circle cx="7" cy="17" r="1.7" fill="currentColor" />
                  <circle cx="18" cy="17" r="1.7" fill="currentColor" />
                  <path d="M3 15h2M20 15h1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <span className="eyebrow">LOGISTICS</span>
                <h2>Transport</h2>
                <p className="muted">The buyer or seller arranges transport. MarketBridge does not automatically assign a transporter.</p>
              </div>
            </div>
            {transportJob?.status && (
              <span className="badge transport-status-badge">{String(transportJob.status).replace(/_/g, ' ')}</span>
            )}
          </header>

          <div className="card-body">
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
                <p className="muted">No transport arrangement recorded yet.</p>
              )
            ) : (
              <>
                <section className="card-block">
                  <div className="card-block-title"><h3>Trip details</h3></div>
                  <div className="card-block-body">
                    <div className="detail-facts transport-detail-facts">
                      <div><span>Arranged by</span><strong>{transportJob.arrangingParty || '—'}</strong></div>
                      <div><span>Method</span><strong>{transportJob.method || '—'}</strong></div>
                      <div><span>Status</span><strong><span className="badge">{transportJob.status}</span></strong></div>
                      <div><span>Pickup</span><strong>{transportJob.pickupLocation || '—'}</strong></div>
                      <div><span>Destination</span><strong>{transportJob.destination || '—'}</strong></div>
                      {transportJob.load && <div><span>Load</span><strong>{transportJob.load}</strong></div>}
                      {transportJob.requiredCapacity != null && (
                        <div><span>Required capacity</span><strong>{transportJob.requiredCapacity}</strong></div>
                      )}
                    </div>
                  </div>
                </section>

                {transportJob.truckOwner && (
                  <section className="card-block">
                    <div className="card-block-title"><h3>Assigned transporter</h3></div>
                    <div className="card-block-body">
                      <div className="notice transport-info-panel">
                        <div className="transport-panel-heading">
                          <span className="transport-panel-icon" aria-hidden="true">👤</span>
                          <h3>Transporter</h3>
                        </div>
                        <p><strong>{transportJob.truckOwner.name || '—'}</strong></p>
                        {transportJob.truckOwner.phone && <p className="muted">Phone: {transportJob.truckOwner.phone}</p>}
                        {transportJob.truck && (
                          <p>Truck: <strong>{transportJob.truck.registration || '—'}</strong>{' · '}{transportJob.truck.truckType || 'Truck'}{transportJob.truck.capacity != null && ` · ${transportJob.truck.capacity}t`}</p>
                        )}
                        {transportJob.agreedAmount != null && (
                          <p>Agreed transport fee: <strong>{money(transportJob.agreedAmount)} ETB</strong></p>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                <section className="card-block">
                  <div className="card-block-title"><h3>Pickup / delivery evidence</h3></div>
                  <div className="card-block-body">
                    <div className="notice transport-info-panel">
                      <div className="transport-panel-heading">
                        <span className="transport-panel-icon" aria-hidden="true">📍</span>
                        <h3>Evidence gallery</h3>
                      </div>
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
                  </div>
                </section>

                {transportJob.method === 'HIRE_TRANSPORTER' && !transportPaid && (
                  <section className="card-block">
                    <div className="card-block-title"><h3>Transport quotes</h3></div>
                    <div className="card-block-body">
                      <div className="match-box">
                        {leafTransportQuotes(transportJob.quotes)?.length ? (
                          leafTransportQuotes(transportJob.quotes).map((quote) => {
                            const displayAmount = quote.status === 'COUNTERED' ? (quote.counterAmount ?? quote.amount) : quote.amount;
                            const isArrangerTurn = quote.status === 'SELECTED' || (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');
                            const isCompetitionBid = quote.status === 'PENDING';
                            const isWaitingOnTransporter = quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';
                            return (
                              <div className="transporter" key={quote.id}>
                                <div>
                                  <strong>{quote.truckOwner?.name || 'Truck owner'}</strong>
                                  <p>
                                    {quote.truck?.truckType || 'Truck'}{' · '}
                                    {quote.truck?.capacity != null ? `${quote.truck.capacity}t` : 'Capacity —'}{' · '}
                                    {quote.truck?.registration || 'Registration —'}{' · '}
                                    ★ {typeof quote.truckOwner?.rating === 'number' ? quote.truckOwner.rating.toFixed(1) : '—'}
                                  </p>
                                  {quote.message && <p className="muted">{quote.message}</p>}
                                  <p>Status: <span className="badge">{quote.status || 'PENDING'}</span></p>
                                  {isWaitingOnTransporter && (
                                    <p className="muted">You countered {money(displayAmount)} ETB — waiting for the transporter to respond.</p>
                                  )}
                                </div>
                                <div>
                                  <strong>{money(displayAmount)} ETB</strong>

                                  {canChooseQuote && quote.status === 'ACCEPTED' && (
                                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                      <span className="muted small">Provisional transporter agreement. Release it if this transporter becomes unavailable before payment.</span>
                                      <button type="button" className="btn btn-light btn-sm" disabled={busy === `quote-${quote.id}`} onClick={() => releaseTransportAgreement(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Releasing…' : 'Release transporter'}
                                      </button>
                                    </div>
                                  )}
                                  {canChooseQuote && isCompetitionBid && (
                                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                      <button type="button" className="btn btn-primary btn-sm" disabled={busy === `quote-${quote.id}`} onClick={() => selectTransportQuote(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Selecting…' : 'Select bid for deal'}
                                      </button>
                                      <span className="muted small">Competition bid — selecting opens price negotiation.</span>
                                    </div>
                                  )}
                                  {canChooseQuote && isArrangerTurn && (
                                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                      <button type="button" className="btn btn-sm" disabled={busy === `quote-${quote.id}`} onClick={() => acceptQuote(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Accepting…' : 'Accept quote'}
                                      </button>
                                      <input
                                        type="number"
                                        min="1"
                                        placeholder="Counter (ETB)"
                                        style={{ width: 120 }}
                                        value={transportCounterInputs[quote.id] || ''}
                                        onChange={(e) => setTransportCounterInputs((q) => ({ ...q, [quote.id]: e.target.value }))}
                                      />
                                      <button type="button" className="btn btn-sm btn-light" disabled={busy === `quote-${quote.id}`} onClick={() => counterQuote(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Sending…' : 'Counter'}
                                      </button>
                                      <button type="button" className="btn btn-sm btn-light" disabled={busy === `quote-${quote.id}`} onClick={() => rejectQuote(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Rejecting…' : 'Reject'}
                                      </button>
                                    </div>
                                  )}
                                  {quote.status === 'ACCEPTED' && isTransportArranger && !transportPending && (
                                    <div style={{ marginTop: 8 }}>
                                      <p className="muted small">Provisional agreement — the truck is not committed until transport payment succeeds.</p>
                                      <button type="button" className="btn btn-sm btn-light" disabled={busy === `quote-${quote.id}`} onClick={() => releaseTransportAgreement(quote.id)}>
                                        {busy === `quote-${quote.id}` ? 'Releasing…' : 'Transporter unavailable — choose another'}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="muted">Waiting for registered truck owners to submit quotes.</p>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {transportJob.status === 'DELIVERED' && (
                  <section className="card-block">
                    <div className="card-block-title"><h3>Delivery</h3></div>
                    <div className="card-block-body">
                      <div className="notice">
                        <p><strong>✓ Transport marked as delivered.</strong></p>
                        {transportJob.deliveredConfirmedAt && <p className="muted">Delivery confirmed.</p>}
                      </div>
                    </div>
                  </section>
                )}

                {transportJob.incidentNotes && (
                  <div className="alert">
                    <strong>Transport notes:</strong> {transportJob.incidentNotes}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {order && (
          <PayoutStatusCard
            sellerPayout={sellerPayout}
            inspectorPayout={inspectorPayout}
            transporterPayout={transporterPayout}
            sellerName={order.seller?.name || null}
            inspectorName={
              (order.inspectionRequests || inspectionRequests).find((r) => r?.inspector?.name)?.inspector?.name || null
            }
            transporterName={transportJob?.truckOwner?.name || null}
            isSeller={isSeller}
            isInspector={isInspector}
            isTransporter={isTransporter}
            formatDateTime={formatDateTime}
          />
        )}

        {order && (
          <RefundStatusCard
            refunds={refunds}
            payouts={payouts}
            people={{
              SELLER: { name: order.seller?.name || null, you: isSeller },
              INSPECTOR: {
                name: (order.inspectionRequests || inspectionRequests).find((r) => r?.inspector?.name)?.inspector?.name || null,
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

        {order && isProductsMarketplace && isBuyer && !order.agreedOfferId && (
          <section className="card order-product-offer-card" id="make-offer">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">PRODUCT MARKETPLACE</span>
                <h2>Make Offer</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>How it works</h3></div>
                <div className="card-block-body">
                  <p className="muted">
                    Enter the amount you want to offer for this product. Your offer enters the seller's competition process; it does not charge you or reserve the product.
                  </p>
                </div>
              </section>
              <section className="card-block">
                <div className="card-block-title"><h3>Your offer</h3></div>
                <div className="card-block-body">
                  <form onSubmit={submitProductOffer} className="order-product-offer-form">
                    <label htmlFor="order-product-offer-amount">Offer amount (ETB)</label>
                    <input id="order-product-offer-amount" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Enter your offer amount (ETB)" value={offerAmount} onChange={(event) => setOfferAmount(event.target.value)} disabled={submittingOffer} required />
                    <label htmlFor="order-product-offer-message">Message to seller <span>(optional)</span></label>
                    <textarea id="order-product-offer-message" rows="3" placeholder="Add a message to the seller" value={offerMessage} onChange={(event) => setOfferMessage(event.target.value)} disabled={submittingOffer} />
                    <button type="submit" className="btn btn-primary order-product-offer-button" disabled={submittingOffer}>
                      {submittingOffer ? 'Submitting…' : 'Make Offer'}
                    </button>
                  </form>
                </div>
              </section>
            </div>
          </section>
        )}

        {(!isProductsMarketplace || order?.agreedOfferId) && (
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
        )}

        {order.status === 'DELIVERED' && isBuyer && (
          <div className="card" id="confirm-receipt">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">RECEIPT</span>
                <h2>Confirm receipt</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>Before you confirm</h3></div>
                <div className="card-block-body">
                  <p className="muted">Confirm only after you have physically received the produce/product.</p>
                  {!marketplacePaid && (
                    <div className="alert error">Marketplace payment must be confirmed before receipt can be completed.</div>
                  )}
                  {transportJob?.method === 'HIRE_TRANSPORTER' && !transportPaid && (
                    <div className="alert error">Transport payment must be confirmed before receipt can be completed.</div>
                  )}
                </div>
              </section>
              <div className="sd-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy === 'receipt' || !marketplacePaid || (transportJob?.method === 'HIRE_TRANSPORTER' && !transportPaid)}
                  onClick={confirmReceipt}
                >
                  {busy === 'receipt' ? 'Confirming…' : 'Confirm receipt & complete order'}
                </button>
              </div>
            </div>
          </div>
        )}

        {order.status === 'DISPUTED' ? (
          <div className="card card-warning" id="raise-dispute">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">DISPUTE</span>
                <h2>Dispute open</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>Under review</h3></div>
                <div className="card-block-body">
                  <p className="muted">
                    An admin is reviewing this order. <strong>Payments, transport, inspection and payouts are paused</strong> while the dispute is open. The order will either resume its previous state or be cancelled and refunded after review.
                  </p>
                </div>
              </section>
            </div>
          </div>
        ) : (
          canRaiseDispute && (
            <div className="card" id="raise-dispute">
              <header className="card-head">
                <div className="card-head-text">
                  <span className="eyebrow">SUPPORT</span>
                  <h2>Raise a dispute</h2>
                </div>
              </header>
              <div className="card-body">
                <section className="card-block">
                  <div className="card-block-title"><h3>When to use this</h3></div>
                  <div className="card-block-body">
                    <p className="muted">Use this if something went wrong with this order — for example goods not delivered, quality issues, or a payment problem. An admin will review it.</p>
                  </div>
                </section>
                {disputeSubmitted ? (
                  <div className="alert success">Dispute submitted. The order is now marked as disputed while an admin reviews it.</div>
                ) : (
                  <section className="card-block">
                    <div className="card-block-title"><h3>Dispute details</h3></div>
                    <div className="card-block-body">
                      <form onSubmit={raiseDispute}>
                        <label>
                          Dispute against
                          <select value={disputeAgainstId} onChange={(e) => setDisputeAgainstId(e.target.value)} required>
                            <option value="">Select who this is about…</option>
                            {disputeCounterparties.map((party) => (
                              <option key={party.id} value={party.id}>{party.name} ({party.role})</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Type
                          <select value={disputeType} onChange={(e) => setDisputeType(e.target.value)}>
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
                          <textarea value={disputeDescription} onChange={(e) => setDisputeDescription(e.target.value)} rows={4} placeholder="Describe the issue in detail" required />
                        </label>
                        <button type="submit" className="btn btn-outline" disabled={submittingDispute}>
                          {submittingDispute ? 'Submitting…' : 'Raise dispute'}
                        </button>
                      </form>
                    </div>
                  </section>
                )}
              </div>
            </div>
          )
        )}

        {order.status === 'COMPLETED' && (
          <div className="card">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">FINAL</span>
                <h2>Order completed</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>Summary</h3></div>
                <div className="card-block-body">
                  <div className="notice">
                    <p><strong>✓ This order has been completed.</strong></p>
                    <p className="muted">Receipt was confirmed by the buyer.</p>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        <RatingBox
          order={order}
          userId={currentUserId}
          onRated={() => load({ silent: true })}
        />

        {counterpartId && (
          <MessageThread
            orderId={order.id}
            messages={order.messages || []}
            counterpartId={counterpartId}
            counterpartName={counterpartName}
            currentUserId={currentUserId}
            onSent={() => load({ silent: true })}
          />
        )}

        {isAdmin && (
          <div className="card">
            <header className="card-head">
              <div className="card-head-text">
                <span className="eyebrow">ADMIN</span>
                <h2>Administrator view</h2>
              </div>
            </header>
            <div className="card-body">
              <section className="card-block">
                <div className="card-block-title"><h3>Access level</h3></div>
                <div className="card-block-body">
                  <p className="muted">You are viewing this order with administrator access.</p>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>

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
