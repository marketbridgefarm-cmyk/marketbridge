import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/api";
import { useAuth } from "../context/AuthContext";

export default function BuyerDashboard() {
  const { user } = useAuth();

  const [offers, setOffers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [inspections, setInspections] = useState([]);
  const [trucks, setTrucks] = useState([]);

  const [activeTab, setActiveTab] = useState("offers");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(
    async (silent = false) => {
      if (!user?.id) {
        return;
      }

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError("");

      try {
        /*
          Load the critical buyer data independently.

          Offers and orders are more important than inspections.
          A failure in inspections must NOT blank the dashboard.
        */
        const [offersResult, ordersResult] = await Promise.allSettled([
          api.get("/offers/mine"),
          api.get("/orders"),
        ]);

        let hadCriticalError = false;

        if (offersResult.status === "fulfilled") {
          const data = offersResult.value?.data;

          setOffers(
            Array.isArray(data)
              ? data
              : Array.isArray(data?.offers)
                ? data.offers
                : []
          );
        } else {
          hadCriticalError = true;
          console.error("Failed to load offers:", offersResult.reason);
        }

        if (ordersResult.status === "fulfilled") {
          const data = ordersResult.value?.data;

          setOrders(
            Array.isArray(data)
              ? data
              : Array.isArray(data?.orders)
                ? data.orders
                : []
          );
        } else {
          hadCriticalError = true;
          console.error("Failed to load orders:", ordersResult.reason);
        }

        /*
          Inspection data is optional.
        */
        try {
          const inspectionResponse = await api.get("/inspections/mine");

          const data = inspectionResponse?.data;

          setInspections(
            Array.isArray(data)
              ? data
              : Array.isArray(data?.inspections)
                ? data.inspections
                : []
          );
        } catch (inspectionError) {
          console.warn(
            "Inspection endpoint unavailable:",
            inspectionError
          );

          /*
            Do not destroy the dashboard because inspection loading
            failed.
          */
          setInspections([]);
        }

        /*
          Transport/truck information is optional.
        */
        try {
          const truckResponse = await api.get("/transport/trucks/mine");

          const data = truckResponse?.data;

          setTrucks(
            Array.isArray(data)
              ? data
              : Array.isArray(data?.trucks)
                ? data.trucks
                : []
          );
        } catch (truckError) {
          console.warn(
            "Truck information unavailable:",
            truckError
          );

          setTrucks([]);
        }

        if (hadCriticalError) {
          setError(
            "Some dashboard information could not be loaded. Please refresh."
          );
        }
      } catch (err) {
        console.error("Buyer dashboard error:", err);

        setError(
          err?.response?.data?.error ||
            err?.message ||
            "Failed to load buyer dashboard"
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user?.id]
  );


  useEffect(() => {
    loadDashboard(false);
  }, [loadDashboard]);


  /*
    Automatically refresh every 10 seconds.

    This means the buyer does not need to logout/login after the
    seller accepts the offer.
  */
  useEffect(() => {
    if (!user?.id) {
      return undefined;
    }

    const timer = setInterval(() => {
      loadDashboard(true);
    }, 10000);

    return () => clearInterval(timer);
  }, [user?.id, loadDashboard]);


  const buyerOrders = useMemo(() => {
    return orders.filter((order) => {
      return !order.buyerId || order.buyerId === user?.id;
    });
  }, [orders, user?.id]);


  const acceptedOffers = useMemo(() => {
    return offers.filter(
      (offer) => offer.status === "ACCEPTED"
    );
  }, [offers]);


  const pendingOffers = useMemo(() => {
    return offers.filter(
      (offer) =>
        offer.status === "PENDING" ||
        offer.status === "COUNTERED"
    );
  }, [offers]);


  const activeInspections = useMemo(() => {
    return inspections.filter(
      (inspection) =>
        inspection.status !== "COMPLETED" &&
        inspection.status !== "CANCELLED"
    );
  }, [inspections]);


  const formatMoney = (value) => {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
      return "—";
    }

    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };


  const getListingTitle = (item) => {
    return (
      item?.listing?.title ||
      item?.listing?.name ||
      item?.title ||
      "Listing"
    );
  };


  const getListingImage = (item) => {
    return (
      item?.listing?.imageUrl ||
      item?.listing?.images?.[0]?.url ||
      item?.listing?.images?.[0] ||
      null
    );
  };


  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="sd-panel">
          <p>Loading your buyer dashboard...</p>
        </div>
      </div>
    );
  }


  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">

        <div className="dashboard-header">
          <div>
            <div className="sd-eyebrow">
              MARKETBRIDGE
            </div>

            <h1>Buyer Dashboard</h1>

            <p>
              Welcome{user?.name ? `, ${user.name}` : ""}.
              Manage your offers, purchases, inspections and transport.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => loadDashboard(true)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>


        {error && (
          <div className="alert alert-warning">
            {error}
          </div>
        )}


        {/* IMPORTANT ACCEPTED OFFER NOTICE */}
        {acceptedOffers.length > 0 && (
          <div className="alert alert-success">
            <strong>Offer accepted.</strong>{" "}
            {acceptedOffers.map((offer) => {
              const order = offer.order;

              return (
                <div key={offer.id} style={{ marginTop: 8 }}>
                  <span>
                    {getListingTitle(offer)}
                  </span>

                  {order ? (
                    <>
                      {" — "}
                      <strong>Order created.</strong>{" "}

                      <Link
                        to={`/orders/${order.id}`}
                        className="btn btn-sm btn-primary"
                      >
                        View Order
                      </Link>
                    </>
                  ) : (
                    <span>
                      {" — "}Creating your order...
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}


        {/* STATS */}
        <div className="dashboard-stats">

          <div className="sd-panel">
            <div className="sd-eyebrow">
              OFFERS
            </div>

            <h2>{offers.length}</h2>

            <p>Total offers</p>
          </div>


          <div className="sd-panel">
            <div className="sd-eyebrow">
              PENDING
            </div>

            <h2>{pendingOffers.length}</h2>

            <p>Offers awaiting response</p>
          </div>


          <div className="sd-panel">
            <div className="sd-eyebrow">
              PURCHASES
            </div>

            <h2>{buyerOrders.length}</h2>

            <p>Your orders</p>
          </div>


          <div className="sd-panel">
            <div className="sd-eyebrow">
              INSPECTIONS
            </div>

            <h2>{activeInspections.length}</h2>

            <p>Active inspections</p>
          </div>

        </div>


        {/* TABS */}
        <div className="sd-panel">

          <div className="sd-tabs">

            <button
              type="button"
              className={
                activeTab === "offers"
                  ? "sd-tab active"
                  : "sd-tab"
              }
              onClick={() => setActiveTab("offers")}
            >
              Offers
            </button>


            <button
              type="button"
              className={
                activeTab === "orders"
                  ? "sd-tab active"
                  : "sd-tab"
              }
              onClick={() => setActiveTab("orders")}
            >
              Orders
            </button>


            <button
              type="button"
              className={
                activeTab === "inspections"
                  ? "sd-tab active"
                  : "sd-tab"
              }
              onClick={() => setActiveTab("inspections")}
            >
              Inspections
            </button>


            <button
              type="button"
              className={
                activeTab === "transport"
                  ? "sd-tab active"
                  : "sd-tab"
              }
              onClick={() => setActiveTab("transport")}
            >
              Transport
            </button>

          </div>


          {/* OFFERS */}
          {activeTab === "offers" && (
            <div>

              <h2>My Offers</h2>

              {offers.length === 0 ? (
                <div className="empty-state">
                  <p>You have not made any offers yet.</p>

                  <Link
                    to="/listings"
                    className="btn btn-primary"
                  >
                    Browse Listings
                  </Link>
                </div>
              ) : (
                <div className="dashboard-list">

                  {offers.map((offer) => {
                    const image = getListingImage(offer);

                    return (
                      <div
                        className="dashboard-list-item"
                        key={offer.id}
                      >

                        {image && (
                          <img
                            src={image}
                            alt={getListingTitle(offer)}
                            className="dashboard-thumb"
                          />
                        )}

                        <div className="dashboard-list-content">

                          <h3>
                            {getListingTitle(offer)}
                          </h3>

                          <p>
                            Your offer:{" "}
                            <strong>
                              {formatMoney(offer.amount)}
                            </strong>
                          </p>

                          {offer.counterAmount != null && (
                            <p>
                              Counter offer:{" "}
                              <strong>
                                {formatMoney(
                                  offer.counterAmount
                                )}
                              </strong>
                            </p>
                          )}

                          <p>
                            Status:{" "}
                            <strong>
                              {offer.status}
                            </strong>
                          </p>

                        </div>


                        <div className="dashboard-list-actions">

                          {offer.status === "ACCEPTED" && (
                            offer.order ? (
                              <Link
                                to={`/orders/${offer.order.id}`}
                                className="btn btn-primary"
                              >
                                View Order
                              </Link>
                            ) : (
                              <span className="badge badge-success">
                                Order being created
                              </span>
                            )
                          )}

                        </div>

                      </div>
                    );
                  })}

                </div>
              )}

            </div>
          )}


          {/* ORDERS */}
          {activeTab === "orders" && (
            <div>

              <h2>My Orders</h2>

              {buyerOrders.length === 0 ? (
                <div className="empty-state">
                  <p>
                    No orders yet. When a seller accepts one
                    of your offers, your order will appear here.
                  </p>
                </div>
              ) : (
                <div className="dashboard-list">

                  {buyerOrders.map((order) => {

                    const title =
                      order?.listing?.title ||
                      order?.listing?.name ||
                      "Order";

                    return (
                      <div
                        className="dashboard-list-item"
                        key={order.id}
                      >

                        <div className="dashboard-list-content">

                          <h3>{title}</h3>

                          <p>
                            Order ID:{" "}
                            <strong>
                              {order.id}
                            </strong>
                          </p>

                          <p>
                            Price:{" "}
                            <strong>
                              {formatMoney(
                                order.finalPrice
                              )}
                            </strong>
                          </p>

                          <p>
                            Status:{" "}
                            <strong>
                              {order.status}
                            </strong>
                          </p>

                        </div>


                        <div className="dashboard-list-actions">

                          <Link
                            to={`/orders/${order.id}`}
                            className="btn btn-primary"
                          >
                            View Order
                          </Link>


                          {order.status !== "CANCELLED" &&
                            order.status !== "COMPLETED" && (
                              <Link
                                to={`/orders/${order.id}/transport`}
                                className="btn btn-secondary"
                              >
                                Arrange Transport
                              </Link>
                            )}

                        </div>

                      </div>
                    );
                  })}

                </div>
              )}

            </div>
          )}


          {/* INSPECTIONS */}
          {activeTab === "inspections" && (
            <div>

              <h2>Inspections</h2>

              {inspections.length === 0 ? (
                <div className="empty-state">
                  <p>
                    No inspection requests yet.
                  </p>

                  {buyerOrders.length > 0 && (
                    <p>
                      Open an order to request an inspection.
                    </p>
                  )}
                </div>
              ) : (
                <div className="dashboard-list">

                  {inspections.map((inspection) => (

                    <div
                      className="dashboard-list-item"
                      key={inspection.id}
                    >

                      <div className="dashboard-list-content">

                        <h3>
                          {getListingTitle(inspection)}
                        </h3>

                        <p>
                          Mode:{" "}
                          <strong>
                            {inspection.mode || "—"}
                          </strong>
                        </p>

                        <p>
                          Status:{" "}
                          <strong>
                            {inspection.status}
                          </strong>
                        </p>

                        {inspection.inspector && (
                          <p>
                            Inspector:{" "}
                            {inspection.inspector.name ||
                              inspection.inspector.email}
                          </p>
                        )}

                      </div>

                    </div>

                  ))}

                </div>
              )}

            </div>
          )}


          {/* TRANSPORT */}
          {activeTab === "transport" && (
            <div>

              <h2>Transport</h2>

              {buyerOrders.length === 0 ? (
                <div className="empty-state">
                  <p>
                    Transport becomes available after an
                    offer is accepted and an order is created.
                  </p>
                </div>
              ) : (
                <>
                  <p>
                    Choose an order below to arrange transport.
                    Transport is separate from inspection.
                  </p>

                  <div className="dashboard-list">

                    {buyerOrders
                      .filter(
                        (order) =>
                          order.status !== "CANCELLED" &&
                          order.status !== "COMPLETED"
                      )
                      .map((order) => (

                        <div
                          className="dashboard-list-item"
                          key={order.id}
                        >

                          <div className="dashboard-list-content">

                            <h3>
                              {order?.listing?.title ||
                                order?.listing?.name ||
                                "Order"}
                            </h3>

                            <p>
                              Order status:{" "}
                              <strong>
                                {order.status}
                              </strong>
                            </p>

                          </div>


                          <div className="dashboard-list-actions">

                            <Link
                              to={`/orders/${order.id}/transport`}
                              className="btn btn-primary"
                            >
                              Find Transport
                            </Link>

                          </div>

                        </div>

                      ))}

                  </div>

                  {trucks.length > 0 && (
                    <p style={{ marginTop: 16 }}>
                      You have access to {trucks.length} transport
                      option{trucks.length === 1 ? "" : "s"}.
                    </p>
                  )}
                </>
              )}

            </div>
          )}

        </div>

      </div>
    </div>
  );
}
