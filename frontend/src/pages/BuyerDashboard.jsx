import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const TABS = [
  { id: 'offers', label: 'My Offers' },
  { id: 'orders', label: 'My Orders' },
  { id: 'transport', label: 'Transport' },
];

const EMPTY_TRANSPORT_FORM = {
  party: 'Buyer',
  destination: '',
  capacity: '',
  requirements: '',
  truckId: '',
};

function formatETB(value) {
  const number = Number(value || 0);
  return `${number.toLocaleString()} ETB`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

function transportLabel(job) {
  if (!job) return 'Not arranged';

  const party =
    job.arrangingParty === 'JOINT'
      ? 'Joint'
      : job.arrangingParty === 'BUYER'
        ? 'Buyer'
        : 'Seller';

  const method =
    job.method === 'OWN_TRUCK'
      ? 'Own truck'
      : 'Hired transporter';

  return `${party} — ${method}`;
}

function statusClass(status) {
  if (status === 'COMPLETED' || status === 'DELIVERED') return '';
  if (status === 'CANCELLED' || status === 'DISPUTED') return 'sd-warn';
  return 'sd-blue';
}

export default function BuyerDashboard() {
  const { user } = useAuth();

  const [offers, setOffers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [trucks, setTrucks] = useState([]);

  const [activeTab, setActiveTab] = useState('offers');

  const [toastMsg, setToastMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [transportTarget, setTransportTarget] = useState(null);
  const [transportForm, setTransportForm] = useState(EMPTY_TRANSPORT_FORM);

  const transportModalRef = useRef(null);

  const toast = useCallback((msg) => {
    setToastMsg(msg);

    window.setTimeout(() => {
      setToastMsg('');
    }, 2500);
  }, []);

  /*
   * Load buyer data.
   *
   * Orders are filtered again on the frontend for safety, although
   * /orders already returns orders belonging to the authenticated user.
   */
  const loadAll = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);

    try {
      const requests = [
        api.get('/offers/mine'),
        api.get('/orders'),
      ];

      /*
       * A buyer can also be a TRUCK_OWNER. In that case the same
       * account may have trucks that can be used for OWN_TRUCK.
       *
       * If the account is not a TRUCK_OWNER, don't call the protected
       * truck-owner endpoint.
       */
      if (user.roles?.includes('TRUCK_OWNER')) {
        requests.push(api.get('/transport/trucks/mine'));
      }

      const results = await Promise.all(requests);

      const offersRes = results[0];
      const ordersRes = results[1];
      const trucksRes = results[2];

      setOffers(offersRes.data?.offers || []);

      const buyerOrders = (ordersRes.data?.orders || []).filter(
        (order) => order.buyerId === user.id
      );

      setOrders(buyerOrders);

      if (trucksRes) {
        setTrucks(trucksRes.data?.trucks || []);
      } else {
        setTrucks([]);
      }
    } catch (err) {
      console.error('Buyer dashboard load error:', err);
      toast(
        err.response?.data?.error ||
          'Could not load your buyer dashboard.'
      );
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.roles, toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const pendingOffers = offers.filter(
    (offer) =>
      offer.status === 'PENDING' ||
      offer.status === 'COUNTERED'
  );

  const acceptedOffers = offers.filter(
    (offer) => offer.status === 'ACCEPTED'
  );

  const activeOrders = orders.filter(
    (order) =>
      !['COMPLETED', 'CANCELLED'].includes(order.status)
  );

  const completedOrders = orders.filter(
    (order) => order.status === 'COMPLETED'
  );

  const totalSpend = completedOrders.reduce(
    (sum, order) => sum + Number(order.finalPrice || 0),
    0
  );

  const ordersWithoutTransport = orders.filter(
    (order) => !order.transportJob
  );

  /*
   * Open transport modal.
   *
   * method:
   *   hire = HIRE_TRANSPORTER
   *   own  = OWN_TRUCK
   */
  function openTransportModal(order, method) {
    if (!order) return;

    const defaultDestination =
      order.destination ||
      '';

    setTransportTarget({
      order,
      method,
    });

    setTransportForm({
      ...EMPTY_TRANSPORT_FORM,
      party: 'Buyer',
      destination: defaultDestination,
    });

    window.setTimeout(() => {
      transportModalRef.current?.showModal();
    }, 0);
  }

  function closeTransportModal() {
    transportModalRef.current?.close();
    setTransportTarget(null);
    setTransportForm(EMPTY_TRANSPORT_FORM);
  }

  function handleTransportChange(event) {
    const { name, value } = event.target;

    setTransportForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  }

  /*
   * Create the transport record.
   *
   * IMPORTANT:
   *
   * Buyer -> Hire Transport:
   *   method = HIRE_TRANSPORTER
   *   truckOwnerId is NOT selected here.
   *
   * The request becomes REQUESTED and appears in the Truck Owner
   * Dashboard under "Available Jobs".
   *
   * Buyer -> Own Truck:
   *   method = OWN_TRUCK
   *   selected truckId is sent.
   */
  async function submitTransport(event) {
    event.preventDefault();

    if (!transportTarget?.order) {
      toast('No order selected.');
      return;
    }

    const order = transportTarget.order;

    if (!transportForm.destination.trim()) {
      toast('Please enter the delivery destination.');
      return;
    }

    if (
      transportTarget.method === 'own' &&
      !transportForm.truckId
    ) {
      toast('Please select your truck.');
      return;
    }

    const partyMap = {
      Buyer: 'BUYER',
      Seller: 'SELLER',
      'Joint-agreed': 'JOINT',
    };

    const isHire =
      transportTarget.method === 'hire';

    const method = isHire
      ? 'HIRE_TRANSPORTER'
      : 'OWN_TRUCK';

    const payload = {
      orderId: order.id,

      arrangingParty:
        partyMap[transportForm.party] || 'BUYER',

      method,

      pickupLocation:
        order.listing?.location ||
        'Farm / seller location',

      destination:
        transportForm.destination.trim(),

      load:
        order.listing?.cropType ||
        'Agricultural produce',

      requiredCapacity:
        transportForm.capacity
          ? Number(transportForm.capacity)
          : undefined,

      specialRequirements:
        transportForm.requirements.trim() ||
        undefined,
    };

    /*
     * Only OWN_TRUCK receives a truckId.
     *
     * HIRE_TRANSPORTER deliberately leaves truckId null.
     * A registered truck owner will later accept the open request.
     */
    if (!isHire) {
      payload.truckId = transportForm.truckId;
    }

    try {
      setSubmitting(true);

      await api.post('/transport', payload);

      closeTransportModal();

      toast(
        isHire
          ? 'Transport request sent to registered truck owners.'
          : 'Your own-truck transport record was created.'
      );

      await loadAll();
    } catch (err) {
      console.error('Transport creation error:', err);

      toast(
        err.response?.data?.error ||
          'Could not create transport request.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmReceipt(orderId) {
    if (!orderId) return;

    const confirmed = window.confirm(
      'Confirm that you received this order? This will mark the order as COMPLETED.'
    );

    if (!confirmed) return;

    try {
      setSubmitting(true);

      await api.patch(
        `/orders/${orderId}/confirm-receipt`
      );

      toast(
        'Receipt confirmed. Order completed.'
      );

      await loadAll();
    } catch (err) {
      console.error('Receipt confirmation error:', err);

      toast(
        err.response?.data?.error ||
          'Could not confirm receipt.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * Only orders where transport has not yet been arranged can
   * receive a new transport record.
   */
  function renderTransportButtons(order) {
    if (order.transportJob) {
      return (
        <span className="sd-muted">
          Transport already arranged
        </span>
      );
    }

    const canUseOwnTruck =
      user?.roles?.includes('TRUCK_OWNER') &&
      trucks.length > 0;

    return (
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="sd-btn sd-btn-primary"
          onClick={() =>
            openTransportModal(order, 'hire')
          }
          disabled={submitting}
        >
          Hire Transport
        </button>

        {canUseOwnTruck && (
          <button
            type="button"
            className="sd-btn sd-btn-outline"
            onClick={() =>
              openTransportModal(order, 'own')
            }
            disabled={submitting}
          >
            Use My Truck
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="sd-dashboard">
      {/* =========================================================
          HEADER / SUMMARY
      ========================================================== */}

      <section>
        <span className="sd-eyebrow">
          BUYER DASHBOARD
        </span>

        <h1>
          Your offers, orders and deliveries in one place.
        </h1>

        <p
          className="sd-muted"
          style={{ maxWidth: 780 }}
        >
          Track negotiations, manage purchases, arrange
          transport through MarketBridge, and confirm receipt
          when your produce arrives.
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
            <span>PENDING OFFERS</span>
            <b>{pendingOffers.length}</b>
          </div>

          <div className="sd-stat">
            <span>ACCEPTED OFFERS</span>
            <b>{acceptedOffers.length}</b>
          </div>

          <div className="sd-stat">
            <span>ACTIVE ORDERS</span>
            <b>{activeOrders.length}</b>
          </div>

          <div className="sd-stat">
            <span>TOTAL SPEND (ETB)</span>
            <b>
              {totalSpend.toLocaleString()}
            </b>
          </div>
        </div>
      </section>

      {/* =========================================================
          MAIN TABS
      ========================================================== */}

      <section>
        <div className="sd-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`sd-tab ${
                activeTab === tab.id
                  ? 'sd-active'
                  : ''
              }`}
              onClick={() =>
                setActiveTab(tab.id)
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* =======================================================
            OFFERS
        ======================================================== */}

        {activeTab === 'offers' && (
          <div>
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

            <div className="sd-panel sd-table-wrap">
              {loading ? (
                <p>Loading offers...</p>
              ) : (
                <table className="sd-table">
                  <thead>
                    <tr>
                      <th>Produce</th>
                      <th>My Offer</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>

                  <tbody>
                    {offers.map((offer) => (
                      <tr key={offer.id}>
                        <td>
                          {offer.listing?.cropType ||
                            'Produce'}
                        </td>

                        <td>
                          {formatETB(offer.amount)}

                          {offer.counterAmount != null && (
                            <>
                              {' '}
                              <span className="sd-muted">
                                (countered:{' '}
                                {formatETB(
                                  offer.counterAmount
                                )}
                                )
                              </span>
                            </>
                          )}
                        </td>

                        <td>
                          <span
                            className={`sd-badge ${
                              statusClass(
                                offer.status
                              )
                            }`}
                          >
                            {offer.status}
                          </span>
                        </td>

                        <td>
                          <Link
                            to={`/listings/${offer.listingId}`}
                            className="sd-btn sd-btn-outline"
                          >
                            View listing
                          </Link>
                        </td>
                      </tr>
                    ))}

                    {offers.length === 0 && (
                      <tr>
                        <td colSpan="4">
                          No offers yet.{' '}
                          <Link to="/listings">
                            Browse listings
                          </Link>{' '}
                          to make one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* =======================================================
            ORDERS
        ======================================================== */}

        {activeTab === 'orders' && (
          <div>
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

            <div className="sd-panel sd-table-wrap">
              {loading ? (
                <p>Loading orders...</p>
              ) : (
                <table className="sd-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Produce</th>
                      <th>Seller</th>
                      <th>Value</th>
                      <th>Transport</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          {shortId(order.id)}
                        </td>

                        <td>
                          {order.listing?.cropType ||
                            'Produce'}
                        </td>

                        <td>
                          {order.seller?.name ||
                            '—'}
                        </td>

                        <td>
                          {formatETB(
                            order.finalPrice
                          )}
                        </td>

                        <td>
                          {order.transportJob
                            ? transportLabel(
                                order.transportJob
                              )
                            : 'Not arranged'}
                        </td>

                        <td>
                          <span
                            className={`sd-badge ${statusClass(
                              order.status
                            )}`}
                          >
                            {order.status}
                          </span>
                        </td>

                        <td>
                          {renderTransportButtons(
                            order
                          )}

                          {order.status ===
                            'DELIVERED' && (
                            <button
                              type="button"
                              className="sd-btn sd-btn-primary"
                              style={{
                                marginTop: 6,
                              }}
                              onClick={() =>
                                confirmReceipt(
                                  order.id
                                )
                              }
                              disabled={submitting}
                            >
                              Confirm Receipt
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}

                    {orders.length === 0 && (
                      <tr>
                        <td colSpan="7">
                          No orders yet.{' '}
                          <Link to="/listings">
                            Browse agricultural
                            listings
                          </Link>
                          .
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* =======================================================
            TRANSPORT
        ======================================================== */}

        {activeTab === 'transport' && (
          <div>
            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">
                  TRANSPORT
                </span>

                <h2>
                  Buyer-controlled transport
                </h2>
              </div>
            </div>

            {/* Transport explanation */}

            <div
              className="sd-panel"
              style={{ marginBottom: 20 }}
            >
              <h3>
                How MarketBridge transport works
              </h3>

              <p className="sd-muted">
                Transportation is not automatically assigned
                after a purchase. You decide how the order will
                move.
              </p>

              <ul
                className="sd-muted"
                style={{
                  lineHeight: 1.8,
                  paddingLeft: 22,
                }}
              >
                <li>
                  <strong>Hire Transport:</strong>{' '}
                  MarketBridge creates a transport request
                  that registered truck owners can claim.
                </li>

                <li>
                  <strong>Use My Truck:</strong>{' '}
                  Use one of your registered trucks if your
                  account is also a Truck Owner.
                </li>

                <li>
                  <strong>Seller Arranges:</strong>{' '}
                  The seller may arrange transport separately
                  when agreed with you.
                </li>
              </ul>
            </div>

            {/* Buyer transport actions */}

            <div className="sd-flow">
              <div className="sd-panel">
                <h3>
                  🚚 Hire Transport
                </h3>

                <p className="sd-muted">
                  Send a transport request to registered
                  truck owners on MarketBridge.
                </p>

                {ordersWithoutTransport.length === 0 ? (
                  <p className="sd-muted">
                    No orders are waiting for transport.
                  </p>
                ) : (
                  ordersWithoutTransport.map(
                    (order) => (
                      <button
                        key={order.id}
                        type="button"
                        className="sd-btn sd-btn-primary"
                        style={{
                          marginTop: 8,
                          display: 'block',
                          width: '100%',
                        }}
                        onClick={() =>
                          openTransportModal(
                            order,
                            'hire'
                          )
                        }
                      >
                        {order.listing?.cropType ||
                          'Produce'}{' '}
                        — {shortId(order.id)}
                      </button>
                    )
                  )
                )}
              </div>

              <div className="sd-panel">
                <h3>
                  🚛 Use My Own Truck
                </h3>

                <p className="sd-muted">
                  Use your own registered vehicle. This option
                  does not create a hired-transporter request.
                </p>

                {!user?.roles?.includes(
                  'TRUCK_OWNER'
                ) ? (
                  <p className="sd-muted">
                    Your account is not registered as a
                    Truck Owner.
                  </p>
                ) : trucks.length === 0 ? (
                  <p className="sd-muted">
                    You have no registered trucks.
                  </p>
                ) : ordersWithoutTransport.length ===
                  0 ? (
                  <p className="sd-muted">
                    No orders are waiting for transport.
                  </p>
                ) : (
                  ordersWithoutTransport.map(
                    (order) => (
                      <button
                        key={order.id}
                        type="button"
                        className="sd-btn sd-btn-outline"
                        style={{
                          marginTop: 8,
                          display: 'block',
                          width: '100%',
                        }}
                        onClick={() =>
                          openTransportModal(
                            order,
                            'own'
                          )
                        }
                      >
                        {order.listing?.cropType ||
                          'Produce'}{' '}
                        — {shortId(order.id)}
                      </button>
                    )
                  )
                )}
              </div>

              <div className="sd-panel">
                <h3>
                  🤝 Seller Arranges
                </h3>

                <p className="sd-muted">
                  If you and the seller agree that the seller
                  will handle transportation, the seller should
                  create the transport arrangement from their
                  Seller Dashboard.
                </p>

                <p className="sd-muted">
                  The buyer does not create a fake "own truck"
                  record for the seller.
                </p>
              </div>
            </div>

            {/* Existing transport records */}

            <div
              className="sd-panel"
              style={{ marginTop: 20 }}
            >
              <div className="sd-toolbar">
                <div>
                  <span className="sd-eyebrow">
                    TRANSPORT RECORDS
                  </span>

                  <h2>
                    Current deliveries
                  </h2>
                </div>
              </div>

              {orders.filter(
                (order) => order.transportJob
              ).length === 0 ? (
                <p>
                  No transport records yet.
                </p>
              ) : (
                orders
                  .filter(
                    (order) =>
                      order.transportJob
                  )
                  .map((order) => (
                    <div
                      className="sd-notice"
                      key={order.id}
                      style={{
                        marginBottom: 10,
                      }}
                    >
                      <b>
                        Order {shortId(order.id)}
                      </b>

                      <div
                        className="sd-muted"
                        style={{
                          marginTop: 4,
                        }}
                      >
                        {order.listing?.cropType ||
                          'Produce'}{' '}
                        ·{' '}
                        {order.transportJob
                          .pickupLocation ||
                          'Pickup location'}{' '}
                        →{' '}
                        {order.transportJob
                          .destination ||
                          'Destination'}
                      </div>

                      <div
                        style={{
                          marginTop: 6,
                        }}
                      >
                        <span className="sd-badge sd-blue">
                          {
                            order.transportJob
                              .status
                          }
                        </span>{' '}
                        <span className="sd-muted">
                          {transportLabel(
                            order.transportJob
                          )}
                        </span>
                      </div>

                      {order.status ===
                        'DELIVERED' && (
                        <button
                          type="button"
                          className="sd-btn sd-btn-primary"
                          style={{
                            marginTop: 10,
                          }}
                          onClick={() =>
                            confirmReceipt(
                              order.id
                            )
                          }
                          disabled={submitting}
                        >
                          Confirm Receipt
                        </button>
                      )}
                    </div>
                  ))
              )}
            </div>
          </div>
        )}
      </section>

      {/* =========================================================
          TRANSPORT MODAL
      ========================================================== */}

      <dialog
        ref={transportModalRef}
        className="sd-dialog"
        onCancel={() => {
          setTransportTarget(null);
          setTransportForm(
            EMPTY_TRANSPORT_FORM
          );
        }}
      >
        <div className="sd-modal">
          <button
            type="button"
            className="sd-close"
            onClick={closeTransportModal}
            disabled={submitting}
          >
            ×
          </button>

          <span className="sd-eyebrow">
            TRANSPORT
          </span>

          <h2>
            {transportTarget?.method === 'hire'
              ? 'Hire Transport'
              : 'Use My Own Truck'}
          </h2>

          {transportTarget?.method === 'hire' ? (
            <p className="sd-muted">
              Your request will become an open MarketBridge
              transport job. Registered truck owners can see
              it in their Available Jobs dashboard and accept
              it.
            </p>
          ) : (
            <p className="sd-muted">
              Select one of your registered trucks. No
              transporter-hiring commission is generated for
              an own-truck arrangement.
            </p>
          )}

          <form onSubmit={submitTransport}>
            <div className="sd-form-grid">
              {/* Order */}

              <div>
                <label htmlFor="transport-order">
                  Order
                </label>

                <input
                  id="transport-order"
                  value={
                    shortId(
                      transportTarget?.order?.id
                    )
                  }
                  disabled
                />
              </div>

              {/* Produce */}

              <div>
                <label htmlFor="transport-load">
                  Load
                </label>

                <input
                  id="transport-load"
                  value={
                    transportTarget?.order?.listing
                      ?.cropType || 'Produce'
                  }
                  disabled
                />
              </div>

              {/* Arranging party */}

              <div>
                <label htmlFor="transport-party">
                  Arranging party
                </label>

                <select
                  id="transport-party"
                  name="party"
                  value={transportForm.party}
                  onChange={handleTransportChange}
                >
                  <option value="Buyer">
                    Buyer
                  </option>

                  <option value="Joint-agreed">
                    Joint-agreed
                  </option>

                  <option value="Seller">
                    Seller
                  </option>
                </select>
              </div>

              {/* Destination */}

              <div>
                <label htmlFor="transport-destination">
                  Destination
                </label>

                <input
                  id="transport-destination"
                  name="destination"
                  required
                  value={
                    transportForm.destination
                  }
                  onChange={
                    handleTransportChange
                  }
                  placeholder="Delivery destination"
                />
              </div>

              {/* Own truck selector */}

              {transportTarget?.method === 'own' && (
                <div>
                  <label htmlFor="transport-truck">
                    My truck
                  </label>

                  <select
                    id="transport-truck"
                    name="truckId"
                    required
                    value={transportForm.truckId}
                    onChange={
                      handleTransportChange
                    }
                  >
                    <option value="">
                      Select a truck
                    </option>

                    {trucks.map((truck) => (
                      <option
                        key={truck.id}
                        value={truck.id}
                      >
                        {truck.registration} —{' '}
                        {truck.truckType} —{' '}
                        {truck.capacity}t
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Capacity */}

              <div>
                <label htmlFor="transport-capacity">
                  Required capacity (tons)
                </label>

                <input
                  id="transport-capacity"
                  name="capacity"
                  type="number"
                  min="0"
                  step="0.01"
                  value={
                    transportForm.capacity
                  }
                  onChange={
                    handleTransportChange
                  }
                  placeholder="e.g. 20"
                />
              </div>

              {/* Requirements */}

              <div className="sd-full">
                <label htmlFor="transport-requirements">
                  Access / special requirements
                </label>

                <textarea
                  id="transport-requirements"
                  name="requirements"
                  rows="4"
                  value={
                    transportForm.requirements
                  }
                  onChange={
                    handleTransportChange
                  }
                  placeholder="Loading requirements, road conditions, delivery instructions, etc."
                />
              </div>
            </div>

            <div
              className="sd-modal-actions"
              style={{ marginTop: 20 }}
            >
              <button
                type="button"
                className="sd-btn sd-btn-outline"
                onClick={closeTransportModal}
                disabled={submitting}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="sd-btn sd-btn-primary"
                disabled={submitting}
              >
                {submitting
                  ? 'Saving...'
                  : transportTarget?.method ===
                    'hire'
                    ? 'Request Transport'
                    : 'Use This Truck'}
              </button>
            </div>
          </form>
        </div>
      </dialog>

      {/* =========================================================
          TOAST
      ========================================================== */}

      {toastMsg && (
        <div className="sd-toast">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
