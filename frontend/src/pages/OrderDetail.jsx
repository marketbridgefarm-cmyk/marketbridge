import React, { useEffect, useState } from 'react';
import {
  Link,
  useParams,
  useNavigate,
} from 'react-router-dom';

import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import PaymentPanel from '../components/PaymentPanel.jsx';

function getLatestPayment(payments = [], type) {
  const matching = payments.filter(
    (payment) => payment.type === type
  );

  if (!matching.length) return null;

  return [...matching].sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) -
      new Date(a.updatedAt || a.createdAt || 0)
  )[0];
}

function isPaid(payment) {
  return payment?.status === 'PAID';
}

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

export default function OrderDetail() {
  const { orderId } = useParams();
  const nav = useNavigate();
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
        'Order not found'
      );
    }
  }

  useEffect(() => {
    load();
  }, [orderId]);

  async function acceptQuote(id) {
    setBusy(id);
    setError('');

    try {
      await api.patch(
        `/transport/quotes/${id}/accept`
      );

      await load();
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Could not accept quote'
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
        'Could not confirm receipt'
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

  const t = order.transportJob;

  const payments = order.payments || [];

  const marketplacePayment =
    getLatestPayment(
      payments,
      'MARKETPLACE'
    );

  const transportPayment =
    getLatestPayment(
      payments,
      'TRANSPORT'
    );

  const marketplacePaid =
    isPaid(marketplacePayment);

  const transportPaid =
    isPaid(transportPayment);

  const isBuyer =
    order.buyerId === user?.id;

  const isSeller =
    order.sellerId === user?.id;

  const isParticipant =
    isBuyer || isSeller;

  /*
   * Marketplace payment:
   *
   * Show the payment panel to the buyer when the
   * marketplace transaction has not been verified PAID.
   *
   * Do not show it after the order is completed/cancelled.
   */
  const showMarketplacePayment =
    isBuyer &&
    !marketplacePaid &&
    !['CANCELLED', 'COMPLETED'].includes(
      order.status
    );

  /*
   * A hired transporter must have an accepted quote
   * before its transport fee can be paid.
   *
   * Marketplace payment must already be PAID.
   */
  const hiredTransportAccepted =
    t?.method === 'HIRE_TRANSPORTER' &&
    t?.status === 'ACCEPTED' &&
    t?.agreedAmount != null;

  const showTransportPayment =
    isParticipant &&
    hiredTransportAccepted &&
    marketplacePaid &&
    !transportPaid &&
    !['CANCELLED', 'COMPLETED'].includes(
      order.status
    );

  const canChooseQuote =
    t &&
    ['BUYER', 'SELLER'].some((role) =>
      user?.roles?.includes(role)
    ) &&
    isParticipant &&
    ['REQUESTED', 'QUOTED'].includes(
      t.status
    ) &&
    !t.truckOwnerId;

  const title =
    order.listing?.title ||
    order.listing?.cropType ||
    'Order';

  const marketplaceAmount =
    Number(order.finalPrice);

  const transportAmount =
    Number(t?.agreedAmount);

  return (
    <main className="section">
      <div className="container-narrow">

        <button
          className="back-link"
          onClick={() => nav(-1)}
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
              ORDER {order.id.slice(0, 8)}
            </span>

            <h1>{title}</h1>

            <p>
              <span className="badge">
                {order.status}
              </span>{' '}
              ·{' '}
              {Number(
                order.finalPrice
              ).toLocaleString()}{' '}
              ETB
            </p>
          </div>
        </div>

        {/* PARTIES */}

        <div className="card">
          <h2>Parties</h2>

          <div className="detail-facts">
            <div>
              <span>Buyer</span>
              <strong>
                {order.buyer?.name}
              </strong>
            </div>

            <div>
              <span>Seller</span>
              <strong>
                {order.seller?.name}
              </strong>
            </div>

            <div>
              <span>Amount</span>
              <strong>
                {Number(
                  order.finalPrice
                ).toLocaleString()}{' '}
                ETB
              </strong>
            </div>
          </div>
        </div>

        {/* MARKETPLACE PAYMENT */}

        {showMarketplacePayment && (
          <div className="card">
            <PaymentPanel
              type="MARKETPLACE"
              orderId={order.id}
              amount={marketplaceAmount}
              onPaid={async () => {
                await load();
              }}
            />
          </div>
        )}

        {/* PAYMENT STATUS */}

        {!showMarketplacePayment &&
          marketplacePayment && (
            <div className="card">
              <div className="row-between">
                <div>
                  <h2>Order payment</h2>

                  <p className="muted">
                    Marketplace payment:{' '}
                    <strong>
                      {Number(
                        marketplacePayment.amount
                      ).toLocaleString()}{' '}
                      ETB
                    </strong>
                  </p>
                </div>

                <span className="badge">
                  {marketplacePayment.status}
                </span>
              </div>
            </div>
          )}

        {/* TRANSPORT */}

        <div className="card">
          <div className="row-between">
            <div>
              <h2>Transport</h2>

              <p className="muted">
                The buyer or seller arranges
                transport. MarketBridge does not
                auto-assign a transporter.
              </p>
            </div>

            {!t &&
              order.status !== 'CANCELLED' && (
                <Link
                  className="btn btn-primary"
                  to={`/orders/${order.id}/transport`}
                >
                  Arrange transport
                </Link>
              )}
          </div>

          {t ? (
            <>
              <p>
                <strong>
                  {t.arrangingParty}
                </strong>{' '}
                · {t.method} ·{' '}
                <span className="badge">
                  {t.status}
                </span>
              </p>

              <p>
                {t.pickupLocation} →{' '}
                {t.destination}
              </p>

              {t.truckOwner && (
                <p>
                  Transporter:{' '}
                  <strong>
                    {t.truckOwner.name}
                  </strong>{' '}
                  · Truck{' '}
                  {t.truck?.registration}
                </p>
              )}

              {/* TRANSPORT QUOTES */}

              {t.method ===
                'HIRE_TRANSPORTER' &&
                !t.truckOwnerId && (
                  <div className="match-box">
                    <h3>
                      Transport quotes
                    </h3>

                    {t.quotes?.length ? (
                      t.quotes.map((quote) => (
                        <div
                          className="transporter"
                          key={quote.id}
                        >
                          <div>
                            <strong>
                              {
                                quote.truckOwner
                                  ?.name
                              }
                            </strong>

                            <p>
                              {
                                quote.truck
                                  ?.truckType
                              }{' '}
                              ·{' '}
                              {
                                quote.truck
                                  ?.capacity
                              }
                              t ·{' '}
                              {
                                quote.truck
                                  ?.registration
                              }{' '}
                              · ★{' '}
                              {quote.truckOwner?.rating?.toFixed?.(
                                1
                              ) || '—'}
                            </p>

                            {quote.message && (
                              <p className="muted">
                                {quote.message}
                              </p>
                            )}
                          </div>

                          <div>
                            <strong>
                              {Number(
                                quote.amount
                              ).toLocaleString()}{' '}
                              ETB
                            </strong>

                            {canChooseQuote && (
                              <button
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
                        Waiting for registered
                        truck owners to submit
                        quotes.
                      </p>
                    )}
                  </div>
                )}

              {/* ACCEPTED TRANSPORT PAYMENT */}

              {hiredTransportAccepted && (
                <div className="notice">
                  <strong>
                    Accepted transport fee:
                  </strong>{' '}
                  {Number(
                    t.agreedAmount
                  ).toLocaleString()}{' '}
                  ETB
                </div>
              )}
            </>
          ) : (
            <div className="notice">
              No transport arrangement recorded
              yet.
            </div>
          )}
        </div>

        {/* TRANSPORT PAYMENT */}

        {showTransportPayment && (
          <div className="card">
            <PaymentPanel
              type="TRANSPORT"
              orderId={order.id}
              amount={transportAmount}
              transportJobId={t.id}
              onPaid={async () => {
                await load();
              }}
            />
          </div>
        )}

        {/* TRANSPORT PAYMENT STATUS */}

        {!showTransportPayment &&
          transportPayment && (
            <div className="card">
              <div className="row-between">
                <div>
                  <h2>
                    Transport payment
                  </h2>

                  <p className="muted">
                    Paid/recorded transport
                    amount:{' '}
                    <strong>
                      {Number(
                        transportPayment.amount
                      ).toLocaleString()}{' '}
                      ETB
                    </strong>
                  </p>

                  {t?.agreedAmount != null &&
                    !moneyEqual(
                      transportPayment.amount,
                      t.agreedAmount
                    ) && (
                      <p className="alert error">
                        Transport payment does
                        not match the accepted
                        transport fee.
                      </p>
                    )}
                </div>

                <span className="badge">
                  {transportPayment.status}
                </span>
              </div>
            </div>
          )}

        {/* RECEIPT */}

        {order.status === 'DELIVERED' &&
          isBuyer && (
            <div className="card">
              <h2>Confirm receipt</h2>

              <p className="muted">
                Confirm only after you have
                physically received the
                produce/product.
              </p>

              {!marketplacePaid ? (
                <div className="notice">
                  Marketplace payment must be
                  verified before receipt can be
                  confirmed.
                </div>
              ) : t?.method ===
                  'HIRE_TRANSPORTER' &&
                !transportPaid ? (
                <div className="notice">
                  Transport payment must be
                  verified before receipt can be
                  confirmed.
                </div>
              ) : (
                <button
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
              )}
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
                  {Number(
                    payment.amount
                  ).toLocaleString()}{' '}
                  ETB
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
              No payment records attached
              to this order yet.
            </p>
          )}
        </div>

      </div>
    </main>
  );
}
