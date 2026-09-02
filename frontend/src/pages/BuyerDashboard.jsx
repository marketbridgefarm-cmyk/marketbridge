import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  Link,
} from 'react-router-dom';

import api from '../api/client';

import {
  useAuth,
} from '../context/AuthContext.jsx';


const TABS = [
  {
    id: 'offers',
    label: 'My Offers',
  },

  {
    id: 'orders',
    label: 'My Orders',
  },

  {
    id: 'inspections',
    label: 'Inspections',
  },

  {
    id: 'transport',
    label: 'Transport',
  },
];


const money = (value) =>
  `${Number(
    value || 0
  ).toLocaleString()} ETB`;


const shortId = (id) =>
  id
    ? id.slice(0, 8)
    : '—';


function badgeClass(status) {
  if (
    [
      'COMPLETED',
      'DELIVERED',
      'ACCEPTED',
    ].includes(status)
  ) {
    return '';
  }

  if (
    [
      'CANCELLED',
      'REJECTED',
      'DISPUTED',
    ].includes(status)
  ) {
    return 'sd-warn';
  }

  return 'sd-blue';
}


export default function BuyerDashboard() {
  const {
    user,
  } = useAuth();


  const [
    offers,
    setOffers,
  ] = useState([]);


  const [
    orders,
    setOrders,
  ] = useState([]);


  const [
    inspections,
    setInspections,
  ] = useState([]);


  const [
    trucks,
    setTrucks,
  ] = useState([]);


  const [
    activeTab,
    setActiveTab,
  ] = useState(
    'offers'
  );


  const [
    loading,
    setLoading,
  ] = useState(true);


  const [
    busyInspection,
    setBusyInspection,
  ] = useState('');


  const [
    message,
    setMessage,
  ] = useState('');


  const [
    error,
    setError,
  ] = useState('');


  const loadAll =
    useCallback(
      async () => {
        if (!user?.id) {
          return;
        }

        setLoading(true);
        setError('');

        try {
          const requests = [
            api.get(
              '/offers/mine'
            ),

            api.get(
              '/orders'
            ),

            api.get(
              '/inspections/mine'
            ),
          ];


          if (
            user.roles?.includes(
              'TRUCK_OWNER'
            )
          ) {
            requests.push(
              api.get(
                '/transport/trucks/mine'
              )
            );
          }


          const results =
            await Promise.all(
              requests
            );


          setOffers(
            results[0].data
              ?.offers || []
          );


          setOrders(
            (
              results[1].data
                ?.orders || []
            ).filter(
              (order) =>
                order.buyerId ===
                user.id
            )
          );


          setInspections(
            results[2].data
              ?.requests || []
          );


          setTrucks(
            results[3]
              ?.data?.trucks ||
              []
          );
        } catch (e) {
          console.error(
            'Buyer dashboard load error:',
            e
          );

          setError(
            e.response?.data
              ?.error ||
            'Could not load your buyer dashboard.'
          );
        } finally {
          setLoading(false);
        }
      },
      [
        user?.id,
        user?.roles,
      ]
    );


  useEffect(
    () => {
      loadAll();
    },
    [loadAll]
  );


  const pendingOffers =
    offers.filter(
      (offer) =>
        [
          'PENDING',
          'COUNTERED',
        ].includes(
          offer.status
        )
    );


  const acceptedOffers =
    offers.filter(
      (offer) =>
        offer.status ===
        'ACCEPTED'
    );


  const activeOrders =
    orders.filter(
      (order) =>
        ![
          'COMPLETED',
          'CANCELLED',
        ].includes(
          order.status
        )
    );


  const completedOrders =
    orders.filter(
      (order) =>
        order.status ===
        'COMPLETED'
    );


  const totalSpend =
    completedOrders.reduce(
      (
        sum,
        order
      ) =>
        sum +
        Number(
          order.finalPrice ||
          0
        ),
      0
    );


  const ordersWithoutTransport =
    activeOrders.filter(
      (order) =>
        !order.transportJob
    );


  function showMessage(
    text
  ) {
    setMessage(text);
    setError('');

    window.setTimeout(
      () =>
        setMessage(''),
      3000
    );
  }


  async function requestInspection(
    order
  ) {
    if (!order?.listingId) {
      return;
    }

    setBusyInspection(
      order.id
    );

    setError('');

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

      showMessage(
        'Inspection request created. Registered inspectors can accept it.'
      );

      await loadAll();

      setActiveTab(
        'inspections'
      );
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not request inspection.'
      );
    } finally {
      setBusyInspection('');
    }
  }


  function inspectionForOrder(
    order
  ) {
    return inspections.filter(
      (item) =>
        item.listingId ===
          order.listingId ||
        item.listing?.id ===
          order.listingId
    );
  }


  return (
    <main className="section">
      <div className="container-wide">

        <section>
          <span className="sd-eyebrow">
            BUYER DASHBOARD
          </span>

          <h1>
            Your offers, orders and
            deliveries in one place.
          </h1>

          <p
            className="sd-muted"
            style={{
              maxWidth: 780,
            }}
          >
            Track negotiations,
            inspect purchased
            produce, arrange
            transport, and confirm
            delivery.
          </p>


          <div className="sd-actions">

            <Link
              to="/listings"
              className="sd-btn sd-btn-primary"
            >
              Browse listings
            </Link>

            <Link
              to="/digital"
              className="sd-btn sd-btn-outline"
            >
              Browse digital
            </Link>

          </div>


          <div className="sd-stat-grid">

            <div className="sd-stat">
              <span>
                PENDING OFFERS
              </span>

              <b>
                {
                  pendingOffers.length
                }
              </b>
            </div>


            <div className="sd-stat">
              <span>
                ACCEPTED OFFERS
              </span>

              <b>
                {
                  acceptedOffers.length
                }
              </b>
            </div>


            <div className="sd-stat">
              <span>
                ACTIVE ORDERS
              </span>

              <b>
                {
                  activeOrders.length
                }
              </b>
            </div>


            <div className="sd-stat">
              <span>
                TOTAL SPEND (ETB)
              </span>

              <b>
                {
                  totalSpend.toLocaleString()
                }
              </b>
            </div>

          </div>
        </section>


        {message && (
          <div className="alert success">
            {message}
          </div>
        )}


        {error && (
          <div className="alert error">
            {error}
          </div>
        )}


        <section>

          <div className="sd-tabs">

            {TABS.map(
              (tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={
                    `sd-tab ${
                      activeTab ===
                      tab.id
                        ? 'sd-active'
                        : ''
                    }`
                  }
                  onClick={() =>
                    setActiveTab(
                      tab.id
                    )
                  }
                >
                  {tab.label}
                </button>
              )
            )}

          </div>


          {loading ? (

            <div className="sd-panel">
              Loading your buyer
              workspace…
            </div>

          ) : (

            <>

              {/* OFFERS */}

              {activeTab ===
                'offers' && (

                <div className="sd-panel sd-table-wrap">

                  <div className="sd-toolbar">
                    <div>
                      <span className="sd-eyebrow">
                        NEGOTIATIONS
                      </span>

                      <h2>
                        Offers I've made
                      </h2>
                    </div>
                  </div>


                  <table className="sd-table">

                    <thead>
                      <tr>
                        <th>
                          Listing
                        </th>

                        <th>
                          My Offer
                        </th>

                        <th>
                          Status
                        </th>

                        <th>
                          Action
                        </th>
                      </tr>
                    </thead>


                    <tbody>

                      {offers.map(
                        (offer) => {

                          const order =
                            orders.find(
                              (item) =>
                                item.listingId ===
                                offer.listingId
                            );

                          return (
                            <tr
                              key={
                                offer.id
                              }
                            >

                              <td>
                                {
                                  offer
                                    .listing
                                    ?.title ||
                                  offer
                                    .listing
                                    ?.cropType ||
                                  'Listing'
                                }
                              </td>


                              <td>
                                {
                                  money(
                                    offer.amount
                                  )
                                }
                              </td>


                              <td>
                                <span
                                  className={
                                    `sd-badge ${
                                      badgeClass(
                                        offer.status
                                      )
                                    }`
                                  }
                                >
                                  {
                                    offer.status
                                  }
                                </span>
                              </td>


                              <td>

                                {
                                  offer.status ===
                                    'ACCEPTED' &&
                                  order ? (

                                    <Link
                                      className="sd-btn sd-btn-primary"
                                      to={`/orders/${order.id}`}
                                    >
                                      View Order
                                    </Link>

                                  ) : (

                                    <Link
                                      className="sd-btn sd-btn-outline"
                                      to={`/listings/${offer.listingId}`}
                                    >
                                      View Listing
                                    </Link>

                                  )
                                }

                              </td>

                            </tr>
                          );
                        }
                      )}


                      {!offers.length && (
                        <tr>
                          <td colSpan="4">
                            No offers yet.{' '}

                            <Link to="/listings">
                              Browse listings
                            </Link>
                            .
                          </td>
                        </tr>
                      )}

                    </tbody>

                  </table>

                </div>
              )}


              {/* ORDERS */}

              {activeTab ===
                'orders' && (

                <div className="sd-panel sd-table-wrap">

                  <div className="sd-toolbar">
                    <div>
                      <span className="sd-eyebrow">
                        ORDERS
                      </span>

                      <h2>
                        My purchases
                      </h2>
                    </div>
                  </div>


                  <table className="sd-table">

                    <thead>
                      <tr>
                        <th>
                          Order
                        </th>

                        <th>
                          Produce
                        </th>

                        <th>
                          Value
                        </th>

                        <th>
                          Status
                        </th>

                        <th>
                          Inspection
                        </th>

                        <th>
                          Transport
                        </th>

                        <th>
                          Actions
                        </th>
                      </tr>
                    </thead>


                    <tbody>

                      {orders.map(
                        (order) => {

                          const orderInspections =
                            inspectionForOrder(
                              order
                            );

                          const hasInspection =
                            orderInspections.some(
                              (item) =>
                                item.status !==
                                'CANCELLED'
                            );

                          return (
                            <tr
                              key={
                                order.id
                              }
                            >

                              <td>
                                {
                                  shortId(
                                    order.id
                                  )
                                }
                              </td>


                              <td>
                                {
                                  order
                                    .listing
                                    ?.title ||
                                  order
                                    .listing
                                    ?.cropType ||
                                  'Produce'
                                }
                              </td>


                              <td>
                                {
                                  money(
                                    order.finalPrice
                                  )
                                }
                              </td>


                              <td>
                                <span
                                  className={
                                    `sd-badge ${
                                      badgeClass(
                                        order.status
                                      )
                                    }`
                                  }
                                >
                                  {
                                    order.status
                                  }
                                </span>
                              </td>


                              <td>
                                {
                                  hasInspection
                                    ? orderInspections[0]
                                        ?.status
                                    : 'Not requested'
                                }
                              </td>


                              <td>
                                {
                                  order.transportJob
                                    ? order
                                        .transportJob
                                        .status
                                    : 'Not arranged'
                                }
                              </td>


                              <td>

                                <div
                                  style={{
                                    display:
                                      'flex',
                                    gap: 8,
                                    flexWrap:
                                      'wrap',
                                  }}
                                >

                                  <Link
                                    className="sd-btn sd-btn-primary"
                                    to={`/orders/${order.id}`}
                                  >
                                    View Order
                                  </Link>


                                  {
                                    order.status !==
                                      'COMPLETED' &&
                                    order.status !==
                                      'CANCELLED' &&
                                    !hasInspection && (

                                      <button
                                        className="sd-btn sd-btn-outline"
                                        disabled={
                                          busyInspection ===
                                          order.id
                                        }
                                        onClick={() =>
                                          requestInspection(
                                            order
                                          )
                                        }
                                      >
                                        {
                                          busyInspection ===
                                          order.id
                                            ? 'Requesting…'
                                            : 'Request Inspection'
                                        }
                                      </button>

                                    )
                                  }


                                  {
                                    !order.transportJob &&
                                    ![
                                      'COMPLETED',
                                      'CANCELLED',
                                    ].includes(
                                      order.status
                                    ) && (

                                      <Link
                                        className="sd-btn sd-btn-outline"
                                        to={`/orders/${order.id}/transport`}
                                      >
                                        Arrange Transport
                                      </Link>

                                    )
                                  }

                                </div>

                              </td>

                            </tr>
                          );
                        }
                      )}


                      {!orders.length && (
                        <tr>
                          <td colSpan="7">
                            No orders yet.
                          </td>
                        </tr>
                      )}

                    </tbody>

                  </table>

                </div>
              )}


              {/* INSPECTIONS */}

              {activeTab ===
                'inspections' && (

                <div>

                  <div
                    className="sd-panel"
                    style={{
                      marginBottom:
                        16,
                    }}
                  >
                    <span className="sd-eyebrow">
                      QUALITY VERIFICATION
                    </span>

                    <h2>
                      Inspections for
                      your purchases
                    </h2>

                    <p className="sd-muted">
                      Inspectors verify
                      quantity and
                      condition.
                      Inspectors never
                      arrange transport.
                    </p>
                  </div>


                  {orders.map(
                    (order) => {

                      const items =
                        inspectionForOrder(
                          order
                        );

                      return (
                        <div
                          className="sd-panel"
                          key={order.id}
                          style={{
                            marginBottom:
                              12,
                          }}
                        >

                          <div className="row-between">

                            <div>

                              <h3>
                                {
                                  order
                                    .listing
                                    ?.title ||
                                  order
                                    .listing
                                    ?.cropType ||
                                  'Produce'
                                }
                              </h3>

                              <p className="sd-muted">
                                Order{' '}
                                {
                                  shortId(
                                    order.id
                                  )
                                }
                                {' · '}
                                {
                                  order
                                    .listing
                                    ?.location ||
                                  'Location not provided'
                                }
                              </p>

                            </div>


                            {
                              !items.some(
                                (item) =>
                                  item.status !==
                                  'CANCELLED'
                              ) &&
                              ![
                                'COMPLETED',
                                'CANCELLED',
                              ].includes(
                                order.status
                              ) && (

                                <button
                                  className="sd-btn sd-btn-primary"
                                  disabled={
                                    busyInspection ===
                                    order.id
                                  }
                                  onClick={() =>
                                    requestInspection(
                                      order
                                    )
                                  }
                                >
                                  {
                                    busyInspection ===
                                    order.id
                                      ? 'Requesting…'
                                      : 'Request Inspection'
                                  }
                                </button>

                              )
                            }

                          </div>


                          {
                            items.length
                              ? items.map(
                                  (
                                    item
                                  ) => (

                                    <div
                                      className="sd-notice"
                                      key={
                                        item.id
                                      }
                                      style={{
                                        marginTop:
                                          12,
                                      }}
                                    >

                                      <strong>
                                        {
                                          item.mode?.replaceAll(
                                            '_',
                                            ' '
                                          )
                                        }
                                      </strong>


                                      <span
                                        className={
                                          `sd-badge ${
                                            badgeClass(
                                              item.status
                                            )
                                          }`
                                        }
                                        style={{
                                          marginLeft:
                                            8,
                                        }}
                                      >
                                        {
                                          item.status
                                        }
                                      </span>


                                      <p
                                        className="sd-muted"
                                        style={{
                                          marginBottom:
                                            0,
                                        }}
                                      >
                                        {
                                          item.inspector
                                            ? `Inspector: ${item.inspector.name}`
                                            : 'Waiting for a registered inspector to accept this request.'
                                        }

                                        {
                                          item.report
                                            ? ` · Verified quantity: ${item.report.quantity} ${order.listing?.unit || ''}`
                                            : ''
                                        }
                                      </p>

                                    </div>

                                  )
                                )
                              : (

                                <p className="sd-muted">
                                  No inspection
                                  request yet.
                                </p>

                              )
                          }

                        </div>
                      );
                    }
                  )}


                  {!orders.length && (
                    <div className="sd-panel">
                      Inspection requests
                      become available
                      here after you
                      have an order.
                    </div>
                  )}

                </div>
              )}


              {/* TRANSPORT */}

              {activeTab ===
                'transport' && (

                <div>

                  <div
                    className="sd-panel"
                    style={{
                      marginBottom:
                        16,
                    }}
                  >

                    <span className="sd-eyebrow">
                      PARTY-CONTROLLED TRANSPORT
                    </span>

                    <h2>
                      Arrange transport
                      for an order
                    </h2>

                    <p className="sd-muted">
                      The buyer or seller
                      arranges transport.
                      Inspectors do not
                      arrange trucks.
                    </p>

                  </div>


                  {
                    ordersWithoutTransport.map(
                      (order) => (

                        <div
                          className="sd-panel"
                          key={order.id}
                          style={{
                            marginBottom:
                              12,
                          }}
                        >

                          <div className="row-between">

                            <div>

                              <h3>
                                {
                                  order
                                    .listing
                                    ?.title ||
                                  order
                                    .listing
                                    ?.cropType ||
                                  'Produce'
                                }
                              </h3>

                              <p className="sd-muted">
                                Order{' '}
                                {
                                  shortId(
                                    order.id
                                  )
                                }
                                {' · '}
                                {
                                  order
                                    .listing
                                    ?.location ||
                                  'Pickup location not provided'
                                }
                              </p>

                            </div>


                            <Link
                              className="sd-btn sd-btn-primary"
                              to={`/orders/${order.id}/transport`}
                            >
                              Arrange Transport
                            </Link>

                          </div>

                        </div>

                      )
                    )
                  }


                  {!ordersWithoutTransport.length && (
                    <div className="sd-panel">
                      No active orders are
                      waiting for buyer
                      transport
                      arrangement.
                    </div>
                  )}


                  <div
                    className="sd-panel"
                    style={{
                      marginTop:
                        16,
                    }}
                  >

                    <h3>
                      Your transport
                      records
                    </h3>


                    {
                      orders
                        .filter(
                          (order) =>
                            order.transportJob
                        )
                        .map(
                          (order) => (

                            <div
                              className="sd-notice"
                              key={
                                order.id
                              }
                              style={{
                                marginTop:
                                  10,
                              }}
                            >

                              <strong>
                                {
                                  order
                                    .listing
                                    ?.title ||
                                  order
                                    .listing
                                    ?.cropType ||
                                  'Produce'
                                }
                              </strong>


                              <span
                                className="sd-badge sd-blue"
                                style={{
                                  marginLeft:
                                    8,
                                }}
                              >
                                {
                                  order
                                    .transportJob
                                    .status
                                }
                              </span>


                              <p
                                className="sd-muted"
                                style={{
                                  marginBottom:
                                    0,
                                }}
                              >
                                {
                                  order
                                    .transportJob
                                    .pickupLocation
                                }

                                {' → '}

                                {
                                  order
                                    .transportJob
                                    .destination
                                }
                              </p>


                              <Link
                                className="sd-btn sd-btn-outline"
                                to={`/orders/${order.id}/transport`}
                                style={{
                                  marginTop:
                                    8,
                                }}
                              >
                                View Transport
                              </Link>

                            </div>

                          )
                        )
                    }


                    {!orders.some(
                      (order) =>
                        order.transportJob
                    ) && (
                      <p className="sd-muted">
                        No transport
                        records yet.
                      </p>
                    )}

                  </div>


                  {
                    user?.roles?.includes(
                      'TRUCK_OWNER'
                    ) && (

                      <div
                        className="sd-panel"
                        style={{
                          marginTop:
                            16,
                        }}
                      >

                        <h3>
                          Your available
                          trucks
                        </h3>


                        {
                          trucks
                            .filter(
                              (truck) =>
                                truck.availability ===
                                'AVAILABLE'
                            )
                            .map(
                              (truck) => (

                                <div
                                  className="sd-notice"
                                  key={
                                    truck.id
                                  }
                                  style={{
                                    marginTop:
                                      8,
                                  }}
                                >

                                  <strong>
                                    {
                                      truck.registration
                                    }
                                  </strong>

                                  {' · '}

                                  {
                                    truck.truckType
                                  }

                                  {' · '}

                                  {
                                    truck.capacity
                                  }
                                  t

                                  {' · '}

                                  {
                                    truck.operatingArea
                                  }

                                </div>

                              )
                            )
                        }


                        {!trucks.filter(
                          (truck) =>
                            truck.availability ===
                            'AVAILABLE'
                        ).length && (
                          <p className="sd-muted">
                            No available
                            registered
                            truck.
                          </p>
                        )}

                      </div>

                    )
                  }

                </div>
              )}

            </>
          )}

        </section>

      </div>
    </main>
  );
}
