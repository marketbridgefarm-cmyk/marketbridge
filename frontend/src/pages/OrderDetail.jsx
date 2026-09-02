import React, {
  useEffect,
  useState,
} from 'react';

import {
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom';

import api from '../api/client';

import {
  useAuth,
} from '../context/AuthContext.jsx';


const money = (value) =>
  `${Number(
    value || 0
  ).toLocaleString()} ETB`;


export default function OrderDetail() {
  const {
    orderId,
  } = useParams();

  const navigate =
    useNavigate();

  const {
    user,
  } = useAuth();


  const [
    order,
    setOrder,
  ] = useState(null);


  const [
    error,
    setError,
  ] = useState('');


  const [
    busy,
    setBusy,
  ] = useState('');


  async function load() {
    try {
      setError('');

      const response =
        await api.get(
          `/orders/${orderId}`
        );

      setOrder(
        response.data.order
      );
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Order not found'
      );
    }
  }


  useEffect(
    () => {
      load();
    },
    [orderId]
  );


  async function acceptQuote(
    id
  ) {
    setBusy(id);

    try {
      await api.patch(
        `/transport/quotes/${id}/accept`
      );

      await load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not accept quote'
      );
    } finally {
      setBusy('');
    }
  }


  async function requestInspection() {
    if (!order?.listingId) {
      return;
    }

    setBusy(
      'inspection'
    );

    try {
      await api.post(
        '/inspections',
        {
          listingId:
            order.listingId,

          mode:
            'BUYER_REQUESTED',
        }
      );

      await load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not request inspection'
      );
    } finally {
      setBusy('');
    }
  }


  async function cancelOrder() {
    const confirmed =
      window.confirm(
        'Cancel this order? The listing will become available to buyers again.'
      );

    if (!confirmed) {
      return;
    }

    setBusy(
      'cancel'
    );

    try {
      await api.patch(
        `/orders/${orderId}/cancel`
      );

      await load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not cancel order'
      );
    } finally {
      setBusy('');
    }
  }


  async function confirmReceipt() {
    setBusy(
      'receipt'
    );

    try {
      await api.patch(
        `/orders/${orderId}/confirm-receipt`
      );

      await load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
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
          {
            error ||
            'Loading order…'
          }
        </div>
      </main>
    );
  }


  const transport =
    order.transportJob;


  const inspections =
    order.listing
      ?.inspectionRequests ||
    [];


  const canChooseQuote =
    Boolean(
      transport &&

      (
        order.buyerId ===
          user?.id ||
        order.sellerId ===
          user?.id
      ) &&

      [
        'REQUESTED',
        'QUOTED',
      ].includes(
        transport.status
      ) &&

      !transport.truckOwnerId
    );


  const canRequestInspection =
    order.buyerId ===
      user?.id &&

    !inspections.some(
      (item) =>
        item.status !==
        'CANCELLED'
    );


  const canCancel =
    ![
      'COMPLETED',
      'DELIVERED',
      'IN_TRANSIT',
      'CANCELLED',
    ].includes(
      order.status
    );


  return (
    <main className="section">

      <div className="container-narrow">

        <button
          className="back-link"
          onClick={() =>
            navigate(-1)
          }
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
              ORDER{' '}
              {
                order.id.slice(
                  0,
                  8
                )
              }
            </span>


            <h1>
              {
                order.listing
                  ?.title ||
                order.listing
                  ?.cropType ||
                'Order'
              }
            </h1>


            <p>

              <span className="badge">
                {
                  order.status
                }
              </span>

              {' · '}

              {
                money(
                  order.finalPrice
                )
              }

            </p>

          </div>

        </div>


        {/* PARTIES */}

        <div className="card">

          <h2>
            Parties
          </h2>


          <div className="detail-facts">

            <div>
              <span>
                Buyer
              </span>

              <strong>
                {
                  order.buyer
                    ?.name ||
                  '—'
                }
              </strong>
            </div>


            <div>
              <span>
                Seller
              </span>

              <strong>
                {
                  order.seller
                    ?.name ||
                  '—'
                }
              </strong>
            </div>


            <div>
              <span>
                Amount
              </span>

              <strong>
                {
                  money(
                    order.finalPrice
                  )
                }
              </strong>
            </div>

          </div>

        </div>


        {/* INSPECTION */}

        <div className="card">

          <div className="row-between">

            <div>

              <h2>
                Inspection
              </h2>

              <p className="muted">
                Inspection is a separate
                quality-verification
                workflow. Inspectors do
                not arrange transport.
              </p>

            </div>


            {
              canRequestInspection && (

                <button
                  className="btn btn-primary"
                  disabled={
                    busy ===
                    'inspection'
                  }
                  onClick={
                    requestInspection
                  }
                >
                  {
                    busy ===
                    'inspection'
                      ? 'Requesting…'
                      : 'Request Inspection'
                  }
                </button>

              )
            }

          </div>


          {
            inspections.length
              ? inspections.map(
                  (
                    item
                  ) => (

                    <div
                      className="evidence"
                      key={
                        item.id
                      }
                      style={{
                        marginTop:
                          12,
                      }}
                    >

                      <div>

                        <strong>
                          {
                            item.mode?.replaceAll(
                              '_',
                              ' '
                            )
                          }
                        </strong>


                        <span
                          className="badge"
                          style={{
                            marginLeft:
                              8,
                          }}
                        >
                          {
                            item.status
                          }
                        </span>

                      </div>


                      <p>
                        {
                          item.inspector
                            ? `Inspector: ${item.inspector.name}`
                            : 'Waiting for a registered inspector.'
                        }
                      </p>


                      {
                        item.report
                          ? (

                            <p>
                              ✓ Verified
                              quantity:{' '}
                              {
                                item.report
                                  .quantity
                              }{' '}
                              {
                                order
                                  .listing
                                  ?.unit ||
                                ''
                              }

                              {
                                item.report
                                  .grade
                                  ? ` · Grade: ${item.report.grade}`
                                  : ''
                              }

                              {
                                item.report
                                  .moisture !=
                                  null
                                  ? ` · Moisture: ${item.report.moisture}%`
                                  : ''
                              }
                            </p>

                          )
                          : (

                            <p className="muted">
                              Report pending.
                            </p>

                          )
                      }

                    </div>

                  )
                )
              : (

                <div className="notice">
                  No inspection
                  request exists for
                  this order yet.
                </div>

              )
          }

        </div>


        {/* TRANSPORT */}

        <div className="card">

          <div className="row-between">

            <div>

              <h2>
                Transport
              </h2>

              <p className="muted">
                The buyer or seller
                arranges transport.
                MarketBridge does not
                automatically assign
                a transporter.
              </p>

            </div>


            {
              !transport &&
              ![
                'CANCELLED',
                'COMPLETED',
              ].includes(
                order.status
              ) && (

                <Link
                  className="btn btn-primary"
                  to={`/orders/${order.id}/transport`}
                >
                  Arrange Transport
                </Link>

              )
            }

          </div>


          {
            transport
              ? (

                <>

                  <p>

                    <strong>
                      {
                        transport
                          .arrangingParty
                      }
                    </strong>

                    {' · '}

                    {
                      transport
                        .method
                    }

                    {' · '}

                    <span className="badge">
                      {
                        transport
                          .status
                      }
                    </span>

                  </p>


                  <p>
                    {
                      transport
                        .pickupLocation
                    }

                    {' → '}

                    {
                      transport
                        .destination
                    }
                  </p>


                  {
                    transport.truckOwner &&
                    (

                      <p>
                        Transporter:{' '}

                        <strong>
                          {
                            transport
                              .truckOwner
                              .name
                          }
                        </strong>

                        {' · Truck '}

                        {
                          transport
                            .truck
                            ?.registration ||
                          '—'
                        }
                      </p>

                    )
                  }


                  {
                    transport.method ===
                      'HIRE_TRANSPORTER' &&
                    !transport.truckOwnerId && (

                      <div className="match-box">

                        <h3>
                          Transport quotes
                        </h3>


                        {
                          transport.quotes
                            ?.length
                            ? transport
                                .quotes
                                .map(
                                  (
                                    quote
                                  ) => (

                                    <div
                                      className="transporter"
                                      key={
                                        quote.id
                                      }
                                    >

                                      <div>

                                        <strong>
                                          {
                                            quote
                                              .truckOwner
                                              ?.name ||
                                            'Registered transporter'
                                          }
                                        </strong>


                                        <p>
                                          {
                                            quote
                                              .truck
                                              ?.truckType ||
                                            'Truck'
                                          }

                                          {' · '}

                                          {
                                            quote
                                              .truck
                                              ?.capacity ||
                                            '—'
                                          }
                                          t

                                          {' · '}

                                          {
                                            quote
                                              .truck
                                              ?.registration ||
                                            '—'
                                          }
                                        </p>


                                        {
                                          quote.message &&
                                          (

                                            <p className="muted">
                                              {
                                                quote.message
                                              }
                                            </p>

                                          )
                                        }

                                      </div>


                                      <div>

                                        <strong>
                                          {
                                            money(
                                              quote.amount
                                            )
                                          }
                                        </strong>


                                        {
                                          canChooseQuote &&
                                          (

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
                                              {
                                                busy ===
                                                quote.id
                                                  ? 'Accepting…'
                                                  : 'Accept quote'
                                              }
                                            </button>

                                          )
                                        }

                                      </div>

                                    </div>

                                  )
                                )
                            : (

                              <p className="muted">
                                Waiting for
                                registered
                                truck owners
                                to submit
                                quotes.
                              </p>

                            )
                        }

                      </div>

                    )
                  }

                </>

              )
              : (

                <div className="notice">
                  No transport
                  arrangement recorded
                  yet.
                </div>

              )
          }

        </div>


        {/* RECEIPT */}

        {
          order.status ===
            'DELIVERED' &&
          order.buyerId ===
            user?.id && (

            <div className="card">

              <h2>
                Confirm receipt
              </h2>

              <p className="muted">
                Confirm only after
                you have physically
                received the
                produce/product.
              </p>


              <button
                className="btn btn-primary"
                disabled={
                  busy ===
                  'receipt'
                }
                onClick={
                  confirmReceipt
                }
              >
                {
                  busy ===
                  'receipt'
                    ? 'Confirming…'
                    : 'Confirm receipt & complete order'
                }
              </button>

            </div>

          )
        }


        {/* CANCEL */}

        {
          canCancel &&
          (
            order.buyerId ===
              user?.id ||
            order.sellerId ===
              user?.id
          ) && (

            <div className="card">

              <h2>
                Order controls
              </h2>

              <p className="muted">
                If the transaction is
                cancelled before
                delivery, the
                temporarily reserved
                listing is released
                back to buyer
                availability.
              </p>


              <button
                className="btn btn-light"
                disabled={
                  busy ===
                  'cancel'
                }
                onClick={
                  cancelOrder
                }
              >
                {
                  busy ===
                  'cancel'
                    ? 'Cancelling…'
                    : 'Cancel order & release listing'
                }
              </button>

            </div>

          )
        }


        {/* PAYMENTS */}

        <div className="card">

          <h2>
            Payment records
          </h2>


          {
            order.payments
              ?.length
              ? order.payments.map(
                  (
                    payment
                  ) => (

                    <div
                      className="payment-row"
                      key={
                        payment.id
                      }
                    >

                      <span>
                        {
                          payment.type
                        }
                      </span>

                      <strong>
                        {
                          money(
                            payment.amount
                          )
                        }
                      </strong>

                      <span>
                        {
                          payment.method
                        }
                      </span>

                      <span className="badge">
                        {
                          payment.status
                        }
                      </span>

                    </div>

                  )
                )
              : (

                <p className="muted">
                  No payment records
                  attached to this
                  order yet.
                </p>

              )
          }

        </div>

      </div>
    </main>
  );
}
