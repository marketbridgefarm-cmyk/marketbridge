import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// ============================================================================
// NEGOTIATIONS — unified hub for all three negotiation types on the
// platform:
//
//   1. LISTING_OFFER      buyer  <-> seller     (routes/offers.js)
//   2. TRANSPORT_QUOTE    arranging party (REQUESTER) <-> truck owner (PROVIDER)
//   3. INSPECTION_QUOTE   requester (REQUESTER)        <-> inspector (PROVIDER)
//
// Types 2 and 3 are a genuine back-and-forth to agree on a service price —
// nobody should be shown an "Accept" button for a first-come bid with no
// way to counter it. Both already support ACCEPT / REJECT / COUNTER on the
// backend; this page is what actually exposes that negotiation instead of
// only the instant-claim/accept-only paths that existed elsewhere (or, for
// inspection quotes, no frontend surface at all).
//
// Data sources, since no single endpoint returns "every negotiation I'm
// part of":
//   - Listing offers as buyer:      GET /offers/mine
//   - Listing offers as seller:     GET /listings?sellerId=me + GET /offers/listing/:id per listing
//   - Transport/inspection as the
//     requester (buyer or seller):  GET /orders (already nests transportJob.quotes
//                                    and inspectionRequests[].quotes)
//   - Transport quotes as provider: GET /transport/open (TRUCK_OWNER role only;
//                                    scoped server-side to this truck owner's own quotes)
//   - Inspection quotes as provider:GET /inspections/available (INSPECTOR role only;
//                                    scoped server-side to this inspector's own quotes)
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

// Mirrors backend routes/transport.js and routes/inspections.js exactly —
// both use this identical rule. Getting this wrong means showing an action
// button on a turn that isn't the viewer's, which the server would then
// correctly reject with a 409.
function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function isExpired(item) {
  return Boolean(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now());
}

// A negotiation is a linked list via a parent-id field. Only the leaf (the
// one nothing else counters) is the current, actionable state — the same
// filtering BuyerDashboard.jsx already relies on for listing offers, needed
// here for transport/inspection quote chains too.
function leavesOnly(items, parentKey) {
  const parentIds = new Set(items.map((item) => item[parentKey]).filter(Boolean));
  return items.filter((item) => !parentIds.has(item.id));
}

function humanNegotiationStatus(status) {
  return ({ PENDING: 'Bid pending', SELECTED: 'Selected for deal', COUNTERED: 'Counter-offer', ACCEPTED: 'Accepted', REJECTED: 'Rejected', EXPIRED: 'Expired' }[status] || String(status || '').replaceAll('_', ' '));
}

function amountOf(offer) {
  const value = offer.status === 'COUNTERED' ? (offer.counterAmount ?? offer.amount) : offer.amount;
  return Number(value);
}

export default function Negotiations() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('active');
  const [typeFilter, setTypeFilter] = useState('all');
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
    const roles = user.roles || [];
    const collected = [];

    try {
      // ---- 1. Listing offers -------------------------------------------
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

      const offerLeaves = leavesOnly([...buyerOffers, ...sellerOffers], 'parentOfferId');
      offerLeaves.forEach((offer) => {
        collected.push({
          type: 'LISTING_OFFER',
          id: offer.id,
          status: offer.status,
          counteredBy: offer.counteredBy,
          amount: amountOf(offer),
          message: offer.message,
          viewerRole: offer.viewerRole,
          title: offer.listing?.title || offer.listing?.cropType || 'Agricultural listing',
          subtitle: offer.viewerRole === 'SELLER' ? 'Listing offer · you are the seller' : 'Listing offer · you are the buyer',
          linkTo: offer.listingId ? `/listings/${offer.listingId}` : null,
          expiresAt: offer.expiresAt,
          raw: offer,
        });
      });

      // ---- 2. Transport & inspection quotes, requester side -------------
      // GET /orders returns every order where the viewer is buyer or
      // seller, already nesting both quote threads.
      const ordersRes = await api.get('/orders');
      const orders = ordersRes.data?.orders || [];

      orders.forEach((order) => {
        const job = order.transportJob;
        if (job && Array.isArray(job.quotes)) {
          const isRequester =
            (job.arrangingParty === 'SELLER' && order.sellerId === user.id) ||
            (job.arrangingParty === 'BUYER' && order.buyerId === user.id) ||
            (job.arrangingParty === 'JOINT' && (order.buyerId === user.id || order.sellerId === user.id));
          if (isRequester) {
            const activeQuotes = job.quotes.filter((q) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status));
            leavesOnly(activeQuotes, 'parentQuoteId').forEach((quote) => {
              collected.push({
                type: 'TRANSPORT_QUOTE',
                id: quote.id,
                status: quote.status,
                counteredBy: quote.counteredBy,
                amount: amountOf(quote),
                message: quote.message,
                viewerRole: 'REQUESTER',
                title: `Transport · ${order.listing?.cropType || order.listing?.title || 'order'}`,
                subtitle: `Quote from ${quote.truckOwner?.name || 'a truck owner'}`,
                linkTo: `/orders/${order.id}`,
                expiresAt: quote.expiresAt,
                raw: { quoteId: quote.id },
              });
            });
          }
        }

        (order.inspectionRequests || []).forEach((request) => {
          const isRequester = request.requestedById === user.id;
          if (!isRequester || !Array.isArray(request.quotes)) return;
          leavesOnly(request.quotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type: 'INSPECTION_QUOTE',
              id: quote.id,
              status: quote.status,
              counteredBy: quote.counteredBy,
              amount: amountOf(quote),
              message: null, // not selected on this data path — see CHANGES.md
              viewerRole: 'REQUESTER',
              title: `Inspection · ${order.listing?.cropType || order.listing?.title || 'listing'}`,
              subtitle: 'Bid from an inspector',
              linkTo: `/orders/${order.id}`,
              expiresAt: quote.expiresAt,
              raw: { requestId: request.id, quoteId: quote.id },
            });
          });
        });
      });

      // ---- 3. Transport quotes, provider side (truck owners only) -------
      if (roles.includes('TRUCK_OWNER')) {
        const openRes = await api.get('/transport/open');
        (openRes.data?.jobs || []).forEach((job) => {
          const myQuotes = (job.quotes || []).filter((q) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status));
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type: 'TRANSPORT_QUOTE',
              id: quote.id,
              status: quote.status,
              counteredBy: quote.counteredBy,
              amount: amountOf(quote),
              message: quote.message,
              viewerRole: 'PROVIDER',
              title: `Transport bid · order for ${job.order?.buyer?.name || job.order?.seller?.name || 'a buyer'}`,
              subtitle: 'You submitted this quote',
              linkTo: null, // not viewable until the job is actually assigned to you
              expiresAt: quote.expiresAt,
              raw: { quoteId: quote.id },
            });
          });
        });
      }

      // ---- 4. Inspection quotes, provider side (inspectors only) --------
      if (roles.includes('INSPECTOR')) {
        const availableRes = await api.get('/inspections/available');
        (availableRes.data?.requests || []).forEach((request) => {
          const myQuotes = (request.quotes || []).filter((q) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status));
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type: 'INSPECTION_QUOTE',
              id: quote.id,
              status: quote.status,
              counteredBy: quote.counteredBy,
              amount: amountOf(quote),
              message: quote.message,
              viewerRole: 'PROVIDER',
              title: `Inspection bid · ${request.listing?.cropType || request.listing?.title || 'listing'}`,
              subtitle: `Requested by ${request.requestedBy?.name || 'buyer'}`,
              linkTo: null,
              expiresAt: quote.expiresAt,
              raw: { requestId: request.id, quoteId: quote.id },
            });
          });
        });
      }

      setItems(collected);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load negotiations');
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.roles]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const visible = useMemo(() => {
    let list = [...items].sort((a, b) => (a.status === b.status ? 0 : a.status === 'PENDING' || a.status === 'COUNTERED' ? -1 : 1));
    if (filter === 'active') list = list.filter((item) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(item.status));
    if (typeFilter !== 'all') list = list.filter((item) => item.type === typeFilter);
    return list;
  }, [items, filter, typeFilter]);

  const respond = useCallback(async (item, action, counterAmount) => {
    const key = `${item.id}:${action}`;
    setBusyKey(key);
    try {
      let response;
      if (item.type === 'LISTING_OFFER') {
        const payload = { action };
        if (action === 'COUNTER' || action === 'RE_COUNTER') payload.counterAmount = Number(counterAmount);
        response = await api.patch(`/offers/${item.raw.id}`, payload);
      } else if (item.type === 'TRANSPORT_QUOTE') {
        if (action === 'SELECT') { response = await api.patch(`/transport/quotes/${item.raw.quoteId}/select`); } else {
        const payload = { action };
        if (action === 'COUNTER') payload.counterAmount = Number(counterAmount);
        response = await api.patch(`/transport/quotes/${item.raw.quoteId}`, payload);
        }
      } else if (item.type === 'INSPECTION_QUOTE') {
        const { requestId, quoteId } = item.raw;
        if (action === 'SELECT') {
          response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/select`);
        } else if (action === 'ACCEPT') {
          response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/accept`);
        } else if (action === 'REJECT') {
          response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/reject`);
        } else if (action === 'COUNTER') {
          response = await api.post(`/inspections/${requestId}/quotes/${quoteId}/counter`, { counterAmount: Number(counterAmount) });
        }
      }
      toast(response?.data?.message || 'Negotiation updated.');
      setCounterDrafts((prev) => ({ ...prev, [item.id]: '' }));
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update this negotiation.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">Agree on price and terms for listings, transport, and inspections — as either party.</p>

        <div className="sd-tabs" style={{ margin: '20px 0 8px' }}>
          <button type="button" className={`sd-tab ${filter === 'active' ? 'sd-active' : ''}`} onClick={() => setFilter('active')}>Active</button>
          <button type="button" className={`sd-tab ${filter === 'all' ? 'sd-active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
        <div className="sd-tabs" style={{ margin: '0 0 20px' }}>
          <button type="button" className={`sd-tab ${typeFilter === 'all' ? 'sd-active' : ''}`} onClick={() => setTypeFilter('all')}>All types</button>
          <button type="button" className={`sd-tab ${typeFilter === 'LISTING_OFFER' ? 'sd-active' : ''}`} onClick={() => setTypeFilter('LISTING_OFFER')}>Listing offers</button>
          <button type="button" className={`sd-tab ${typeFilter === 'TRANSPORT_QUOTE' ? 'sd-active' : ''}`} onClick={() => setTypeFilter('TRANSPORT_QUOTE')}>Transport</button>
          <button type="button" className={`sd-tab ${typeFilter === 'INSPECTION_QUOTE' ? 'sd-active' : ''}`} onClick={() => setTypeFilter('INSPECTION_QUOTE')}>Inspection</button>
        </div>

        {error && <div className="alert error">{error}</div>}
        {loading ? <p>Loading negotiations…</p> : visible.length === 0 ? (
          <div className="card notice">No negotiations here yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {visible.map((item) => (
              <NegotiationRow
                key={`${item.type}:${item.id}`}
                item={item}
                busyKey={busyKey}
                counterDraft={counterDrafts[item.id] || ''}
                onCounterDraftChange={(value) => setCounterDrafts((prev) => ({ ...prev, [item.id]: value }))}
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

function NegotiationRow({ item, busyKey, counterDraft, onCounterDraftChange, onRespond }) {
  const amount = item.amount;
  const busy = (action) => busyKey === `${item.id}:${action}`;
  const anyBusy = Boolean(busyKey) && busyKey.startsWith(`${item.id}:`);
  const expired = isExpired(item);

  const counterValue = Number(counterDraft);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;

  // Listing offers use distinct action names per side (ACCEPT/REJECT/COUNTER
  // for the seller vs ACCEPT_COUNTER/RE_COUNTER for the buyer). Transport
  // and inspection quotes use one action set (ACCEPT/REJECT/COUNTER) for
  // both sides — the server figures out which party is acting.
  let canAct = false;
  let acceptAction = 'ACCEPT';
  let counterAction = 'COUNTER';
  let canSelect = false;
  let waitingMessage = null;

  if (item.type === 'LISTING_OFFER') {
    if (item.viewerRole === 'SELLER') {
      canSelect = item.status === 'PENDING';
      canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'BUYER');
      if (!canAct && item.status === 'COUNTERED' && item.counteredBy === 'SELLER') waitingMessage = 'You made the latest counter. Waiting for the buyer.';
    } else {
      acceptAction = item.status === 'SELECTED' ? 'ACCEPT_SELECTED' : 'ACCEPT_COUNTER';
      counterAction = 'RE_COUNTER';
      canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'SELLER');
      if (!canAct && item.status === 'PENDING') waitingMessage = 'Waiting for the seller to respond.';
      if (item.status === 'SELECTED') waitingMessage = 'Selected bid — price-deal negotiation is now open.';
      if (!canAct && item.status === 'COUNTERED' && item.counteredBy === 'BUYER') waitingMessage = 'You made the latest counter. Waiting for the seller.';
    }
  } else {
    // TRANSPORT_QUOTE / INSPECTION_QUOTE
    canSelect = item.viewerRole === 'REQUESTER' && item.status === 'PENDING';
    const turn = quoteTurn(item);
    canAct = turn === item.viewerRole && item.status !== 'PENDING';
    if (!canAct && turn) {
      waitingMessage = `Waiting for the ${item.viewerRole === 'REQUESTER' ? (item.type === 'TRANSPORT_QUOTE' ? 'truck owner' : 'inspector') : 'requester'} to respond.`;
    }
  }

  if (expired && ['PENDING', 'SELECTED', 'COUNTERED'].includes(item.status)) {
    canAct = false;
    waitingMessage = 'This quote has expired.';
  }

  return (
    <article className="card">
      <div className="row-between">
        <div>
          <span className="role-chip">{humanNegotiationStatus(item.status)}</span>{' '}
          <span className="role-chip" style={{ marginLeft: 6 }}>{item.subtitle}</span>
          <h3>{item.title}</h3>
          <p>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</p>
        </div>
        {item.linkTo && <Link className="btn btn-outline" to={item.linkTo}>Open</Link>}
      </div>

      {item.message && <p className="muted">{item.message}</p>}
      {waitingMessage && <p className="muted" style={{ marginTop: 8 }}>{waitingMessage}</p>}
      {item.status === 'REJECTED' && <p className="muted" style={{ marginTop: 8 }}>This negotiation was rejected.</p>}
      {item.status === 'ACCEPTED' && <p className="muted" style={{ marginTop: 8 }}>Agreed at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>.</p>}

      {canSelect && (
        <div className="row-actions" style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy} onClick={() => onRespond(item, 'SELECT')}>
            {busy('SELECT') ? 'Selecting…' : 'Select for deal'}
          </button>
          <button type="button" className="sd-btn sd-btn-outline" disabled={anyBusy} onClick={() => onRespond(item, 'REJECT')}>
            {busy('REJECT') ? 'Rejecting…' : 'Reject bid'}
          </button>
          <span className="muted">Competition bid — selecting opens the price-deal stage.</span>
        </div>
      )}

      {canAct && (
        <div className="row-actions" style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy} onClick={() => onRespond(item, acceptAction)}>
            {busy(acceptAction) ? 'Accepting…' : 'Accept'}
          </button>
          {/* Only the seller can REJECT a listing offer (backend routes/offers.js
              restricts this action to the seller) — a buyer withdraws by
              simply not responding, there's no buyer-side reject action.
              Transport and inspection quotes allow REJECT from whichever
              side's turn it is, so no extra gate is needed there. */}
          {!(item.type === 'LISTING_OFFER' && item.viewerRole === 'BUYER') && (
            <button type="button" className="sd-btn sd-btn-outline" disabled={anyBusy} onClick={() => onRespond(item, 'REJECT')}>
              {busy('REJECT') ? 'Rejecting…' : 'Reject'}
            </button>
          )}
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
            onClick={() => onRespond(item, counterAction, counterValue)}
          >
            {busy(counterAction) ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}
    </article>
  );
}
