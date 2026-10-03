import React, { useEffect, useState } from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import './listing-detail/ListingDetail.css';

const money = (n) => Number(n || 0).toLocaleString();

const pick = (...values) => values.find((v) => v != null && v !== '');

function CardHead({ eyebrow, title, subtitle, side, id }) {
  return (
    <header className="ld-card-head">
      <div className="ld-card-head-main">
        {eyebrow && <span className="ld-eyebrow">{eyebrow}</span>}
        <h2 className="ld-card-title" id={id}>{title}</h2>
        {subtitle && <p className="ld-card-subtitle">{subtitle}</p>}
      </div>
      {side && <div className="ld-card-head-side">{side}</div>}
    </header>
  );
}

function SectionHead({ title, meta, strong }) {
  return (
    <div className="ld-section-head">
      <h3 className="ld-section-title">{title}</h3>
      {meta != null && (
        <span className={`ld-section-meta${strong ? ' is-strong' : ''}`}>{meta}</span>
      )}
    </div>
  );
}

export default function ListingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [listing, setListing] = useState(null);

  const [offerAmount, setOfferAmount] = useState('');
  const [message, setMessage] = useState('');

  const [buyerCounter, setBuyerCounter] = useState('');

  const [activeMediaIndex, setActiveMediaIndex] = useState(0);

  const relatedOrders = (listing?.orders || [])
    .filter((order) => order?.status !== 'CANCELLED')
    .sort((a, b) =>
      a?.createdAt ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() : 0
    );
  const relatedOrder = relatedOrders[0] || null;

  // Read-only view of the current inspection (if any) so the listing page can
  // point the buyer at the order page where the actual negotiation happens.
  const activeInspectionRequest =
    (listing?.inspectionRequests || [])
      .filter((request) => request.status !== 'CANCELLED')
      .filter(
        (request) =>
          !relatedOrder?.id || !request.orderId || request.orderId === relatedOrder.id
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ||
    null;

  async function load() {
    try {
      const response = await api.get(`/listings/${id}`);
      setListing(response.data.listing);
      setActiveMediaIndex(0);
    } catch (e) {
      showToast(e.response?.data?.error || 'Listing not found.', 'error');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!listing) return;
    const title = listing.title || listing.cropType || 'Marketplace listing';
    const description =
      listing.description ||
      `${title} available on MarketBridge, an Ethiopian marketplace.`;
    document.title = `${title} | MarketBridge`;
    let meta = document.querySelector('meta[name=description]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description.slice(0, 155));
  }, [listing]);

  async function submitOffer(e) {
    e.preventDefault();
    try {
      await api.post('/offers', {
        listingId: id,
        amount: Number(offerAmount),
        message,
      });
      showToast(
        'Offer submitted. Other buyers can still see this listing until an offer is accepted.',
        'success'
      );
      setOfferAmount('');
      setMessage('');
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not submit offer', 'error');
    }
  }

  async function respondToOffer(offerId, action, counterAmount) {
    try {
      const payload = { action };
      if (counterAmount != null) payload.counterAmount = Number(counterAmount);
      const response = await api.patch(`/offers/${offerId}`, payload);
      showToast(response.data?.message || 'Negotiation updated.', 'success');
      setBuyerCounter('');
      await load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Action failed', 'error');
    }
  }

  if (!listing) {
    return (
      <main className="detail-page section">
        <div className="container-wide loading">Loading listing…</div>
      </main>
    );
  }

  const isOwner = user?.id === listing.sellerId;
  const isBuyer = user?.roles?.includes('BUYER') && !isOwner;
  const isAgricultural = listing.category === 'AGRICULTURAL';
  const isProduct = listing.category === 'PRODUCT';

  const isAvailable =
    listing.status === 'ACTIVE' ||
    ((isAgricultural || isProduct) && listing.status === 'UNDER_NEGOTIATION');

  const listingParentIds = new Set(
    (listing.offers || []).map((offer) => offer.parentOfferId).filter(Boolean)
  );

  const myLatestOffer =
    (listing.offers || [])
      .filter((offer) => offer.buyerId === user?.id && !listingParentIds.has(offer.id))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;

  const sellerCounterWaitingForBuyer =
    myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'SELLER';
  const buyerCounterWaitingForSeller =
    myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'BUYER';
  const buyerHasActiveOfferDeal = Boolean(
    myLatestOffer && ['SELECTED', 'COUNTERED', 'ACCEPTED'].includes(myLatestOffer.status)
  );

  const media = [
    ...(listing.photos || []).map((url) => ({ type: 'photo', url })),
    ...(listing.videos || []).map((url) => ({ type: 'video', url })),
  ];
  const activeMediaIndexSafe = media.length
    ? Math.min(activeMediaIndex, media.length - 1)
    : 0;
  const activeMedia = media[activeMediaIndexSafe];

  const myOrder = (listing.orders || []).find((o) => o.buyerId === user?.id);

  const categoryLabel = listing.cropType
    ? listing.cropType
    : listing.productType
    ? String(listing.productType).replace(/_/g, ' ')
    : isAgricultural
    ? 'Agricultural produce'
    : 'Physical product';

  const minimumPrice = pick(listing.minimumPrice, listing.listingMinimumPrice);
  const region = pick(listing.region, listing.listingRegion);
  const totalBids = Array.isArray(listing.offers) ? listing.offers.length : 0;

  return (
    <main className="detail-page section">
      <div className="container-wide">
        <Link
          className="back-link"
          to={isAgricultural ? '/agricultural' : '/products'}
        >
          ← Back to marketplace
        </Link>

        <div className="detail-grid">
          <section>
            {/* ── Media ─────────────────────────────────────── */}
            <div className="detail-media">
              {activeMedia ? (
                activeMedia.type === 'video' ? (
                  <video src={activeMedia.url} controls />
                ) : (
                  <img
                    src={activeMedia.url}
                    alt={listing.title || listing.cropType}
                  />
                )
              ) : (
                <div className="media-placeholder">
                  {listing.title || listing.cropType}
                </div>
              )}
            </div>

            {media.length > 1 && (
              <div className="detail-media-thumbs">
                {media.map((m, i) => (
                  <button
                    type="button"
                    key={`${m.type}-${i}`}
                    className={`detail-media-thumb ${
                      i === activeMediaIndexSafe ? 'active' : ''
                    }`}
                    onClick={() => setActiveMediaIndex(i)}
                    aria-label={`Show ${m.type} ${i + 1}`}
                  >
                    {m.type === 'video' ? (
                      <video src={m.url} muted />
                    ) : (
                      <img src={m.url} alt="" loading="lazy" decoding="async" />
                    )}
                    {m.type === 'video' && (
                      <span className="detail-media-thumb-play">▶</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* ── Content card ──────────────────────────────── */}
            <div className="card detail-content">
              <CardHead
                eyebrow={isAgricultural ? 'AGRICULTURE' : 'PRODUCT'}
                title={listing.title || listing.cropType}
                side={
                  <>
                    <span className="ld-card-side-label">Status</span>
                    <span className={`ld-badge tone-${listing.status === 'ACTIVE' ? 'good' : 'neutral'}`}>
                      {String(listing.status || '').replace(/_/g, ' ')}
                    </span>
                  </>
                }
              />

              {listing.description && (
                <>
                  <SectionHead title="Description" />
                  <div className="listing-description">{listing.description}</div>
                </>
              )}

              <SectionHead title="Listing details" />

              <div className="detail-facts">
                <div>
                  <span>Asking price</span>
                  <strong>{money(listing.askingPrice)} ETB</strong>
                </div>

                {minimumPrice != null && (
                  <div>
                    <span>Minimum price</span>
                    <strong>{money(minimumPrice)} ETB</strong>
                  </div>
                )}

                <div>
                  <span>Quantity</span>
                  <strong>
                    {Number(listing.quantity || 0).toLocaleString()} {listing.unit || 'units'}
                  </strong>
                </div>

                <div>
                  <span>Category</span>
                  <strong>{categoryLabel}</strong>
                </div>

                {region && (
                  <div>
                    <span>Region</span>
                    <strong>{region}</strong>
                  </div>
                )}

                {listing.location && (
                  <div>
                    <span>Location</span>
                    <strong>{listing.location}</strong>
                  </div>
                )}

                <div>
                  <span>Ready</span>
                  <strong>
                    {listing.readinessDate
                      ? new Date(listing.readinessDate).toLocaleDateString()
                      : 'To be agreed'}
                  </strong>
                </div>

                {listing.createdAt && (
                  <div>
                    <span>Published</span>
                    <strong>{new Date(listing.createdAt).toLocaleDateString()}</strong>
                  </div>
                )}

                <div>
                  <span>Seller</span>
                  <strong>{listing.seller?.name || '—'}</strong>
                </div>
              </div>

              {totalBids > 0 && (
                <>
                  <SectionHead
                    title="Bids received"
                    meta={`${totalBids} bid${totalBids === 1 ? '' : 's'}`}
                    strong
                  />
                  <p className="muted">
                    {isOwner
                      ? 'Open the Seller controls card to review and respond to individual bids.'
                      : 'Bids are sealed. The seller selects one buyer to open price negotiation.'}
                  </p>
                </>
              )}

              {myOrder && (
                <p className="detail-order-link">
                  <Link className="btn btn-primary" to={`/orders/${myOrder.id}`}>
                    View your order ({myOrder.status.replaceAll('_', ' ')}) →
                  </Link>
                </p>
              )}

              <p className="listing-availability-note">
                <strong className="notice-prefix">Notice:</strong>{' '}
                {isAvailable
                  ? 'Available for competing buyers. Selecting a buyer opens negotiation; only acceptance creates the reservation.'
                  : 'This listing is currently reserved / unavailable to new buyers.'}
              </p>
            </div>

            {/* ── Inspection summary (read-only) ────────────── */}
            {(isAgricultural || isProduct) && (
              <div className="card">
                <CardHead
                  eyebrow="QUALITY"
                  title="Inspection"
                  subtitle="Inspection is arranged and negotiated from the order page."
                />

                {activeInspectionRequest ? (
                  <div className="evidence">
                    <div className="evidence-head">
                      <strong>{activeInspectionRequest.mode.replaceAll('_', ' ')}</strong>
                      <span className="ld-badge">
                        {activeInspectionRequest.status.replace(/_/g, ' ')}
                      </span>
                    </div>

                    {activeInspectionRequest.inspector && (
                      <p className="evidence-line">
                        Inspector: <strong>{activeInspectionRequest.inspector.name}</strong>
                      </p>
                    )}

                    {myOrder ? (
                      <p className="detail-order-link">
                        <Link className="btn btn-primary" to={`/orders/${myOrder.id}#inspection-section`}>
                          Open inspection in your order →
                        </Link>
                      </p>
                    ) : (
                      <p className="muted">
                        Inspection proceeds once your order exists.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="muted">
                    {myOrder
                      ? 'No inspection yet. Request one from the order page.'
                      : 'Inspection becomes available after your offer is accepted and an order is created.'}
                  </p>
                )}
              </div>
            )}
          </section>

          <aside>
            {isBuyer && myLatestOffer && (isAgricultural || isProduct) && (
              <div className="card" id="negotiation">
                <CardHead
                  eyebrow="NEGOTIATION"
                  title="Your negotiation"
                  side={
                    <>
                      <span className="ld-card-side-label">Current</span>
                      <span className="ld-card-side-value">
                        {money(myLatestOffer.counterAmount ?? myLatestOffer.amount)} ETB
                      </span>
                    </>
                  }
                />

                <span className="ld-badge">{myLatestOffer.status.replace(/_/g, ' ')}</span>

                {myLatestOffer.status === 'SELECTED' && (
                  <>
                    <p className="muted negotiation-note">
                      <strong>The seller selected your bid.</strong> Competition is
                      complete for this deal. Accept the selected price or make your
                      counter.
                    </p>
                    <div className="negotiation-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() =>
                          respondToOffer(myLatestOffer.id, 'ACCEPT_SELECTED')
                        }
                      >
                        Accept selected price
                      </button>
                      <AmountPicker
                        className="inline-picker"
                        reference={Number(myLatestOffer.counterAmount ?? myLatestOffer.amount)}
                        placeholder="Counter (ETB)"
                        value={buyerCounter}
                        onChange={setBuyerCounter}
                        ariaLabel="Counter amount in ETB"
                      />
                      <button
                        className="btn btn-light"
                        disabled={!buyerCounter}
                        onClick={() =>
                          respondToOffer(myLatestOffer.id, 'RE_COUNTER', buyerCounter)
                        }
                      >
                        Counter
                      </button>
                    </div>
                  </>
                )}

                {sellerCounterWaitingForBuyer && (
                  <>
                    <p className="muted negotiation-note">
                      The seller has countered. <strong>Your turn.</strong>
                    </p>
                    <div className="negotiation-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() =>
                          respondToOffer(myLatestOffer.id, 'ACCEPT_COUNTER')
                        }
                      >
                        Accept seller counter
                      </button>
                      <AmountPicker
                        className="inline-picker"
                        reference={Number(myLatestOffer.counterAmount ?? myLatestOffer.amount)}
                        placeholder="Counter (ETB)"
                        value={buyerCounter}
                        onChange={setBuyerCounter}
                        ariaLabel="Counter amount in ETB"
                      />
                      <button
                        className="btn btn-light"
                        disabled={!buyerCounter}
                        onClick={() =>
                          respondToOffer(myLatestOffer.id, 'RE_COUNTER', buyerCounter)
                        }
                      >
                        Counter seller
                      </button>
                    </div>
                  </>
                )}

                {buyerCounterWaitingForSeller && (
                  <p className="muted negotiation-note">
                    You made the latest counter. Waiting for the seller.
                  </p>
                )}

                {myLatestOffer.status === 'PENDING' && (
                  <p className="muted negotiation-note">
                    Your offer remains active while other buyers may compete. The
                    seller will select one buyer to open negotiation.
                  </p>
                )}

                {myLatestOffer.status === 'REJECTED' && (
                  <p className="muted negotiation-note">
                    The seller rejected this offer. If the listing is available, you
                    can make a new offer.
                  </p>
                )}

                {myLatestOffer.status === 'ACCEPTED' && (
                  <Link
                    className="btn btn-primary full"
                    style={{ marginTop: 10 }}
                    to={myOrder?.id ? `/orders/${myOrder.id}` : '#'}
                  >
                    Continue to order →
                  </Link>
                )}
              </div>
            )}

            {isBuyer && (
              <div className="card sticky-card" id="make-offer">
                <CardHead
                  eyebrow="BUYER"
                  title={
                    !isAvailable || buyerHasActiveOfferDeal
                      ? 'Offer unavailable'
                      : 'Make an Offer'
                  }
                  subtitle={
                    !isAvailable || buyerHasActiveOfferDeal
                      ? null
                      : 'Competitive bidding — your bid enters the competition without charging or reserving the product.'
                  }
                />

                {buyerHasActiveOfferDeal ? (
                  <div>
                    <p className="muted">
                      You already have an active buyer offer on this listing. Continue
                      the existing negotiation below instead of submitting another
                      root bid.
                    </p>
                    <button
                      type="button"
                      className="btn btn-light full"
                      onClick={() =>
                        document
                          .getElementById('negotiation')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                    >
                      Open negotiation
                    </button>
                  </div>
                ) : !isAvailable ? (
                  <>
                    <p className="muted">
                      This listing has an accepted offer and is temporarily
                      unavailable to new buyers.
                    </p>
                    <Link
                      className="btn btn-light full"
                      to={isAgricultural ? '/agricultural' : '/products'}
                    >
                      Browse available listings
                    </Link>
                  </>
                ) : (
                  <form onSubmit={submitOffer}>
                    <label>
                      {isProduct
                        ? 'Offer amount (ETB)'
                        : 'Your bid / offer (ETB)'}
                    </label>
                    <AmountPicker
                      required
                      reference={Number(listing.askingPrice)}
                      placeholder={
                        isProduct
                          ? 'Select the amount you want to offer'
                          : 'Select your bid amount'
                      }
                      value={offerAmount}
                      onChange={setOfferAmount}
                      ariaLabel="Your bid amount in ETB"
                    />
                    <label>Message</label>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder={
                        isProduct
                          ? 'Optional message to the seller'
                          : 'Optional message to the farmer'
                      }
                    />
                    <button
                      type="submit"
                      className="btn btn-primary full"
                      disabled={!offerAmount || Number(offerAmount) <= 0}
                    >
                      {isProduct ? 'Make Offer' : 'Submit bid'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {listing.seller && (
              <div className="card">
                <CardHead
                  eyebrow="SELLER"
                  title={listing.seller.name || 'Seller'}
                  side={
                    listing.seller.rating != null ? (
                      <>
                        <span className="ld-card-side-label">Rating</span>
                        <span className="ld-card-side-value">
                          ★ {Number(listing.seller.rating).toFixed(1)}
                        </span>
                      </>
                    ) : null
                  }
                />

                <div className="detail-facts">
                  {listing.seller.verificationStatus && (
                    <div>
                      <span>Verification</span>
                      <strong>{String(listing.seller.verificationStatus).replace(/_/g, ' ')}</strong>
                    </div>
                  )}

                  {listing.seller.location && (
                    <div>
                      <span>Based in</span>
                      <strong>{listing.seller.location}</strong>
                    </div>
                  )}

                  {listing.seller.createdAt && (
                    <div>
                      <span>Member since</span>
                      <strong>
                        {new Date(listing.seller.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          year: 'numeric',
                        })}
                      </strong>
                    </div>
                  )}

                  {listing.seller.listingCount != null && (
                    <div>
                      <span>Listings</span>
                      <strong>{listing.seller.listingCount}</strong>
                    </div>
                  )}

                  {listing.seller.phone && (
                    <div>
                      <span>Phone</span>
                      <strong>{listing.seller.phone}</strong>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isOwner && (
              <div className="card sticky-card">
                <CardHead
                  eyebrow="SELLER"
                  title="Seller controls"
                  subtitle="Only the seller can change price or listing status."
                />

                <SectionHead title="Negotiations" />
                <SellerNegotiations
                  offers={listing.offers}
                  onAction={respondToOffer}
                />
              </div>
            )}

            {!user && (
              <div className="card">
                <CardHead
                  eyebrow="GET STARTED"
                  title="Ready to participate?"
                  subtitle="Register to buy and sell across MarketBridge."
                />
                <Link className="btn btn-primary full" to="/register">
                  Create account
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function SellerNegotiations({ offers, onAction }) {
  const list = Array.isArray(offers) ? offers : [];

  const byBuyer = new Map();
  for (const offer of list) {
    const buyerId = offer.buyerId || offer.buyer?.id || offer.id;
    const existing = byBuyer.get(buyerId);
    if (
      !existing ||
      new Date(offer.createdAt || 0) > new Date(existing.createdAt || 0)
    ) {
      byBuyer.set(buyerId, offer);
    }
  }

  const negotiations = Array.from(byBuyer.values()).sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );

  if (!negotiations.length) {
    return <p className="muted">No negotiations yet.</p>;
  }

  return (
    <div className="negotiations-list">
      {negotiations.map((offer) => (
        <OfferRow key={offer.id} offer={offer} onAction={onAction} />
      ))}
    </div>
  );
}

function OfferRow({ offer, onAction }) {
  const [counter, setCounter] = useState('');
  const [busy, setBusy] = useState('');

  const buyerCountered =
    offer.status === 'COUNTERED' &&
    String(offer.counteredBy || '').toUpperCase() === 'BUYER';

  const sellerCanAct = offer.status === 'SELECTED' || buyerCountered;

  const amount = Number(offer.counterAmount ?? offer.amount);
  const minimum = Number(
    offer.listing?.minimumPrice ??
      offer.minimumPrice ??
      offer.listingMinimumPrice ??
      NaN
  );

  const submit = async (action, value) => {
    if (busy) return;
    setBusy(action);
    try {
      await onAction(offer.id, action, value);
      if (action === 'COUNTER') setCounter('');
    } finally {
      setBusy('');
    }
  };

  const counterValue = Number(counter);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;
  const counterBelowMinimum =
    Number.isFinite(minimum) && counterValid && counterValue < minimum;

  return (
    <div className="offer-row">
      <div className="offer-row-head">
        <strong>
          {Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB
        </strong>
        <span className="ld-badge">{offer.status.replace(/_/g, ' ')}</span>
      </div>
      <small className="offer-buyer">{offer.buyer?.name || 'Buyer'}</small>

      {buyerCountered && (
        <p className="offer-note">
          <strong>Buyer countered.</strong> This is the buyer's latest price. You
          can accept it, reject the negotiation, or send another counter.
        </p>
      )}

      {offer.status === 'COUNTERED' &&
        String(offer.counteredBy || '').toUpperCase() === 'SELLER' && (
          <p className="offer-note">
            You made the latest counter. Waiting for the buyer.
          </p>
        )}

      {offer.status === 'PENDING' && (
        <div className="offer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={Boolean(busy)}
            onClick={() => submit('SELECT')}
          >
            {busy === 'SELECT' ? 'Selecting…' : 'Select buyer for deal'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-light"
            disabled={Boolean(busy)}
            onClick={() => submit('REJECT')}
          >
            {busy === 'REJECT' ? 'Rejecting…' : 'Reject bid'}
          </button>
        </div>
      )}

      {sellerCanAct && (
        <div className="offer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={Boolean(busy)}
            onClick={() => submit('ACCEPT')}
          >
            {busy === 'ACCEPT' ? 'Accepting…' : 'Accept'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-light"
            disabled={Boolean(busy)}
            onClick={() => submit('REJECT')}
          >
            {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
          </button>
          <AmountPicker
            className="inline-picker"
            reference={amount}
            min={Number.isFinite(minimum) ? minimum : undefined}
            placeholder={
              Number.isFinite(minimum) ? `Counter ≥ ${minimum}` : 'Counter (ETB)'
            }
            value={counter}
            disabled={Boolean(busy)}
            onChange={setCounter}
            ariaLabel="Counter amount in ETB"
          />
          <button
            type="button"
            className="btn btn-sm btn-light"
            disabled={!counterValid || counterBelowMinimum || Boolean(busy)}
            onClick={() => submit('COUNTER', counter)}
          >
            {busy === 'COUNTER' ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}

      {!sellerCanAct &&
        offer.status === 'COUNTERED' &&
        String(offer.counteredBy || '').toUpperCase() !== 'BUYER' && (
          <p className="offer-note small">
            Waiting for the buyer to respond.
          </p>
        )}

      {offer.status === 'ACCEPTED' && (
        <p className="offer-note small">
          Agreed price: <strong>{Number(amount).toLocaleString()} ETB</strong>. The
          order can now continue to inspection and payment.
        </p>
      )}
    </div>
  );
}
