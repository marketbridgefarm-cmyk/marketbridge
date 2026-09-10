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

  const inspectionRequests = useMemo(
    () =>
      (order?.listing?.inspectionRequests || []).filter(
        (request) => request.status !== 'CANCELLED'
      ),
    [order?.listing?.inspectionRequests]
  );

  const assignedInspection = useMemo(
    () =>
      inspectionRequests.find(
        (request) => request.inspectorId === user?.id
      ) || null,
    [inspectionRequests, user?.id]
  );

  const isInspector = Boolean(assignedInspection);
  const isTransporter = Boolean(
    transportJob?.truckOwnerId &&
    transportJob.truckOwnerId === user?.id
  );

  const inspectionPaymentRows = useMemo(
    () =>
      inspectionRequests.filter(
        (request) =>
          request.fee != null &&
          Number(request.fee) > 0
      ),
    [inspectionRequests]
  );

  const inspectionPaymentsComplete = inspectionPaymentRows.every(
    (request) =>
      (request.payments || []).some(
        (payment) =>
          payment.type === 'INSPECTOR' &&
          payment.status === 'PAID'
      )
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
   * PAID before the transporter can enter IN_TRANSIT.
   */
  const canPayTransport =
    Boolean(transportJob) &&
    transportJob.method ===
      'HIRE_TRANSPORTER' &&
    Boolean(transportJob.truckOwnerId) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    !transportPayments.some(
      (payment) =>
        payment.status === 'PENDING' ||
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

  // ==========================================================================
  // MARKETPLACE PAYMENT PERMISSIONS
  // ==========================================================================

  /*
   * Marketplace payment can only be initiated by the buyer.
   *
   * Agricultural marketplace payment is independent from transport.
   * Required payments are separately tracked and the transport state machine
   * prevents IN_TRANSIT until all required payments are PAID.
   */
  // Agricultural purchase payment is intentionally independent from transport
  // and inspection payment. The hard sequencing rule is enforced when the
  // transporter attempts IN_TRANSIT, not by hiding the buyer's payment button.
  const agriculturalGateMet = true;

  const canPayMarketplace =
    Boolean(order) &&
    order.status !== 'COMPLETED' &&
    order.status !== 'CANCELLED' &&
    isBuyer &&
    !marketplacePayments.some(
      (payment) =>
        payment.status === 'PENDING' ||
        payment.status === 'PAID'
    );

  const marketplaceBlockedReason = null;

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
        {/* NEXT ACTION CENTER */}
        {/* ================================================================== */}

        <div className="card next-action-card" id="next-action">
          <div className="row-between">
            <div>
              <span className="eyebrow">NEXT STEP</span>
              <h2 style={{ marginBottom: 6 }}>What happens next?</h2>
              <p className="muted">The next action is assigned to the party responsible for it. Payment, inspection, transport movement and receipt are separate steps.</p>
            </div>
          </div>

          {isBuyer && (
            <div className="next-action-panel">
              <strong>Buyer action</strong>
              {order.status === 'PENDING_PAYMENT' && !marketplacePaid ? (
                <p>Pay the seller for the agreed order amount.</p>
              ) : transportJob?.status === 'ACCEPTED' && (
                !marketplacePaid || !transportPaid || !inspectionPaymentsComplete
              ) ? (
                <p>Complete the remaining required payments before the transporter can start.</p>
              ) : transportJob?.status === 'DELIVERED' ? (
                <p>The produce has been delivered. Confirm physical receipt to complete the order.</p>
              ) : transportJob?.status === 'IN_TRANSIT' ? (
                <p>Transport is in progress. Wait for delivery confirmation.</p>
              ) : transportJob?.status === 'PICKUP' ? (
                <p>Pickup is confirmed. The transporter will start the trip after all required payments are complete.</p>
              ) : transportJob?.status === 'ACCEPTED' ? (
                <p>Transporter selected. Continue with the payment center below.</p>
              ) : !transportJob ? (
                <p>Choose who will arrange transport.</p>
              ) : (
                <p>Monitor the order and continue from the payment or transport section below.</p>
              )}

              <div className="next-action-buttons">
                {isBuyer && !marketplacePaid && (
                  canResumeMarketplacePayment ? (
                    <button type="button" className="btn btn-primary" onClick={() => scrollToSection('payment-center')}>Resume seller/order payment</button>
                  ) : canPayMarketplace ? (
                    <button type="button" className="btn btn-primary" onClick={() => scrollToSection('payment-center')}>Pay seller / order now</button>
                  ) : null
                )}
                {isBuyer && transportJob?.status === 'ACCEPTED' && transportJob.method === 'HIRE_TRANSPORTER' && !transportPaid && (
                  <button type="button" className="btn btn-primary" onClick={() => scrollToSection('payment-center')}>Pay transporter now</button>
                )}
                {isBuyer && transportJob?.status === 'ACCEPTED' && (!marketplacePaid || !transportPaid || !inspectionPaymentsComplete) && (
                  <button type="button" className="btn btn-outline" onClick={() => scrollToSection('payment-center')}>Open payment center</button>
                )}
                {!transportJob && isParticipant && (
                  <Link className="btn btn-primary" to={`/orders/${order.id}/transport`}>Arrange transport</Link>
                )}
                {transportJob && (
                  <button type="button" className="btn btn-outline" onClick={() => scrollToSection('transport-section')}>Open transport steps</button>
                )}
                {transportJob?.status === 'DELIVERED' && (
                  <button type="button" className="btn btn-primary" onClick={() => scrollToSection('confirm-receipt')}>Confirm receipt</button>
                )}
              </div>
            </div>
          )}

          {isSeller && (
            <div className="next-action-panel">
              <strong>Seller action</strong>
              {isTransportArranger && transportJob && !transportJob.truckOwnerId && ['REQUESTED', 'QUOTED'].includes(transportJob.status) ? (
                <p>Choose one of the transporter's quotes to assign the transport job.</p>
              ) : !transportJob ? (
                <p>Arrange transport yourself or leave the transport arrangement to the buyer.</p>
              ) : transportJob.status === 'ACCEPTED' ? (
                <p>Transporter has been assigned. The buyer completes the required payments; the transporter then starts the trip.</p>
              ) : transportJob.status === 'PICKUP' ? (
                <p>Pickup is confirmed. Waiting for all required payments and transporter start.</p>
              ) : transportJob.status === 'IN_TRANSIT' ? (
                <p>Produce is in transit. Wait for delivery confirmation.</p>
              ) : transportJob.status === 'DELIVERED' ? (
                <p>Delivery is complete. The buyer must confirm receipt.</p>
              ) : (
                <p>Continue monitoring the order from the transport and payment sections.</p>
              )}
              <div className="next-action-buttons">
                {!transportJob && <Link className="btn btn-primary" to={`/orders/${order.id}/transport`}>Arrange transport</Link>}
                {transportJob && isTransportArranger && !transportJob.truckOwnerId && ['REQUESTED', 'QUOTED'].includes(transportJob.status) && <button type="button" className="btn btn-primary" onClick={() => scrollToSection('transport-section')}>Review transport quotes</button>}
                {transportJob && <button type="button" className="btn btn-outline" onClick={() => scrollToSection('transport-section')}>Open transport steps</button>}
              </div>
            </div>
          )}

          {isTransporter && (
            <div className="next-action-panel">
              <strong>Transporter action</strong>
              {transportJob.status === 'ACCEPTED' && <p>Confirm pickup with evidence when the load is physically collected.</p>}
              {transportJob.status === 'PICKUP' && <p>All required payments must be PAID. Then add pickup evidence and mark the trip IN_TRANSIT.</p>}
              {transportJob.status === 'IN_TRANSIT' && <p>Complete delivery and submit delivery evidence.</p>}
              {transportJob.status === 'DELIVERED' && <p>Trip complete. The buyer is now responsible for confirming receipt.</p>}
              <div className="next-action-buttons">
                <Link className="btn btn-primary" to="/dashboard/truck-owner">Open transport job dashboard</Link>
              </div>
            </div>
          )}

          {isInspector && (
            <div className="next-action-panel">
              <strong>Inspector action</strong>
              {assignedInspection.status === 'ACCEPTED' && <p>Start the accepted inspection.</p>}
              {assignedInspection.status === 'IN_PROGRESS' && <p>Complete the inspection and publish the evidence report.</p>}
              {assignedInspection.status === 'COMPLETED' && <p>Inspection report is published. The buyer can now complete any required inspection payment and continue the order.</p>}
              <div className="next-action-buttons">
                <Link className="btn btn-primary" to="/dashboard/inspector">Open inspection dashboard</Link>
              </div>
            </div>
          )}

          {isAdmin && (
            <div className="next-action-panel">
              <strong>Administrator</strong>
              <p>Review the order, payment ledger and transport state from the relevant operational dashboard.</p>
              <div className="next-action-buttons"><Link className="btn btn-outline" to="/dashboard/admin">Open admin dashboard</Link></div>
            </div>
          )}
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
        {/* MARKETPLACE PAYMENT BLOCKED (agricultural gate) */}
        {/* ================================================================== */}

        <div id="payment-center" />

        {marketplaceBlockedReason && (
          <div className="card">
            <h2>Payment</h2>
            <p className="muted">
              {marketplaceBlockedReason}
            </p>
          </div>
        )}

        {/* ================================================================== */}
        {/* INSPECTION PAYMENTS */}
        {/* ================================================================== */}

        {isAgricultural && (order.listing?.inspectionRequests || []).filter((r) => r.status !== 'CANCELLED' && r.fee != null && Number(r.fee) > 0).map((request) => {
          const requestPayment = (request.payments || []).find((p) => p.type === 'INSPECTOR' && p.status === 'PENDING') || (request.payments || []).find((p) => p.type === 'INSPECTOR' && p.status === 'PAID');
          const paid = requestPayment?.status === 'PAID';
          return (
            <div className="card" key={request.id}>
              <h2>Inspector payment</h2>
              <p className="muted">{request.inspector?.name ? `Inspector: ${request.inspector.name}` : 'Inspection service'}</p>
              <p>Amount: <strong>{money(request.fee)} ETB</strong></p>
              {paid ? <div className="notice"><strong>✓ Inspector payment confirmed.</strong></div> : requestPayment ? <button type="button" className="btn btn-primary" disabled={busy === `resume-inspection-${request.id}`} onClick={() => resumePayment(requestPayment.id, `resume-inspection-${request.id}`)}>{busy === `resume-inspection-${request.id}` ? 'Redirecting…' : 'Resume inspector payment'}</button> : isBuyer ? <button type="button" className="btn btn-primary" disabled={busy === `pay-inspection-${request.id}`} onClick={async () => { setBusy(`pay-inspection-${request.id}`); setError(''); try { await startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, orderId: order.id, amount: Number(request.fee), method: payMethod }); await load({ silent: true }); } catch (err) { setError(getError(err, 'Could not start inspector payment')); } finally { setBusy(''); } }}>{busy === `pay-inspection-${request.id}` ? 'Submitting…' : 'Pay inspector now'}</button> : <p className="muted">The buyer must complete this inspection payment.</p>}
            </div>
          );
        })}

        {/* ================================================================== */}
        {/* MARKETPLACE PAYMENT */}
        {/* ================================================================== */}

        {canPayMarketplace && (
          <div className="card">
            <h2>Payment</h2>

            <p className="muted">
              This order is awaiting payment before
              the seller can proceed.
            </p>

            <p>
              Amount due:{' '}
              <strong>
                {money(order.finalPrice)} ETB
              </strong>
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
                  'pay-marketplace'
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
                className="btn btn-primary"
                disabled={
                  busy ===
                  'pay-marketplace'
                }
                onClick={payMarketplace}
              >
                {busy ===
                'pay-marketplace'
                  ? 'Submitting…'
                  : 'Pay seller / order now'}
              </button>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* MARKETPLACE PAYMENT PENDING */}
        {/* ================================================================== */}

        {canResumeMarketplacePayment && (
          <div className="card">
            <h2>Payment</h2>

            <p className="muted">
              You started a payment for this
              order, but it has not completed yet.
            </p>

            <div className="notice">
              <p>
                Payment reference:{' '}
                <strong>
                  {shortId(
                    marketplacePayment.id
                  )}
                </strong>
              </p>

              <p>
                Amount:{' '}
                <strong>
                  {money(
                    marketplacePayment.amount
                  )}{' '}
                  ETB
                </strong>
              </p>

              <p>
                Method:{' '}
                <strong>
                  {marketplacePayment.method ||
                    '—'}
                </strong>
              </p>

              <p>
                Status:{' '}
                <span className="badge">
                  {marketplacePayment.status}
                </span>
              </p>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ===
                'resume-marketplace'
              }
              onClick={() =>
                resumePayment(
                  marketplacePayment.id,
                  'resume-marketplace'
                )
              }
            >
              {busy ===
              'resume-marketplace'
                ? 'Redirecting…'
                : 'Resume payment'}
            </button>
          </div>
        )}

        {/* ================================================================== */}
        {/* MARKETPLACE PAYMENT PAID */}
        {/* ================================================================== */}

        {marketplacePaid && (
          <div className="card">
            <h2>Marketplace payment</h2>

            <div className="notice">
              <p>
                <strong>
                  ✓ Marketplace payment confirmed.
                </strong>
              </p>

              <p className="muted">
                Paid amount:{' '}
                {money(
                  marketplacePayments.find(
                    (payment) =>
                      payment.status ===
                      'PAID'
                  )?.amount
                )}{' '}
                ETB
              </p>
            </div>
          </div>
        )}

        {marketplacePending &&
          !canResumeMarketplacePayment &&
          !marketplacePaid && (
            <div className="card">
              <h2>
                Marketplace payment
              </h2>

              <p className="muted">
                A marketplace payment is
                currently pending.
              </p>
            </div>
          )}

        {/* ================================================================== */}
        {/* PAYMENT CHECKLIST */}
        {/* ================================================================== */}

        {transportJob && (
          <div className="card">
            <h2>Payment center</h2>
            <p className="muted">Seller, inspector (if required), and hired transporter payments are tracked separately. All required payments must show PAID before the transporter can start the trip.</p>
            <div className="notice">
              <p>{marketplacePaid ? '✓' : '○'} Seller / marketplace payment — <strong>{marketplacePaid ? 'PAID' : 'NOT PAID'}</strong></p>
              {isAgricultural && (order.listing?.inspectionRequests || []).filter((r) => r.status !== 'CANCELLED' && r.fee != null && Number(r.fee) > 0).map((r) => {
                const paid = (r.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID');
                return <p key={r.id}>{paid ? '✓' : '○'} Inspector — <strong>{paid ? 'PAID' : 'NOT PAID'}</strong></p>;
              })}
              {transportJob.method === 'HIRE_TRANSPORTER' && <p>{transportPaid ? '✓' : '○'} Transporter — <strong>{transportPaid ? 'PAID' : 'NOT PAID'}</strong></p>}
              {transportJob.method === 'OWN_TRUCK' && <p>✓ Own truck — <strong>NO TRANSPORTER PAYMENT REQUIRED</strong></p>}
            </div>
            {transportJob.status === 'PICKUP' && (!marketplacePaid || !transportPaid || (isAgricultural && (order.listing?.inspectionRequests || []).some((r) => r.status !== 'CANCELLED' && r.fee != null && Number(r.fee) > 0 && !(r.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID')))) && (
              <div className="alert error" style={{ marginTop: 10 }}>Transport is waiting for payment. IN_TRANSIT is locked until every required payment is PAID.</div>
            )}
          </div>
        )}

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

              {canPayTransport && (
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
                    Pay the agreed transporter fee. This payment is independent from the seller and inspection payments. All required payments must be PAID before IN_TRANSIT.
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
