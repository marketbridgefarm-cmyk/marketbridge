import React, {
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom';

import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import PaymentPanel from '../components/PaymentPanel.jsx';

function money(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '0.00';
  }

  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortId(value) {
  return String(value || '').slice(0, 8);
}

function isPaid(payment) {
  return String(payment?.status || '').toUpperCase() === 'PAID';
}

function getLatestPayment(payments, type) {
  const matching = (payments || []).filter(
    (payment) =>
      String(payment.type || '').toUpperCase() ===
      String(type || '').toUpperCase()
  );

  if (!matching.length) {
    return null;
  }

  /*
   * Prefer PAID because payment arrays may contain old PENDING,
   * FAILED or replaced attempts.
   */
  const paid = matching.find(isPaid);

  return paid || matching[0];
}

function StatusBadge({ children }) {
  return (
    <span className="badge">
      {children}
    </span>
  );
}

function PaymentState({ payment, label }) {
  if (!payment) {
    return (
      <div>
        <span>{label}</span>
        <strong>Not started</strong>
      </div>
    );
  }

  return (
    <div>
      <span>{label}</span>
      <strong>
        {money(payment.amount)} ETB · {payment.status}
      </strong>
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

  async function load() {
    try {
      setError('');

      const response = await api.get(
        `/orders/${orderId}`
      );

      setOrder(response.data.order);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Order not found.'
      );
    }
  }

  useEffect(() => {
    load();
  }, [orderId]);

  async function acceptQuote(quoteId) {
    setBusy(quoteId);
    setError('');

    try {
      await api.patch(
        `/transport/quotes/${quoteId}/accept`
      );

      await load();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not accept transport quote.'
      );
    } finally {
      setBusy('');
    }
  }

  async function confirmReceipt() {
    setBusy('receipt');
    setError('');

    try {
      await api.patch(
        `/orders/${orderId}/confirm-receipt`
      );

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

  if (!order) {
    return (
      <main className="section">
        <div className="container-narrow loading">
          {error || 'Loading order…'}
        </div>
      </main>
    );
  }

  const transport = order.transportJob;
  const payments = order.payments || [];

  const marketplacePayment = useMemo(
    () => getLatestPayment(payments, 'MARKETPLACE'),
    [payments]
  );

  const transportPayment = useMemo(
    () => getLatestPayment(payments, 'TRANSPORT'),
    [payments]
  );

  const marketplacePaid = isPaid(
    marketplacePayment
  );

  const transportRequired =
    transport?.method === 'HIRE_TRANSPORTER';

  const transportPaid =
    isPaid(transportPayment);

  const acceptedTransportAmount =
    transport?.agreedAmount != null
      ? Number(transport.agreedAmount)
      : null;

  const transportPaymentAmount =
    transportPayment?.amount != null
      ? Number(transportPayment.amount)
      : null;

  const transportAmountMatches =
    acceptedTransportAmount != null &&
    transportPaymentAmount != null &&
    Math.abs(
      acceptedTransportAmount -
        transportPaymentAmount
    ) < 0.01;

  const transportPaymentReady =
    !transportRequired ||
    (transportPaid &&
      transportAmountMatches);

  const title =
    order.listing?.title ||
    order.listing?.cropType ||
    'Order';

  const isBuyer =
    order.buyerId === user?.id;

  const isParticipant =
    order.buyerId === user?.id ||
    order.sellerId === user?.id;

  const canChooseQuote =
    Boolean(
      transport &&
        ['BUYER', 'SELLER'].some((role) =>
          user?.roles?.includes(role)
        ) &&
        isParticipant &&
        ['REQUESTED', 'QUOTED'].includes(
          transport.status
        ) &&
        !transport.truckOwnerId
    );

  const canArrangeTransport =
    isParticipant &&
    !transport &&
    !['CANCELLED', 'COMPLETED'].includes(
      order.status
    );

  /*
   * Marketplace payment is required for every buyer who has
   * an unpaid active order.
   */
  const showMarketplacePayment =
    isBuyer &&
    !marketplacePaid &&
    !['CANCELLED', 'COMPLETED'].includes(
      order.status
    );

  /*
   * Transport payment becomes available only after a transporter
   * has been selected and the accepted amount exists.
   */
  const showTransportPayment =
    isBuyer &&
    transportRequired &&
    Boolean(transport?.truckOwnerId) &&
    transport?.status === 'ACCEPTED' &&
    acceptedTransportAmount != null &&
    marketplacePaid &&
    !transportPaid;

  const canConfirmReceipt =
    isBuyer &&
    order.status === 'DELIVERED' &&
    marketplacePaid &&
    transportPaymentReady;

  const lifecycle = [
    {
      key: 'PENDING_PAYMENT',
      label: 'Payment',
      active: order.status === 'PENDING_PAYMENT',
    },
    {
      key: 'CONFIRMED',
      label: 'Confirmed',
      active: [
        'CONFIRMED',
        'TRANSPORT_ARRANGED',
        'IN_TRANSIT',
        'DELIVERED',
        'COMPLETED',
      ].includes(order.status),
    },
    {
      key: 'TRANSPORT_ARRANGED',
      label: 'Transport',
      active: [
        'TRANSPORT_ARRANGED',
        'IN_TRANSIT',
        'DELIVERED',
        'COMPLETED',
      ].includes(order.status),
    },
    {
      key: 'IN_TRANSIT',
      label: 'In transit',
      active: [
        'IN_TRANSIT',
        'DELIVERED',
        'COMPLETED',
      ].includes(order.status),
    },
    {
      key: 'DELIVERED',
      label: 'Delivered',
      active: [
        'DELIVERED',
        'COMPLETED',
      ].includes(order.status),
    },
    {
      key: 'COMPLETED',
      label: 'Completed',
      active: order.status === 'COMPLETED',
    },
  ];

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
              <StatusBadge>
                {order.status}
              </StatusBadge>

              {' · '}

              <strong>
                {money(order.finalPrice)} ETB
              </strong>
            </p>
          </div>
        </div>

        {/* ORDER LIFECYCLE */}
        <div className="card">
          <h2>Order progress</h2>

          <div className="timeline">
            {lifecycle.map((step) => (
              <div
                className={
                  step.active
                    ? 'timeline-step done'
                    : 'timeline-step'
                }
                key={step.key}
              >
                <span>
                  {step.active ? '✓' : '•'}
                </span>

                {step.label}
              </div>
            ))}
          </div>
        </div>

        {/* PAYMENT REQUIRED */}
        {showMarketplacePayment && (
          <div className="card">
            <span className="eyebrow">
              BUYER ACTION REQUIRED
            </span>

            <h2>Pay your order</h2>

            <p className="muted">
              Your order has been created, but the
              marketplace payment has not yet been
              verified.
            </p>

            <div className="detail-facts">
              <div>
                <span>Order amount</span>
                <strong>
                  {money(order.finalPrice)} ETB
                </strong>
              </div>

              <div>
                <span>Payment status</span>
                <strong>
                  {marketplacePayment?.status ||
                    'NOT PAID'}
                </strong>
              </div>

              <div>
                <span>Next step</span>
                <strong>
                  Pay through Chapa
                </strong>
              </div>
            </div>

            <PaymentPanel
              type="MARKETPLACE"
              orderId={order.id}
              amount={order.finalPrice}
              onPaid={async () => {
                await load();
              }}
            />
          </div>
        )}

        {/* PAYMENT SUCCESS / STATE */}
        <div className="card">
          <h2>Payment status</h2>

          <div className="detail-facts">
            <PaymentState
              label="Marketplace"
              payment={marketplacePayment}
            />

            {transportRequired && (
              <PaymentState
                label="Transport"
                payment={transportPayment}
              />
            )}

            <div>
              <span>Order status</span>
              <strong>
                {order.status}
              </strong>
            </div>
          </div>

          {!marketplacePaid &&
            isBuyer &&
            !showMarketplacePayment &&
            order.status !== 'CANCELLED' && (
              <div className="notice">
                Marketplace payment is not yet
                verified. Transport and delivery
                actions remain restricted.
              </div>
            )}
        </div>

        {/* PARTIES */}
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
              <span>Amount</span>
              <strong>
                {money(order.finalPrice)} ETB
              </strong>
            </div>
          </div>
        </div>

        {/* TRANSPORT */}
        <div className="card">
          <div className="row-between">
            <div>
              <h2>Transport</h2>

              <p className="muted">
                The buyer or seller arranges transport.
                MarketBridge does not automatically
                assign a transporter.
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

          {!marketplacePaid && isBuyer && (
            <div className="notice">
              <strong>Payment required first.</strong>{' '}
              Complete the marketplace payment before
              arranging or proceeding with transport.
            </div>
          )}

          {transport ? (
            <>
              <p>
                <strong>
                  {transport.arrangingParty}
                </strong>

                {' · '}

                {transport.method}

                {' · '}

                <StatusBadge>
                  {transport.status}
                </StatusBadge>
              </p>

              <p>
                {transport.pickupLocation}
                {' → '}
                {transport.destination}
              </p>

              {transport.truckOwner && (
                <div className="notice">
                  Transporter:{' '}
                  <strong>
                    {transport.truckOwner.name}
                  </strong>

                  {transport.truck?.registration && (
                    <>
                      {' · Truck '}
                      {transport.truck.registration}
                    </>
                  )}
                </div>
              )}

              {transport.method ===
                'HIRE_TRANSPORTER' && (
                <>
                  {/* ACCEPTED TRANSPORT PAYMENT */}
                  {transport.truckOwnerId &&
                    transport.status === 'ACCEPTED' && (
                      <div className="card">
                        <h3>
                          Transport payment
                        </h3>

                        <div className="detail-facts">
                          <div>
                            <span>
                              Accepted fee
                            </span>

                            <strong>
                              {acceptedTransportAmount != null
                                ? `${money(
                                    acceptedTransportAmount
                                  )} ETB`
                                : 'Not available'}
                            </strong>
                          </div>

                          <div>
                            <span>
                              Payment status
                            </span>

                            <strong>
                              {transportPayment?.status ||
                                'NOT PAID'}
                            </strong>
                          </div>

                          <div>
                            <span>
                              Marketplace payment
                            </span>

                            <strong>
                              {marketplacePaid
                                ? 'PAID'
                                : 'NOT PAID'}
                            </strong>
                          </div>
                        </div>

                        {transportPayment &&
                          !transportAmountMatches && (
                            <div className="alert error">
                              The transport payment amount
                              does not match the accepted
                              transport quote. A matching
                              payment is required before
                              transport can proceed.
                            </div>
                          )}

                        {showTransportPayment && (
                          <PaymentPanel
                            type="TRANSPORT"
                            orderId={order.id}
                            transportJobId={transport.id}
                            amount={
                              acceptedTransportAmount
                            }
                            onPaid={async () => {
                              await load();
                            }}
                          />
                        )}

                        {transportPaid &&
                          transportAmountMatches && (
                            <div className="alert success">
                              Transport payment verified.
                              The accepted transport fee has
                              been paid.
                            </div>
                          )}
                      </div>
                    )}

                  {/* QUOTES */}
                  {!transport.truckOwnerId && (
                    <div className="match-box">
                      <h3>
                        Transport quotes
                      </h3>

                      {transport.quotes?.length ? (
                        transport.quotes.map(
                          (quote) => (
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
                                    ?.capacity ??
                                    '—'}
                                  t

                                  {quote.truck
                                    ?.registration && (
                                    <>
                                      {' · '}
                                      {
                                        quote.truck
                                          .registration
                                      }
                                    </>
                                  )}

                                  {' · ★ '}

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
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={
                                      busy ===
                                      quote.id
                                    }
                                    onClick={() =>
                                      acceptQuote(
                                        quote.id
                                      )
                                    }
                                  >
                                    {busy ===
                                    quote.id
                                      ? 'Accepting…'
                                      : 'Accept quote'}
                                  </button>
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
                </>
              )}
            </>
          ) : (
            <div className="notice">
              No transport arrangement recorded yet.
            </div>
          )}
        </div>

        {/* DELIVERY / RECEIPT */}
        {order.status === 'DELIVERED' &&
          isBuyer && (
            <div className="card">
              <span className="eyebrow">
                DELIVERY
              </span>

              <h2>
                Confirm receipt
              </h2>

              {!marketplacePaid ? (
                <div className="alert error">
                  Marketplace payment has not been
                  verified, so receipt confirmation is
                  unavailable.
                </div>
              ) : transportRequired &&
                !transportPaid ? (
                <div className="alert error">
                  Transport payment must be verified
                  before you can confirm receipt.
                </div>
              ) : transportRequired &&
                !transportAmountMatches ? (
                <div className="alert error">
                  The transport payment does not match
                  the accepted transport fee.
                </div>
              ) : (
                <>
                  <p className="muted">
                    Confirm only after you have
                    physically received the
                    produce/product.
                  </p>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={
                      busy === 'receipt'
                    }
                    onClick={confirmReceipt}
                  >
                    {busy === 'receipt'
                      ? 'Confirming…'
                      : 'Confirm receipt & complete order'}
                  </button>
                </>
              )}
            </div>
          )}

        {/* COMPLETED */}
        {order.status === 'COMPLETED' && (
          <div className="card">
            <div className="alert success">
              <strong>
                Order completed.
              </strong>{' '}
              The buyer has confirmed receipt and the
              transaction is complete.
            </div>
          </div>
        )}

        {/* PAYMENT RECORDS */}
        <div className="card">
          <h2>Payment records</h2>

          {payments.length ? (
            payments.map((payment) => (
              <div
                className="payment-row"
                key={payment.id}
              >
                <span>
                  {payment.type}
                </span>

                <strong>
                  {money(payment.amount)} ETB
                </strong>

                <span>
                  {payment.method}
                </span>

                <span className="badge">
                  {payment.status}
                </span>
              </div>
            ))
          ) : (
            <p className="muted">
              No payment records attached to this
              order yet.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
