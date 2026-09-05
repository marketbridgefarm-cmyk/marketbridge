import React, {
  useEffect,
  useState,
} from 'react';

import {
  Link,
  useParams,
} from 'react-router-dom';

import api from '../api/client';

import {
  useAuth,
} from '../context/AuthContext.jsx';


const money = (n) =>
  Number(
    n || 0
  ).toLocaleString();


export default function ListingDetail() {
  const {
    id,
  } = useParams();

  const {
    user,
  } = useAuth();


  const [
    listing,
    setListing,
  ] = useState(null);


  const [
    offerAmount,
    setOfferAmount,
  ] = useState('');


  const [
    message,
    setMessage,
  ] = useState('');


  const [
    msg,
    setMsg,
  ] = useState('');


  const [
    error,
    setError,
  ] = useState('');


  const [
    inspector,
    setInspector,
  ] = useState('');

  const [
    feeForInspector,
    setFeeForInspector,
  ] = useState('');


  async function load() {
    try {
      const response =
        await api.get(
          `/listings/${id}`
        );

      setListing(
        response.data.listing
      );
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Listing not found.'
      );
    }
  }


  useEffect(
    () => {
      load();
    },
    [id]
  );


  async function submitOffer(
    e
  ) {
    e.preventDefault();

    setError('');

    try {
      await api.post(
        '/offers',
        {
          listingId: id,
          amount:
            Number(
              offerAmount
            ),
          message,
        }
      );

      setMsg(
        'Offer submitted. Other buyers can still see this listing until an offer is accepted.'
      );

      setOfferAmount('');
      setMessage('');

      load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not submit offer'
      );
    }
  }


  async function requestInspection(
    mode
  ) {
    setError('');

    if (inspector && (!feeForInspector || Number(feeForInspector) <= 0)) {
      setError('Enter the agreed inspection fee before requesting this inspector.');
      return;
    }

    try {
      const body = {
        listingId: id,
        mode,
      };

      if (inspector) {
        body.inspectorId =
          inspector;
        body.fee = Number(feeForInspector);
      }

      await api.post(
        '/inspections',
        body
      );

      setMsg(
        'Inspection request created.'
      );

      setInspector('');
      setFeeForInspector('');
      load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not request inspection'
      );
    }
  }


  async function respondToOffer(
    offerId,
    action,
    counterAmount
  ) {
    try {
      await api.patch(
        `/offers/${offerId}`,
        {
          action,
          counterAmount:
            Number(
              counterAmount
            ),
        }
      );

      setMsg(
        `Offer ${action.toLowerCase()}ed.`
      );

      load();
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Action failed'
      );
    }
  }


  async function chooseInspector() {
    try {
      const response =
        await api.get(
          '/inspections/inspectors',
          {
            params: {
              location:
                listing.location,
            },
          }
        );

      const options =
        response.data
          .inspectors || [];


      if (!options.length) {
        setError(
          'No inspectors were found in this area.'
        );

        return;
      }


      setInspector(
        options[0].id
      );


      setMsg(
        `Inspector selected: ${options[0].name}`
      );
    } catch (e) {
      setError(
        e.response?.data
          ?.error ||
        'Could not load inspectors'
      );
    }
  }


  if (!listing) {
    return (
      <main className="section">
        <div className="container-wide loading">
          Loading listing…
        </div>
      </main>
    );
  }


  const isOwner =
    user?.id ===
    listing.sellerId;


  const isBuyer =
    user?.roles?.includes(
      'BUYER'
    ) &&
    !isOwner;


  const isAgricultural =
    listing.category ===
    'AGRICULTURAL';


  const isAvailable =
    listing.status ===
    'ACTIVE';


  return (
    <main className="section">

      <div className="container-wide">

        <Link
          className="back-link"
          to={
            isAgricultural
              ? '/agricultural'
              : '/products'
          }
        >
          ← Back to marketplace
        </Link>


        <div className="detail-grid">

          <section>

            <div className="detail-media">

              {
                listing.photos?.[0]
                  ? (

                    <img
                      src={
                        listing
                          .photos[0]
                      }
                      alt={
                        listing.title ||
                        listing.cropType
                      }
                    />

                  )
                  : (

                    <div className="media-placeholder">
                      {
                        listing.title ||
                        listing.cropType
                      }
                    </div>

                  )
              }

            </div>


            <div className="card detail-content">

              <div className="listing-meta">

                <span className="tag">
                  {
                    isAgricultural
                      ? 'AGRICULTURE'
                      : 'PRODUCT'
                  }
                </span>


                <span className="badge">
                  {
                    listing.status
                  }
                </span>

              </div>


              <h1>
                {
                  listing.title ||
                  listing.cropType
                }
              </h1>


              <p className="lead">

                {
                  Number(
                    listing.quantity
                  ).toLocaleString()
                }

                {' '}

                {
                  listing.unit
                }

                {' '}

                {
                  isAvailable
                    ? 'available'
                    : 'currently reserved / unavailable'
                }

                {' · '}

                {
                  listing.location
                }

              </p>


              <div className="detail-facts">

                <div>
                  <span>
                    Asking price
                  </span>

                  <strong>
                    {
                      money(
                        listing.askingPrice
                      )
                    } ETB
                  </strong>
                </div>


                <div>
                  <span>
                    Ready
                  </span>

                  <strong>
                    {
                      listing.readinessDate
                        ? new Date(
                            listing.readinessDate
                          ).toLocaleDateString()
                        : 'To be agreed'
                    }
                  </strong>
                </div>


                <div>
                  <span>
                    Seller
                  </span>

                  <strong>
                    {
                      listing
                        .seller
                        ?.name
                    }
                  </strong>
                </div>

              </div>


              <p className="muted">
                A pending, rejected or
                countered offer does not
                remove a listing from buyer
                availability. Acceptance
                creates a temporary
                reservation.
              </p>

            </div>


            {
              isAgricultural && (

                <div className="card">

                  <h2>
                    Inspection evidence
                  </h2>


                  {
                    listing
                      .inspectionRequests
                      ?.length
                      ? listing
                          .inspectionRequests
                          .map(
                            (
                              request
                            ) => (

                              <div
                                className="evidence"
                                key={
                                  request.id
                                }
                              >

                                <div>

                                  <strong>
                                    {
                                      request.mode.replaceAll(
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
                                      request.status
                                    }
                                  </span>

                                </div>


                                {
                                  request.inspector &&
                                  (

                                    <p>
                                      Inspector:{' '}
                                      {
                                        request
                                          .inspector
                                          .name
                                      }
                                    </p>

                                  )
                                }


                                {
                                  request.report
                                    ? (

                                      <p>
                                        ✓{' '}
                                        {
                                          request
                                            .report
                                            .quantity
                                        }{' '}
                                        verified
                                        {' · '}
                                        {
                                          request
                                            .report
                                            .grade ||
                                          'Grade not stated'
                                        }

                                        {
                                          request
                                            .report
                                            .moisture !=
                                            null
                                            ? ` · ${request.report.moisture}% moisture`
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

                        <p className="muted">
                          No inspection yet.
                        </p>

                      )
                  }

                </div>

              )
            }

          </section>


          <aside>

            {
              msg && (

                <div className="alert success">
                  {msg}
                </div>

              )
            }


            {
              error && (

                <div className="alert error">
                  {error}
                </div>

              )
            }


            {
              isBuyer && (

                <div className="card sticky-card">

                  <h2>
                    {
                      isAvailable
                        ? 'Make an offer'
                        : 'Listing unavailable'
                    }
                  </h2>


                  {
                    !isAvailable
                      ? (

                        <>

                          <p className="muted">
                            This listing has an
                            accepted offer and is
                            temporarily unavailable
                            to new buyers.
                          </p>


                          <Link
                            className="btn btn-light full"
                            to={
                              isAgricultural
                                ? '/agricultural'
                                : '/products'
                            }
                          >
                            Browse available
                            listings
                          </Link>

                        </>

                      )
                      : (

                        <>

                          <p className="muted">
                            Your offer does not
                            reserve the listing.
                            The seller decides
                            whether to accept,
                            reject or counter.
                          </p>


                          <form
                            onSubmit={
                              submitOffer
                            }
                          >

                            <label>
                              Your offer (ETB)
                            </label>

                            <input
                              required
                              type="number"
                              min="0.01"
                              value={
                                offerAmount
                              }
                              onChange={(
                                e
                              ) =>
                                setOfferAmount(
                                  e.target.value
                                )
                              }
                            />


                            <label>
                              Message
                            </label>

                            <textarea
                              value={
                                message
                              }
                              onChange={(
                                e
                              ) =>
                                setMessage(
                                  e.target.value
                                )
                              }
                              placeholder="Optional message to the farmer"
                            />


                            <button className="btn btn-primary full">
                              Submit offer
                            </button>

                          </form>


                          {
                            isAgricultural && (

                              <>

                                <hr />

                                <h3>
                                  Quality check
                                </h3>

                                <p className="small muted">
                                  Request an
                                  independent
                                  inspection.
                                </p>


                                {inspector && (
                                  <input
                                    type="number"
                                    min="1"
                                    step="0.01"
                                    placeholder="Agreed fee (ETB)"
                                    value={feeForInspector}
                                    onChange={(e) => setFeeForInspector(e.target.value)}
                                    style={{ marginBottom: 8, width: '100%' }}
                                  />
                                )}

                                <button
                                  className="btn btn-light full"
                                  onClick={() =>
                                    requestInspection(
                                      'BUYER_REQUESTED'
                                    )
                                  }
                                >
                                  Request inspection
                                </button>


                                <button
                                  className="btn btn-light full"
                                  style={{
                                    marginTop:
                                      8,
                                  }}
                                  onClick={
                                    chooseInspector
                                  }
                                >
                                  Find an inspector
                                </button>

                              </>

                            )
                          }

                        </>

                      )
                  }

                </div>

              )
            }


            {
              isOwner && (

                <div className="card sticky-card">

                  <h2>
                    Seller controls
                  </h2>


                  <p className="small muted">
                    Only the seller can
                    change price or
                    listing status.
                  </p>


                  {
                    isAgricultural && (

                      {inspector && (
                        <input
                          type="number"
                          min="1"
                          step="0.01"
                          placeholder="Agreed fee (ETB)"
                          value={feeForInspector}
                          onChange={(e) => setFeeForInspector(e.target.value)}
                          style={{ marginBottom: 8, width: '100%' }}
                        />
                      )}

                      <button
                        className="btn btn-light full"
                        onClick={() =>
                          requestInspection(
                            'SELLER_REQUESTED'
                          )
                        }
                      >
                        Request inspection
                      </button>

                      <button
                        className="btn btn-light full"
                        style={{ marginTop: 8 }}
                        onClick={chooseInspector}
                      >
                        Find an inspector
                      </button>

                    )
                  }


                  <h3 className="mt">
                    Offers received
                  </h3>


                  {
                    listing.offers?.length
                      ? listing
                          .offers
                          .map(
                            (
                              offer
                            ) => (

                              <OfferRow
                                key={
                                  offer.id
                                }
                                offer={
                                  offer
                                }
                                onAction={
                                  respondToOffer
                                }
                              />

                            )
                          )
                      : (

                        <p className="muted">
                          No offers yet.
                        </p>

                      )
                  }

                </div>

              )
            }


            {
              !user && (

                <div className="card">

                  <h2>
                    Ready to participate?
                  </h2>

                  <p>
                    Register to buy and
                    sell across
                    MarketBridge.
                  </p>

                  <Link
                    className="btn btn-primary full"
                    to="/register"
                  >
                    Create account
                  </Link>

                </div>

              )
            }

          </aside>

        </div>

      </div>

    </main>
  );
}


function OfferRow({
  offer,
  onAction,
}) {
  const [
    counter,
    setCounter,
  ] = useState('');


  return (
    <div className="offer-row">

      <strong>
        {
          Number(
            offer.amount
          ).toLocaleString()
        } ETB
      </strong>


      <span className="badge">
        {
          offer.status
        }
      </span>


      <small>
        {
          offer.buyer?.name ||
          'Buyer'
        }
      </small>


      {
        [
          'PENDING',
          'COUNTERED',
        ].includes(
          offer.status
        ) && (

          <div className="row-actions">

            <button
              className="btn btn-sm"
              onClick={() =>
                onAction(
                  offer.id,
                  'ACCEPT'
                )
              }
            >
              Accept
            </button>


            <button
              className="btn btn-sm btn-light"
              onClick={() =>
                onAction(
                  offer.id,
                  'REJECT'
                )
              }
            >
              Reject
            </button>


            <input
              placeholder="Counter ETB"
              value={counter}
              onChange={(e) =>
                setCounter(
                  e.target.value
                )
              }
            />


            <button
              className="btn btn-sm btn-light"
              disabled={!counter}
              onClick={() =>
                onAction(
                  offer.id,
                  'COUNTER',
                  counter
                )
              }
            >
              Counter
            </button>

          </div>

        )
      }

    </div>
  );
}
