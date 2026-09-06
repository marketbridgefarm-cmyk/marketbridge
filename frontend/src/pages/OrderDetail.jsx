import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const shortId = (value) =>
  value ? value.slice(0, 8).toUpperCase() : '—';

const isPaid = (payment) =>
  payment?.status === 'PAID';

const getPayment = (payments, type) =>
  payments?.find(
    (payment) =>
      payment.type === type &&
      payment.status === 'PAID'
  );

const statusLabel = (status) =>
  String(status || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function StatusBadge({ status }) {
  return (
    <span className={`badge status-${String(status || '').toLowerCase()}`}>
      {statusLabel(status)}
    </span>
  );
}

function PaymentState({ payment, label }) {
  if (!payment) {
    return (
      <div className="payment-state">
        <span>{label}</span>
        <StatusBadge status="PENDING" />
      </div>
    );
  }

  return (
    <div className="payment-state">
      <span>{label}</span>
      <StatusBadge status={payment.status} />
    </div>
  );
}

export default function OrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');

    try {
      const response = await api.get(`/orders/${orderId}`);
      setOrder(response.data.order);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not load this order.'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [orderId]);

  async function acceptQuote(quoteId) {
    setBusy(quoteId);
    setError('');

    try {
      await api.patch(`/transport/quotes/${quoteId}/accept`);
      await load();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not accept the transport quote.'
      );
    } finally {
      setBusy('');
    }
  }

  async function confirmReceipt() {
    setBusy('receipt');
    setError('');

    try {
      await api.patch(`/orders/${orderId}/confirm-receipt`);
      await load();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not confirm receipt.'
      );
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return (
      <main className="section">
        <div className="container-narrow loading">
          Loading order…
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="section">
        <div className="container-narrow">
          {error && (
            <div className="alert error">
              {error}
            </div>
          )}

          <button
            className="back-link"
            type="button"
            onClick={() => navigate(-1)}
          >
            ← Back
          </button>
        </div>
      </main>
    );
  }

  const transport = order.transportJob;
  const payments = order.payments || [];

  const marketplacePayment = getPayment(
    payments,
    'MARKETPLACE'
  );

  const transportPayment = getPayment(
    payments,
    'TRANSPORT'
  );

  const isMarketplacePaid = isPaid(
    marketplacePayment
  );

  const isTransportPaid =
    transport?.method === 'HIRE_TRANSPORTER' &&
    isPaid(transportPayment);

  const requiresTransportPayment =
    transport?.method === 'HIRE_TRANSPORTER';

  const acceptedTransportAmount =
    transport?.agreedAmount != null
      ? Number(transport.agreedAmount)
      : null;

  const transportPaymentAmount =
    transportPayment?.amount != null
      ? Number(transportPayment.amount)
      : null;

  const transportAmountMatches =
    !requiresTransportPayment ||
    (acceptedTransportAmount != null &&
      transportPaymentAmount != null &&
      Math.abs(
        acceptedTransportAmount -
          transportPaymentAmount
      ) < 0.01);

  const canChooseQuote =
    transport &&
    ['BUYER', 'SELLER'].some((role) =>
      user?.roles?.includes(role)
    ) &&
    (order.buyerId === user?.id ||
      order.sellerId === user?.id) &&
    ['REQUESTED', 'QUOTED'].includes(
      transport.status
    ) &&
    !transport.truckOwnerId;

  const canArrangeTransport =
    !transport &&
    order.status !== 'CANCELLED' &&
    order.status !== 'COMPLETED';

  const canConfirmReceipt =
    order.status === 'DELIVERED' &&
    order.buyerId === user?.id &&
    isMarketplacePaid &&
    (!requiresTransportPayment ||
      (isTransportPaid &&
        transportAmountMatches));

  const receiptBlockedReason =
    order.status !== 'DELIVERED'
      ? `Receipt can be confirmed after delivery. Current order status: ${statusLabel(
          order.status
        )}.`
      : !isMarketplacePaid
      ? 'Marketplace payment must be confirmed before receipt can be completed.'
      : requiresTransportPayment &&
        !isTransportPaid
      ? 'Transport payment must be confirmed before receipt can be completed.'
      : requiresTransportPayment &&
        !transportAmountMatches
      ? 'The transport payment amount does not match the accepted transport fee.'
      : '';

  const title =
    order.listing?.title ||
    order.listing?.cropType ||
    'Order';

  const quoteList = transport?.quotes || [];

  const orderProgress = useMemo(() => {
    const statuses = [
      'PENDING_PAYMENT',
      'CONFIRMED',
      'TRANSPORT_ARRANGED',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
    ];

    const currentIndex =
      statuses.indexOf(order.status);

    return statuses.map((status, index) => ({
      status,
      completed:
        currentIndex >= 0 &&
        index <= currentIndex,
      current:
        currentIndex >= 0 &&
        index === currentIndex,
    }));
  }, [order.status]);

  return (
    <main className="section">
      <div className="container-narrow">
        <button
          className="back-link"
          type="button"
          onClick={() => navigate(-1)}
        >
          ← Back
        </button>

        {error && (
          <div
            className="alert error"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Header */}
        <div className="page-header compact-header">
          <div>
            <span className="eyebrow">
              ORDER {shortId(order.id)}
            </span>

            <h1>{title}</h1>

            <p>
              <StatusBadge status={order.status} />{' '}
              · {money(order.finalPrice)} ETB
            </p>
          </div>
        </div>

        {/* Order lifecycle */}
        <div className="card">
          <h2>Order progress</h2>

          <div className="order-progress">
            {orderProgress.map((step) => (
              <div
                key={step.status}
                className={`progress-step ${
                  step.completed ? 'completed' : ''
                } ${
                  step.current ? 'current' : ''
                }`}
              >
                <div className="progress-dot">
                  {step.completed ? '✓' : ''}
                </div>

                <span>
                  {statusLabel(step.status)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Parties */}
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

            <div>
              <span>Order amount</span>
              <strong>
                {money(order.finalPrice)} ETB
              </strong>
            </div>

            {order.quantity != null && (
              <div>
                <span>Quantity</span>
                <strong>
                  {order.quantity}
                  {order.unit
                    ? ` ${order.unit}`
                    : ''}
                </strong>
              </div>
            )}
          </div>
        </div>

        {/* Payment requirements */}
        <div className="card">
          <div className="row-between">
            <div>
              <h2>Payment status</h2>
              <p className="muted">
                Transport cannot progress until
                the required payment has been
                verified by the backend.
              </p>
            </div>

            {order.status ===
              'PENDING_PAYMENT' && (
              <span className="badge">
                Payment required
              </span>
            )}
          </div>

          <div className="payment-summary">
            <PaymentState
              label="Marketplace payment"
              payment={marketplacePayment}
            />

            {requiresTransportPayment && (
              <PaymentState
                label="Transport payment"
                payment={transportPayment}
              />
            )}
          </div>

          {!isMarketplacePaid && (
            <div className="notice">
              <strong>
                Marketplace payment pending.
              </strong>
              <p className="muted">
                The order must have a verified
                MARKETPLACE payment before
                transport can proceed.
              </p>
            </div>
          )}

          {requiresTransportPayment &&
            isMarketplacePaid &&
            !isTransportPaid && (
              <div className="notice">
                <strong>
                  Transport payment pending.
                </strong>

                {acceptedTransportAmount !=
                  null && (
                  <p className="muted">
                    Accepted transport fee:{' '}
                    <strong>
                      {money(
                        acceptedTransportAmount
                      )}{' '}
                      ETB
                    </strong>
                  </p>
                )}
              </div>
            )}

          {requiresTransportPayment &&
            isTransportPaid &&
            !transportAmountMatches && (
              <div className="alert error">
                The recorded transport payment
                amount does not match the accepted
                transport quote.
              </div>
            )}

          {isMarketplacePaid &&
            (!requiresTransportPayment ||
              isTransportPaid) && (
              <div className="notice success">
                Required payment conditions are
                satisfied for the current stage.
              </div>
            )}
        </div>

        {/* Transport */}
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

          {!transport && (
            <div className="notice">
              No transport arrangement has been
              recorded for this order yet.
            </div>
          )}

          {transport && (
            <>
              <div className="transport-overview">
                <div>
                  <span>Arranging party</span>
                  <strong>
                    {statusLabel(
                      transport.arrangingParty
                    )}
                  </strong>
                </div>

                <div>
                  <span>Method</span>
                  <strong>
                    {statusLabel(
                      transport.method
                    )}
                  </strong>
                </div>

                <div>
                  <span>Status</span>
                  <strong>
                    <StatusBadge
                      status={transport.status}
                    />
                  </strong>
                </div>
              </div>

              <div className="route-box">
                <div>
                  <span>Pickup</span>
                  <strong>
                    {transport.pickupLocation ||
                      '—'}
                  </strong>
                </div>

                <div className="route-arrow">
                  →
                </div>

                <div>
                  <span>Destination</span>
                  <strong>
                    {transport.destination ||
                      '—'}
                  </strong>
                </div>
              </div>

              {/* Assigned transporter */}
              {transport.truckOwner && (
                <div className="match-box">
                  <h3>
                    Assigned transporter
                  </h3>

                  <div className="transporter">
                    <div>
                      <strong>
                        {transport.truckOwner
                          .name || '—'}
                      </strong>

                      <p>
                        Rating:{' '}
                        {transport.truckOwner
                          .rating != null
                          ? Number(
                              transport.truckOwner
                                .rating
                            ).toFixed(1)
                          : '—'}
                      </p>

                      <p className="muted">
                        {transport.truckOwner
                          .phone || ''}
                      </p>
                    </div>

                    {transport.truck && (
                      <div>
                        <strong>
                          {transport.truck
                            .registration ||
                            'Truck'}
                        </strong>

                        <p className="muted">
                          {transport.truck
                            .truckType || '—'}{' '}
                          ·{' '}
                          {transport.truck
                            .capacity != null
                            ? `${transport.truck.capacity}t`
                            : 'Capacity —'}
                        </p>
                      </div>
                    )}
                  </div>

                  {transport.method ===
                    'HIRE_TRANSPORTER' &&
                    acceptedTransportAmount !=
                      null && (
                      <div className="notice">
                        <strong>
                          Accepted transport fee:{' '}
                          {money(
                            acceptedTransportAmount
                          )}{' '}
                          ETB
                        </strong>

                        <p className="muted">
                          Transport payment must
                          match this amount exactly
                          within the system's
                          currency precision.
                        </p>
                      </div>
                    )}
                </div>
              )}

              {/* Quotes */}
              {transport.method ===
                'HIRE_TRANSPORTER' &&
                !transport.truckOwnerId && (
                  <div className="match-box">
                    <div className="row-between">
                      <div>
                        <h3>
                          Transport quotes
                        </h3>

                        <p className="muted">
                          Select the transporter
                          only after reviewing the
                          available quotes.
                        </p>
                      </div>

                      {!isMarketplacePaid && (
                        <span className="badge">
                          Payment pending
                        </span>
                      )}
                    </div>

                    {quoteList.length > 0 ? (
                      quoteList.map((quote) => (
                        <div
                          className="transporter"
                          key={quote.id}
                        >
                          <div>
                            <strong>
                              {quote.truckOwner
                                ?.name ||
                                'Truck owner'}
                            </strong>

                            <p>
                              {quote.truck
                                ?.truckType ||
                                'Truck'}{' '}
                              ·{' '}
                              {quote.truck
                                ?.capacity !=
                              null
                                ? `${quote.truck.capacity}t`
                                : 'Capacity —'}{' '}
                              ·{' '}
                              {quote.truck
                                ?.registration ||
                                '—'}
                            </p>

                            <p>
                              ★{' '}
                              {quote.truckOwner
                                ?.rating != null
                                ? Number(
                                    quote.truckOwner
                                      .rating
                                  ).toFixed(1)
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
                              {money(
                                quote.amount
                              )}{' '}
                              ETB
                            </strong>

                            {canChooseQuote && (
                              <button
                                className="btn btn-sm"
                                type="button"
                                disabled={
                                  busy === quote.id
                                }
                                onClick={() =>
                                  acceptQuote(
                                    quote.id
                                  )
                                }
                              >
                                {busy === quote.id
                                  ? 'Accepting…'
                                  : 'Accept quote'}
                              </button>
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

                    {!isMarketplacePaid && (
                      <div className="notice">
                        Marketplace payment must be
                        verified before transport
                        operations can proceed.
                      </div>
                    )}
                  </div>
                )}

              {/* Transport payment information */}
              {transport.method ===
                'HIRE_TRANSPORTER' &&
                transport.truckOwnerId && (
                  <div className="match-box">
                    <h3>
                      Transport payment
                    </h3>

                    <div className="detail-facts">
                      <div>
                        <span>
                          Accepted fee
                        </span>
                        <strong>
                          {acceptedTransportAmount !=
                          null
                            ? `${money(
                                acceptedTransportAmount
                              )} ETB`
                            : 'Not recorded'}
                        </strong>
                      </div>

                      <div>
                        <span>
                          Payment status
                        </span>
                        <strong>
                          <StatusBadge
                            status={
                              transportPayment
                                ?.status ||
                              'PENDING'
                            }
                          />
                        </strong>
                      </div>

                      <div>
                        <span>
                          Paid amount
                        </span>
                        <strong>
                          {transportPayment
                            ? `${money(
                                transportPayment.amount
                              )} ETB`
                            : '—'}
                        </strong>
                      </div>
                    </div>

                    {!isTransportPaid && (
                      <div className="notice">
                        The accepted transporter
                        must be paid before this
                        transport can move to its
                        physical delivery stages.
                      </div>
                    )}
                  </div>
                )}
            </>
          )}
        </div>

        {/* Receipt */}
        {order.status === 'DELIVERED' &&
          order.buyerId === user?.id && (
            <div className="card">
              <h2>Confirm receipt</h2>

              <p className="muted">
                Confirm only after you have
                physically received the
                produce/product.
              </p>

              {!canConfirmReceipt &&
                receiptBlockedReason && (
                  <div className="notice">
                    {receiptBlockedReason}
                  </div>
                )}

              <button
                className="btn btn-primary"
                type="button"
                disabled={
                  busy === 'receipt' ||
                  !canConfirmReceipt
                }
                onClick={confirmReceipt}
              >
                {busy === 'receipt'
                  ? 'Confirming…'
                  : 'Confirm receipt & complete order'}
              </button>
            </div>
          )}

        {/* Payment records */}
        <div className="card">
          <h2>Payment records</h2>

          {payments.length > 0 ? (
            <div className="payment-list">
              {payments.map((payment) => (
                <div
                  className="payment-row"
                  key={payment.id}
                >
                  <div>
                    <strong>
                      {statusLabel(
                        payment.type
                      )}
                    </strong>

                    {payment.reference && (
                      <p className="muted">
                        Reference:{' '}
                        {payment.reference}
                      </p>
                    )}

                    {payment.provider && (
                      <p className="muted">
                        Provider:{' '}
                        {payment.provider}
                      </p>
                    )}
                  </div>

                  <strong>
                    {money(payment.amount)}{' '}
                    {payment.currency || 'ETB'}
                  </strong>

                  <span>
                    {statusLabel(
                      payment.method
                    )}
                  </span>

                  <StatusBadge
                    status={payment.status}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">
              No payment records are attached to
              this order yet.
            </p>
          )}
        </div>

        {/* Final state */}
        {order.status === 'COMPLETED' && (
          <div className="card">
            <div className="notice success">
              <strong>
                Order completed successfully.
              </strong>

              <p className="muted">
                The buyer has confirmed receipt and
                the order is now complete.
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
