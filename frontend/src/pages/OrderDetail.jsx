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

const shortId = (id) => id?.slice(0, 8) || '—';

const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const getError = (error, fallback) =>
  error?.response?.data?.error ||
  error?.message ||
  fallback;

const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'CBE', label: 'CBE' },
  { value: 'QR', label: 'QR Code' },
  { value: 'OTHER', label: 'Other' },
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

  // --------------------------------------------------------------------------
  // LOAD ORDER
  // --------------------------------------------------------------------------

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
        setError(getError(err, 'Could not load order'));
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

  // --------------------------------------------------------------------------
  // DERIVED STATE
  // --------------------------------------------------------------------------

  const transportJob = order?.transportJob || null;
  const payments = order?.payments || [];

  const isAdmin = Boolean(user?.roles?.includes('ADMIN'));
  const isBuyer = Boolean(order && user?.id === order.buyerId);
  const isSeller = Boolean(order && user?.id === order.sellerId);
  const isParticipant = isBuyer || isSeller;

  const title =
    order?.listing?.title ||
    order?.listing?.cropType ||
    'Order';

  const marketplacePayments = useMemo(
    () =>
      payments.filter(
        (payment) => payment.type === 'MARKETPLACE'
      ),
    [payments]
  );

  const transportPayments = useMemo(
    () =>
      payments.filter(
        (payment) => payment.type === 'TRANSPORT'
      ),
    [payments]
  );

  const marketplacePayment =
    marketplacePayments.find(
      (payment) =>
        payment.status === 'PENDING' ||
        payment.status === 'PAID'
    ) || null;

  const transportPayment =
    transportPayments.find(
      (payment) =>
        payment.status === 'PENDING' ||
        payment.status === 'PAID'
    ) || null;

  const marketplacePaid = marketplacePayments.some(
    (payment) => payment.status === 'PAID'
  );

  const transportPaid = transportPayments.some(
    (payment) => payment.status === 'PAID'
  );

  const marketplacePending = marketplacePayments.some(
    (payment) => payment.status === 'PENDING'
  );

  const transportPending = transportPayments.some(
    (payment) => payment.status === 'PENDING'
  );

  // --------------------------------------------------------------------------
  // TRANSPORT PERMISSIONS
  // --------------------------------------------------------------------------

  const canArrangeTransport =
    Boolean(order) &&
    !transportJob &&
    order.status !== 'CANCELLED' &&
    isParticipant;

  const canChooseQuote =
    Boolean(transportJob) &&
    isParticipant &&
    ['REQUESTED', 'QUOTED'].includes(transportJob.status) &&
    !transportJob.truckOwnerId;

  const canPayTransport =
    Boolean(transportJob) &&
    transportJob.method === 'HIRE_TRANSPORTER' &&
    Boolean(transportJob.truckOwnerId) &&
    transportJob.agreedAmount != null &&
    !transportPayment &&
    isParticipant;

  const canResumeTransportPayment =
    Boolean(transportPayment) &&
    transportPayment.status === 'PENDING' &&
    isParticipant;

  // --------------------------------------------------------------------------
  // MARKETPLACE PAYMENT PERMISSIONS
  // --------------------------------------------------------------------------

  const canPayMarketplace =
    Boolean(order) &&
    order.status === 'PENDING_PAYMENT' &&
    isBuyer &&
    !marketplacePayment;

  const canResumeMarketplacePayment =
    Boolean(marketplacePayment) &&
    marketplacePayment.status === 'PENDING' &&
    isBuyer;

  // --------------------------------------------------------------------------
  // COUNTERPARTY
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // ACCEPT TRANSPORT QUOTE
  // --------------------------------------------------------------------------

  const acceptQuote = async (quoteId) => {
    if (!quoteId) return;

    setBusy(`quote-${quoteId}`);
    setError('');

    try {
      /*
       * Your current frontend uses:
       *
       * PATCH /transport/quotes/:quoteId/accept
       *
       * The backend you supplied also exposes:
       *
       * PATCH /transport/quotes/:quoteId
       * { action: 'ACCEPT' }
       *
       * Try the existing endpoint first so this remains compatible with
       * your current deployed frontend/backend setup.
       */
      try {
        await api.patch(`/transport/quotes/${quoteId}/accept`);
      } catch (firstError) {
        const status = firstError?.response?.status;

        /*
         * Only fall back when the endpoint itself is unavailable.
         * Do not hide normal authorization/validation errors.
         */
        if (status !== 404 && status !== 405) {
          throw firstError;
        }

        await api.patch(`/transport/quotes/${quoteId}`, {
          action: 'ACCEPT',
        });
      }

      await load({ silent: true });
    } catch (err) {
      setError(getError(err, 'Could not accept transport quote'));
    } finally {
      setBusy('');
    }
  };

  // --------------------------------------------------------------------------
  // START MARKETPLACE PAYMENT
  // --------------------------------------------------------------------------

  const payMarketplace = async () => {
    if (!order) return;

    setBusy('pay-marketplace');
    setError('');

    try {
      await startChapaPayment({
        type: 'MARKETPLACE',
        orderId: order.id,
        amount: Number(order.finalPrice),
        method: payMethod,
      });

      /*
       * Chapa normally redirects the user. If it does not, refresh the
       * order so any newly-created payment appears immediately.
       */
      await load({ silent: true });
    } catch (err) {
      setError(
        getError(err, 'Could not start marketplace payment')
      );
    } finally {
      setBusy('');
    }
  };

  // --------------------------------------------------------------------------
  // START TRANSPORT PAYMENT
  // --------------------------------------------------------------------------

  const payTransport = async () => {
    if (!order || !transportJob) return;

    setBusy('pay-transport');
    setError('');

    try {
      await startChapaPayment({
        type: 'TRANSPORT',
        orderId: order.id,
        amount: Number(transportJob.agreedAmount),
        method: payMethod,
      });

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(err, 'Could not start transport payment')
      );
    } finally {
      setBusy('');
    }
  };

  // --------------------------------------------------------------------------
  // RESUME PAYMENT
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // CONFIRM RECEIPT
  // --------------------------------------------------------------------------

  const confirmReceipt = async () => {
    if (!order) return;

    setBusy('receipt');
    setError('');

    try {
      await api.patch(
        `/orders/${order.id}/confirm-receipt`
      );

      await load({ silent: true });
    } catch (err) {
      setError(
        getError(err, 'Could not confirm receipt')
      );
    } finally {
      setBusy('');
    }
  };

  // --------------------------------------------------------------------------
  // LOADING
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // NOT FOUND / ERROR
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // RENDER
  // --------------------------------------------------------------------------

  return (
    <main className="section">
      <div className="container-narrow">

        {/* ================================================================ */}
        {/* HEADER */}
        {/* ================================================================ */}

        <div className="row-between" style={{ marginBottom: 16 }}>
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
            onClick={() => load({ silent: true })}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
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

        {/* ================================================================ */}
        {/* ORDER DETAILS */}
        {/* ================================================================ */}

        <div className="card">
          <h2>Order details</h2>

          <div className="detail-facts">
            <div>
              <span>Order</span>
              <strong>{shortId(order.id)}</strong>
            </div>

            <div>
              <span>Status</span>
              <strong>{order.status}</strong>
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
                <strong>{order.listing.cropType}</strong>
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

        {/* ================================================================ */}
        {/* MARKETPLACE PAYMENT */}
        {/* ================================================================ */}

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
                  setPayMethod(event.target.value)
                }
                disabled={busy === 'pay-marketplace'}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option
                    key={method.value}
                    value={method.value}
                  >
                    {method.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy === 'pay-marketplace'}
                onClick={payMarketplace}
              >
                {busy === 'pay-marketplace'
                  ? 'Submitting…'
                  : 'Pay for this order'}
              </button>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/* MARKETPLACE PAYMENT PENDING */}
        {/* ================================================================ */}

        {canResumeMarketplacePayment && (
          <div className="card">
            <h2>Payment</h2>

            <p className="muted">
              You started a payment for this order,
              but it has not completed yet.
            </p>

            <div className="notice">
              <p>
                Payment reference:{' '}
                <strong>
                  {shortId(marketplacePayment.id)}
                </strong>
              </p>

              <p>
                Amount:{' '}
                <strong>
                  {money(marketplacePayment.amount)} ETB
                </strong>
              </p>

              <p>
                Method:{' '}
                <strong>
                  {marketplacePayment.method || '—'}
                </strong>
              </p>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'resume-marketplace'}
              onClick={() =>
                resumePayment(
                  marketplacePayment.id,
                  'resume-marketplace'
                )
              }
            >
              {busy === 'resume-marketplace'
                ? 'Redirecting…'
                : 'Resume payment'}
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/* MARKETPLACE PAYMENT STATUS */}
        {/* ================================================================ */}

        {marketplacePaid && (
          <div className="card">
            <h2>Marketplace payment</h2>

            <div className="notice">
              <p>
                <strong>✓ Marketplace payment confirmed.</strong>
              </p>

              <p className="muted">
                Paid amount:{' '}
                {money(
                  marketplacePayments.find(
                    (payment) =>
                      payment.status === 'PAID'
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
              <h2>Marketplace payment</h2>

              <p className="muted">
                A marketplace payment is currently
                pending.
              </p>
            </div>
          )}

        {/* ================================================================ */}
        {/* TRANSPORT */}
        {/* ================================================================ */}

        <div className="card">
          <div className="row-between">
            <div>
              <h2>Transport</h2>

              <p className="muted">
                The buyer or seller arranges transport.
                MarketBridge does not automatically assign
                a transporter.
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
                No transport arrangement recorded yet.
              </p>

              {isParticipant &&
                order.status === 'PENDING_PAYMENT' && (
                  <p className="muted">
                    You may arrange transport while the
                    order is awaiting payment.
                  </p>
                )}
            </div>
          ) : (
            <>
              {/* ---------------------------------------------------------- */}
              {/* TRANSPORT SUMMARY */}
              {/* ---------------------------------------------------------- */}

              <div className="detail-facts">
                <div>
                  <span>Arranged by</span>
                  <strong>
                    {transportJob.arrangingParty || '—'}
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
                    {transportJob.pickupLocation || '—'}
                  </strong>
                </div>

                <div>
                  <span>Destination</span>
                  <strong>
                    {transportJob.destination || '—'}
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
              </div>

              {/* ---------------------------------------------------------- */}
              {/* ASSIGNED TRANSPORTER */}
              {/* ---------------------------------------------------------- */}

              {transportJob.truckOwner && (
                <div className="notice">
                  <h3>Transporter</h3>

                  <p>
                    <strong>
                      {transportJob.truckOwner.name ||
                        '—'}
                    </strong>
                  </p>

                  {transportJob.truckOwner.phone && (
                    <p className="muted">
                      Phone:{' '}
                      {transportJob.truckOwner.phone}
                    </p>
                  )}

                  {transportJob.truck && (
                    <p>
                      Truck:{' '}
                      <strong>
                        {transportJob.truck.registration ||
                          '—'}
                      </strong>
                      {' · '}
                      {transportJob.truck.truckType ||
                        'Truck'}
                      {transportJob.truck.capacity != null &&
                        ` · ${transportJob.truck.capacity}t`}
                    </p>
                  )}

                  {transportJob.agreedAmount != null && (
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

              {/* ---------------------------------------------------------- */}
              {/* TRANSPORT PAYMENT */}
              {/* ---------------------------------------------------------- */}

              {canPayTransport && (
                <div className="notice">
                  <h3>Transport payment</h3>

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
                    Marketplace payment must be
                    completed before transport payment
                    can be made.
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
                        setPayMethod(event.target.value)
                      }
                      disabled={busy === 'pay-transport'}
                    >
                      {PAYMENT_METHODS.map((method) => (
                        <option
                          key={method.value}
                          value={method.value}
                        >
                          {method.label}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={
                        busy === 'pay-transport'
                      }
                      onClick={payTransport}
                    >
                      {busy === 'pay-transport'
                        ? 'Submitting…'
                        : 'Pay for transport'}
                    </button>
                  </div>
                </div>
              )}

              {/* ---------------------------------------------------------- */}
              {/* RESUME TRANSPORT PAYMENT */}
              {/* ---------------------------------------------------------- */}

              {canResumeTransportPayment && (
                <div className="notice">
                  <h3>Transport payment pending</h3>

                  <p>
                    Amount:{' '}
                    <strong>
                      {money(
                        transportPayment.amount
                      )}{' '}
                      ETB
                    </strong>
                  </p>

                  <p className="muted">
                    The payment was started but has
                    not completed yet.
                  </p>

                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={
                      busy === 'resume-transport'
                    }
                    onClick={() =>
                      resumePayment(
                        transportPayment.id,
                        'resume-transport'
                      )
                    }
                  >
                    {busy === 'resume-transport'
                      ? 'Redirecting…'
                      : 'Resume payment'}
                  </button>
                </div>
              )}

              {/* ---------------------------------------------------------- */}
              {/* TRANSPORT PAID */}
              {/* ---------------------------------------------------------- */}

              {transportPaid && (
                <div className="notice">
                  <p>
                    <strong>
                      ✓ Transport payment confirmed.
                    </strong>
                  </p>
                </div>
              )}

              {/* ---------------------------------------------------------- */}
              {/* TRANSPORT QUOTES */}
              {/* ---------------------------------------------------------- */}

              {transportJob.method ===
                'HIRE_TRANSPORTER' &&
                !transportJob.truckOwnerId && (
                  <div className="match-box">
                    <h3>Transport quotes</h3>

                    {transportJob.quotes?.length ? (
                      transportJob.quotes.map((quote) => (
                        <div
                          className="transporter"
                          key={quote.id}
                        >
                          <div>
                            <strong>
                              {quote.truckOwner?.name ||
                                'Truck owner'}
                            </strong>

                            <p>
                              {quote.truck?.truckType ||
                                'Truck'}
                              {' · '}
                              {quote.truck?.capacity != null
                                ? `${quote.truck.capacity}t`
                                : 'Capacity —'}
                              {' · '}
                              {quote.truck
                                ?.registration ||
                                'Registration —'}
                              {' · '}
                              ★{' '}
                              {typeof quote.truckOwner
                                ?.rating === 'number'
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
                          </div>

                          <div>
                            <strong>
                              {money(quote.amount)} ETB
                            </strong>

                            {canChooseQuote && (
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
                      ))
                    ) : (
                      <p className="muted">
                        Waiting for registered truck
                        owners to submit quotes.
                      </p>
                    )}
                  </div>
                )}

              {/* ---------------------------------------------------------- */}
              {/* TRANSPORT STATUS INFORMATION */}
              {/* ---------------------------------------------------------- */}

              {transportJob.status === 'DELIVERED' && (
                <div className="notice">
                  <p>
                    <strong>
                      ✓ Transport marked as delivered.
                    </strong>
                  </p>

                  {transportJob.deliveredConfirmedAt && (
                    <p className="muted">
                      Delivery confirmed.
                    </p>
                  )}
                </div>
              )}

              {transportJob.incidentNotes && (
                <div className="alert">
                  <strong>Transport notes:</strong>{' '}
                  {transportJob.incidentNotes}
                </div>
              )}
            </>
          )}
        </div>

        {/* ================================================================ */}
        {/* CONFIRM RECEIPT */}
        {/* ================================================================ */}

        {order.status === 'DELIVERED' &&
          isBuyer && (
            <div className="card">
              <h2>Confirm receipt</h2>

              <p className="muted">
                Confirm only after you have physically
                received the produce/product.
              </p>

              {!marketplacePaid && (
                <div className="alert error">
                  Marketplace payment must be confirmed
                  before receipt can be completed.
                </div>
              )}

              {transportJob?.method ===
                'HIRE_TRANSPORTER' &&
                !transportPaid && (
                  <div className="alert error">
                    Transport payment must be confirmed
                    before receipt can be completed.
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

        {/* ================================================================ */}
        {/* COMPLETED */}
        {/* ================================================================ */}

        {order.status === 'COMPLETED' && (
          <div className="card">
            <h2>Order completed</h2>

            <div className="notice">
              <p>
                <strong>
                  ✓ This order has been completed.
                </strong>
              </p>

              <p className="muted">
                Receipt was confirmed by the buyer.
              </p>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/* PAYMENT RECORDS */}
        {/* ================================================================ */}

        <div className="card">
          <h2>Payment records</h2>

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

        {/* ================================================================ */}
        {/* RATING */}
        {/* ================================================================ */}

        <RatingBox
          order={order}
          userId={user?.id}
          onRated={() => load({ silent: true })}
        />

        {/* ================================================================ */}
        {/* MESSAGES */}
        {/* ================================================================ */}

        {counterpartId && (
          <MessageThread
            orderId={order.id}
            messages={order.messages || []}
            counterpartId={counterpartId}
            counterpartName={counterpartName}
            currentUserId={user?.id}
            onSent={() => load({ silent: true })}
          />
        )}

        {/* ================================================================ */}
        {/* ADMIN INDICATOR */}
        {/* ================================================================ */}

        {isAdmin && (
          <div className="card">
            <p className="muted">
              You are viewing this order with administrator
              access.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
