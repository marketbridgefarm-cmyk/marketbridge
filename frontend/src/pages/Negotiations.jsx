import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// ============================================================================
// NEGOTIATIONS
// ============================================================================
//
// A single hub for every offer a person is party to, whether they're the
// buyer or the seller on it, with the same Accept/Reject/Counter/Accept
// seller counter/Re-counter actions already available piecemeal in
// SellerDashboard.jsx, BuyerDashboard.jsx, and ListingDetail.jsx. This page
// previously only listed offers with no way to act on them at all.
//
// GET /offers/mine only returns offers where the viewer is the BUYER, so
// the seller side has to be assembled the same way SellerDashboard.jsx does
// it: fetch the viewer's own listings, then fetch offers per listing.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

function amountOf(offer) {
  const value = offer.status === 'COUNTERED' ? (offer.counterAmount ?? offer.amount) : offer.amount;
  return Number(value);
}

export default function Negotiations() {
  const { user } = useAuth();
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('active');
  const [busyKey, setBusyKey] = useState('');
  const [counterDrafts, setCounterDrafts] = useState({});
  const [toastMsg, setToastMsg] = useState('');

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setError('');
    try {
      const [mineRes, listingResults] = await Promise.all([
        api.get('/offers/mine'),
        Promise.all(
          SELLER_LISTING_STATUSES.map((status) => api.get('/listings', { params: { sellerId: user.id, status } }))
        ),
      ]);

      const buyerOffers = (mineRes.data?.offers || []).map((offer) => ({ ...offer, viewerRole: 'BUYER' }));

      const myListings = listingResults.flatMap((res) => res.data?.listings || []);
      const sellerOfferResults = await Promise.all(
        myListings.map((listing) => api.get(`/offers/listing/${listing.id}`))
      );
      const sellerOffers = myListings.flatMap((listing, i) =>
        (sellerOfferResults[i].data?.offers || []).map((offer) => ({ ...offer, listing, viewerRole: 'SELLER' }))
      );

      // A buyer can't also be the seller on the same offer, so there's no
      // overlap to dedupe between the two sets.
      setOffers([...buyerOffers, ...sellerOffers]);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load negotiations');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // A negotiation chain is represented by parentOfferId. The actionable
  // offer is the LEAF (the one nothing else counters), not the root —
  // otherwise a seller counter would leave the original PENDING offer
  // showing stale action buttons alongside the real, current one.
  const leafOffers = useMemo(() => {
    const parentIds = new Set(offers.map((offer) => offer.parentOfferId).filter(Boolean));
    return offers.filter((offer) => !parentIds.has(offer.id));
  }, [offers]);

  const visible = useMemo(() => {
    const sorted = [...leafOffers].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    return filter === 'all'
      ? sorted
      : sorted.filter((offer) => ['PENDING', 'COUNTERED'].includes(offer.status));
  }, [leafOffers, filter]);

  const respond = useCallback(async (offer, action, counterAmount) => {
    const key = `${offer.id}:${action}`;
    setBusyKey(key);
    try {
      const payload = { action };
      if (action === 'COUNTER' || action === 'RE_COUNTER') payload.counterAmount = Number(counterAmount);
      const response = await api.patch(`/offers/${offer.id}`, payload);
      toast(response.data?.message || 'Negotiation updated.');
      setCounterDrafts((prev) => ({ ...prev, [offer.id]: '' }));
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update the offer.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">Discuss price and terms before creating an order — as either buyer or seller.</p>
        <div className="sd-tabs" style={{ margin: '20px 0' }}>
          <button type="button" className={`sd-tab ${filter === 'active' ? 'sd-active' : ''}`} onClick={() => setFilter('active')}>Active</button>
          <button type="button" className={`sd-tab ${filter === 'all' ? 'sd-active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {loading ? <p>Loading negotiations…</p> : visible.length === 0 ? (
          <div className="card notice">No negotiations here yet. Open a listing to make an offer.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {visible.map((offer) => (
              <NegotiationRow
                key={offer.id}
                offer={offer}
                busyKey={busyKey}
                counterDraft={counterDrafts[offer.id] || ''}
                onCounterDraftChange={(value) => setCounterDrafts((prev) => ({ ...prev, [offer.id]: value }))}
                onRespond={respond}
              />
            ))}
          </div>
        )}
        {toastMsg && <div className="sd-toast">{toastMsg}</div>}
      </div>
    </main>
  );
}

function NegotiationRow({ offer, busyKey, counterDraft, onCounterDraftChange, onRespond }) {
  const isSeller = offer.viewerRole === 'SELLER';
  const isBuyer = offer.viewerRole === 'BUYER';
  const listingTitle = offer.listing?.title || offer.listing?.cropType || 'Agricultural listing';
  const amount = amountOf(offer);

  // Mirrors the exact gating the backend enforces (routes/offers.js):
  // seller can ACCEPT/REJECT/COUNTER a PENDING offer or one the buyer just
  // countered; buyer can ACCEPT_COUNTER/RE_COUNTER only after a seller
  // counter.
  const sellerCanAct = isSeller && (
    offer.status === 'PENDING' ||
    (offer.status === 'COUNTERED' && offer.counteredBy === 'BUYER')
  );
  const buyerCanAct = isBuyer && offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER';

  const counterValue = Number(counterDraft);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;

  const busy = (action) => busyKey === `${offer.id}:${action}`;
  const anyBusy = Boolean(busyKey) && busyKey.startsWith(`${offer.id}:`);

  return (
    <article className="card">
      <div className="row-between">
        <div>
          <span className="role-chip">{offer.status}</span>{' '}
          <span className="role-chip" style={{ marginLeft: 6 }}>{isSeller ? 'You are the seller' : 'You are the buyer'}</span>
          <h3>{listingTitle}</h3>
          <p>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB{offer.quantity ? ` · ${offer.quantity} quantity` : ''}</p>
        </div>
        {offer.listingId && <Link className="btn btn-outline" to={`/listings/${offer.listingId}`}>Open listing</Link>}
      </div>

      {offer.message && <p className="muted">{offer.message}</p>}

      {offer.status === 'COUNTERED' && offer.counteredBy === 'BUYER' && isSeller && (
        <p className="muted" style={{ marginTop: 8 }}>
          <strong>Buyer countered.</strong> You can accept it, reject the negotiation, or send another counter.
        </p>
      )}
      {offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER' && isBuyer && (
        <p className="muted" style={{ marginTop: 8 }}>
          <strong>Seller countered.</strong> You can accept it or send another counter.
        </p>
      )}
      {offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER' && isSeller && (
        <p className="muted" style={{ marginTop: 8 }}>You made the latest counter. Waiting for the buyer.</p>
      )}
      {offer.status === 'COUNTERED' && offer.counteredBy === 'BUYER' && isBuyer && (
        <p className="muted" style={{ marginTop: 8 }}>You made the latest counter. Waiting for the seller.</p>
      )}
      {offer.status === 'PENDING' && isBuyer && (
        <p className="muted" style={{ marginTop: 8 }}>Waiting for the seller to respond.</p>
      )}
      {offer.status === 'REJECTED' && <p className="muted" style={{ marginTop: 8 }}>This negotiation was rejected.</p>}
      {offer.status === 'ACCEPTED' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Agreed at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>. <Link to="/orders">View your orders →</Link>
        </p>
      )}

      {sellerCanAct && (
        <div className="row-actions" style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy} onClick={() => onRespond(offer, 'ACCEPT')}>
            {busy('ACCEPT') ? 'Accepting…' : 'Accept'}
          </button>
          <button type="button" className="sd-btn sd-btn-outline" disabled={anyBusy} onClick={() => onRespond(offer, 'REJECT')}>
            {busy('REJECT') ? 'Rejecting…' : 'Reject'}
          </button>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(e) => onCounterDraftChange(e.target.value)}
            style={{ width: 120 }}
          />
          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() => onRespond(offer, 'COUNTER', counterValue)}
          >
            {busy('COUNTER') ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}

      {buyerCanAct && (
        <div className="row-actions" style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy} onClick={() => onRespond(offer, 'ACCEPT_COUNTER')}>
            {busy('ACCEPT_COUNTER') ? 'Accepting…' : 'Accept seller counter'}
          </button>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(e) => onCounterDraftChange(e.target.value)}
            style={{ width: 120 }}
          />
          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() => onRespond(offer, 'RE_COUNTER', counterValue)}
          >
            {busy('RE_COUNTER') ? 'Sending…' : 'Counter seller'}
          </button>
        </div>
      )}
    </article>
  );
}
