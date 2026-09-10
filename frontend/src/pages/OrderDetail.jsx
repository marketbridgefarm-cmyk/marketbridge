import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import api from '../api/client';
import {
  startChapaPayment,
  chapaInitializeAndRedirect,
} from '../utils/chapaCheckout';

import { useAuth } from '../context/AuthContext.jsx';
import RatingBox from '../components/RatingBox.jsx';
import MessageThread from '../components/MessageThread.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';

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
    value: 'CBE',
    label: 'CBE via Chapa',
  },
  {
    value: 'QR',
    label: 'QR Code',
  },
];

export default function OrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [payMethod, setPayMethod] = useState('TELEBIRR');

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
        const response = await api.get(`/orders/${orderId}`);

        setOrder(response.data?.order || null);
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

  useEffect(() => {
    if (order && window.location.hash === '#payments') {
      window.setTimeout(() => {
        document.getElementById('payments')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 50);
    }
  }, [order]);

  // ==========================================================================
  // DERIVED DATA
  // ==========================================================================

  const transportJob = order?.transportJob || null;
  const payments = Array.isArray(order?.payments)
    ? order.payments
    : [];

  const isAdmin = Boolean(
    user?.roles?.includes('ADMIN')
  );

  const isBuyer = Boolean(
    order &&
    user?.id === order.buyerId
  );

  const isSeller = Boolean(
    order &&
    user?.id === order.sellerId
  );

  const isParticipant = isBuyer || isSeller;

  const isAgricultural =
    order?.listing?.category === 'AGRICULTURAL';

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

  const inspectionRequests = (Array.isArray(
    order?.listing?.inspectionRequests
  ) ? order.listing.inspectionRequests : [])
    .filter((request) => request.status !== 'CANCELLED');

  const inspectionPaymentRequest = inspectionRequests.find(
    (request) => {
      const paid = (request.payments || []).some(
        (payment) => payment.type === 'INSPECTOR' && payment.status === 'PAID'
      );
      return !paid && request.fee != null;
    }
  ) || null;

  const inspectionRequired = inspectionRequests.length > 0;
  const inspectionPayment = inspectionPaymentRequest
    ? (inspectionPaymentRequest.payments || []).find(
        (payment) =>
          payment.type === 'INSPECTOR' &&
          ['PENDING', 'PAID'].includes(payment.status)
      ) || null
    : null;

  const inspectionPaymentPaid = inspectionPaid;
  const inspectionPaymentPending = Boolean(
    inspectionPayment && inspectionPayment.status === 'PENDING'
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
      marketplacePayments.find(
        (payment) =>
          payment.status === 'PENDING'
      ) ||
      marketplacePayments.find(
        (payment) =>
          payment.status === 'PAID'
      ) ||
      null
    );
  }, [marketplacePayments]);

  const transportPayment = useMemo(() => {
    return (
      transportPayments.find(
        (payment) =>
          payment.status === 'PENDING'
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
    marketplacePayments.some(
      (payment) =>
        payment.status === 'PENDING'
    );

  const transportPaid =
    transportPayments.some(
      (payment) =>
        payment.status === 'PAID'
    );

  const transportPending =
    transportPayments.some(
      (payment) =>
        payment.status === 'PENDING'
    );

  // ==========================================================================
  // TRANSPORT PERMISSIONS
  // ==========================================================================

  /* Seller, buyer, or joint may arrange transport. The backend enforces
   * that the selected arranging party is actually an order participant. */
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
    isParticipant &&
    ['REQUESTED', 'QUOTED'].includes(
      transportJob.status
    ) &&
    !transportJob.truckOwnerId;

  /*
   * Transport payment is ONLY for hired transport.
   *
   * OWN_TRUCK does not create a separate transport payment.
   *
   * Marketplace payment must already be PAID before the
   * transport payment can be started.
   */
  /* Hired transport is paid by the buyer. The seller may arrange/select
   * the transporter, but the buyer is the customer paying the transporter. */
  const canPayTransport =
    Boolean(transportJob) &&
    transportJob.method === 'HIRE_TRANSPORTER' &&
    Boolean(transportJob.truckOwnerId) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    isBuyer &&
    !transportPayments.some(
      (payment) => ['PENDING', 'PAID'].includes(payment.status)
    );

  const canResumeTransportPayment =
    Boolean(transportPayment) &&
    transportPayment.status === 'PENDING' &&
    isBuyer;

  // ==========================================================================
  // MARKETPLACE PAYMENT PERMISSIONS
  // ==========================================================================

  /* Marketplace payment is independent from transport. For an agricultural
   * order with an inspection request, the inspection fee must be paid first. */
  const agriculturalGateMet =
    !isAgricultural ||
    !inspectionRequired ||
    inspectionPaid;

  const canPayMarketplace =
    Boolean(order) &&
    order.status === 'PENDING_PAYMENT' &&
    isBuyer &&
    agriculturalGateMet &&
    !marketplacePayments.some(
      (payment) =>
        payment.status === 'PENDING' ||
        payment.status === 'PAID'
    );

  /*
   * Explains why the marketplace payment button is hidden when the
   * agricultural gate hasn't been met yet, so buyers aren't left
   * looking for a button that doesn't exist.
   */
  const marketplaceBlockedReason =
    isAgricultural && isBuyer && !agriculturalGateMet
      ? 'Pay the required inspection fee before paying for the agricultural produce.'
      : null;

  /*
   * Resume an already-created pending marketplace payment.
   */
  const canResumeMarketplacePayment =
    Boolean(marketplacePayment) &&
    marketplacePayment.status === 'PENDING' &&
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
      await api.patch(
        `/transport/quotes/${quoteId}`,
        {
          action: 'ACCEPT',
        }
      );

      await load({ silent: true });
      window.history.replaceState(null, '', `${window.location.pathname}#payments`);
      window.setTimeout(() => {
        document.getElementById('payments')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 100);
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

  // ==========================================================================
  // START INSPECTION PAYMENT
  // ==========================================================================

  const payInspection = async () => {
    if (!inspectionPaymentRequest) return;

    if (!isBuyer) {
      setError('Only the buyer can pay the inspection fee');
      return;
    }

    const amount = Number(inspectionPaymentRequest.fee);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Invalid inspection payment amount');
      return;
    }

    setBusy('pay-inspection');
    setError('');

    try {
      await startChapaPayment({
        type: 'INSPECTOR',
        inspectionRequestId: inspectionPaymentRequest.id,
        amount,
        method: payMethod,
      });
    } catch (err) {
      setError(getError(err, 'Could not start inspection payment'));
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
  // START TRANSPORT PAYMENT
  // ==========================================================================

  const payTransport = async () => {
    if (!order || !transportJob) return;

    if (!isBuyer) {
      setError('Only the buyer can pay the hired transport fee');
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
  // LOADING
  // ==========================================================================

  if (loading) {
    return (
      <main className="section">
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
      <main className="section">
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
    <main className="section">
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

        {error && (
          <div className="alert error">
            {error}
          </div>
        )}

        <div className="page-header compact-header">
          <div>
            <span className="eyebrow">
              ORDER {shortId(order.id)}
            </span>

            <h1>{title}</h1>

            <p>
              <span className="badge">
                {order.status}
              </span>
              {' · '}
              {money(order.finalPrice)} ETB
            </p>
          </div>
        </div>

        {/* ================================================================== */}
        {/* ORDER DETAILS */}
        {/* ================================================================== */}

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

        {/* ================================================================== */}
        {/* PARTIES */}
        {/* ================================================================== */}

        <div className="card">
          <h2>Parties</h2>

          <div className="detail-facts">
            <div>
              <span>Buyer</span>
              <strong>
                {order.buyer?.name || '—'}
              </strong>
            </div>

            <div>
              <span>Seller</span>
              <strong>
                {order.seller?.name || '—'}
              </strong>
            </div>
          </div>
        </div>

        {/* ================================================================== */}
        {/* PAYMENT CENTER */}
        {/* ================================================================== */}

        <div className="card" id="payments">
          <h2>Payments</h2>
          <p className="muted">
            After a transport quote is accepted, complete every required payment below.
            The transporter cannot start the trip until the backend confirms all required payments.
          </p>

          <div className="detail-facts">
            <div>
              <span>Seller / produce</span>
              <strong>{marketplacePaid ? 'PAID ✓' : marketplacePending ? 'PAYMENT PENDING' : 'PAYMENT REQUIRED'}</strong>
            </div>

            <div>
              <span>Inspector</span>
              <strong>
                {!inspectionRequired
                  ? 'NOT REQUIRED'
                  : inspectionPaymentPaid
                    ? 'PAID ✓'
                    : inspectionPaymentPending
                      ? 'PAYMENT PENDING'
                      : 'PAYMENT REQUIRED'}
              </strong>
            </div>

            {transportJob?.method === 'HIRE_TRANSPORTER' && (
              <div>
                <span>Transporter</span>
                <strong>{transportPaid ? 'PAID ✓' : transportPending ? 'PAYMENT PENDING' : 'PAYMENT REQUIRED'}</strong>
              </div>
            )}

            <div>
              <span>MarketBridge</span>
              <strong>Recorded in payment ledger</strong>
            </div>
          </div>

          {isBuyer && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
              {inspectionRequired && !inspectionPaymentPaid && inspectionPaymentRequest && (
                inspectionPaymentPending ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'resume-inspection'}
                    onClick={() => resumePayment(inspectionPayment.id, 'resume-inspection')}
                  >
                    {busy === 'resume-inspection' ? 'Redirecting…' : 'Resume inspector payment'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'pay-inspection'}
                    onClick={payInspection}
                  >
                    {busy === 'pay-inspection' ? 'Submitting…' : 'Pay inspector now'}
                  </button>
                )
              )}

              {!marketplacePaid && (
                canResumeMarketplacePayment ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'resume-marketplace'}
                    onClick={() => resumePayment(marketplacePayment.id, 'resume-marketplace')}
                  >
                    {busy === 'resume-marketplace' ? 'Redirecting…' : 'Resume seller payment'}
                  </button>
                ) : canPayMarketplace ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'pay-marketplace'}
                    onClick={payMarketplace}
                  >
                    {busy === 'pay-marketplace' ? 'Submitting…' : 'Pay seller now'}
                  </button>
                ) : null
              )}

              {transportJob?.method === 'HIRE_TRANSPORTER' && !transportPaid && (
                canResumeTransportPayment ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'resume-transport'}
                    onClick={() => resumePayment(transportPayment.id, 'resume-transport')}
                  >
                    {busy === 'resume-transport' ? 'Redirecting…' : 'Resume transporter payment'}
                  </button>
                ) : canPayTransport ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'pay-transport'}
                    onClick={payTransport}
                  >
                    {busy === 'pay-transport' ? 'Submitting…' : 'Pay transporter now'}
                  </button>
                ) : null
              )}
            </div>
          )}

          {transportJob?.method === 'HIRE_TRANSPORTER' && !transportPaid && (
            <div className="notice" style={{ marginTop: 16 }}>
              <strong>Transport start rule:</strong> marketplace/seller payment, required inspector payment, and transporter payment must all be confirmed PAID before IN_TRANSIT is allowed.
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* TRANSPORT */}
        {/* ================================================================== */}

        <div className="card">
          <div className="row-between">
            <div>
              <h2>Transport</h2>

              <p className="muted">
                The buyer or seller arranges
                transport. MarketBridge does not
                automatically assign a transporter.
              </p>
            </div>

            {canArrangeTransport && (
              <Link
                className="btn btn-primary"
                to={`/orders/${order.id}/transport`}
              >
                Arrange transport
              </Link>
            )}
          </div>

          {!transportJob ? (
            <div className="notice">
              <p>
                No transport arrangement recorded
                yet.
              </p>

              {isParticipant &&
                order.status ===
                  'PENDING_PAYMENT' && (
                  <p className="muted">
                    You may arrange transport while
                    the order is awaiting payment.
                  </p>
                )}
            </div>
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
                <EvidenceGallery
                  listUrl={`/transport/${transportJob.id}/evidence`}
                  mediaUrl={(evidenceId) => `/transport/${transportJob.id}/evidence/${evidenceId}/media`}
                />
              </div>

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

                    {transportJob.quotes
                      ?.length ? (
                      transportJob.quotes.map(
                        (quote) => (
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
                            </div>

                            <div>
                              <strong>
                                {money(
                                  quote.amount
                                )}{' '}
                                ETB
                              </strong>

                              {canChooseQuote &&
                                quote.status ===
                                  'PENDING' && (
                                  <div
                                    style={{
                                      marginTop: 8,
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
                                  </div>
                                )}
                            </div>
                          </div>
                        )
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
        {/* CONFIRM RECEIPT */}
        {/* ================================================================== */}

        {order.status === 'DELIVERED' &&
          isBuyer && (
            <div className="card">
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

        {/* ================================================================== */}
        {/* PAYMENT RECORDS */}
        {/* ================================================================== */}

        <div className="card">
          <h2>
            Payment records
          </h2>

          {payments.length ? (
            <div>
              {payments.map((payment) => (
                <div
                  className="payment-row"
                  key={payment.id}
                >
                  <span>
                    <strong>
                      {payment.type}
                    </strong>
                  </span>

                  <strong>
                    {money(payment.amount)} ETB
                  </strong>

                  <span>
                    {payment.method || '—'}
                  </span>

                  <span className="badge">
                    {payment.status}
                  </span>

                  {payment.reference && (
                    <span className="muted">
                      Ref:{' '}
                      {shortId(
                        payment.reference
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">
              No payment records attached to this
              order yet.
            </p>
          )}
        </div>

        {/* ================================================================== */}
        {/* RATING */}
        {/* ================================================================== */}

        <RatingBox
          order={order}
          userId={user?.id}
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
            currentUserId={user?.id}
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
    </main>
  );
}
