import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import BidBoard from '../components/BidBoard.jsx';

// ============================================================================
// NEGOTIATIONS
// ============================================================================
// Unified hub for all three negotiation types:
//
//   1. LISTING_OFFER      buyer <-> seller           (bilateral)
//   2. TRANSPORT_QUOTE    requester <-> truck owners  (competition → bilateral)
//   3. INSPECTION_QUOTE   requester <-> inspectors    (competition → bilateral)
//
// Types 2 and 3 have TWO phases:
//
//   Competition phase — many providers bid on one job. The requester sees a
//   BidBoard with all competing quotes; they can hire the best directly or
//   start a counter-offer with one (or several) providers.
//
//   Negotiation phase — once the requester has countered a specific provider,
//   the two parties exchange offers until one accepts or rejects. While this
//   bilateral negotiation is underway the requester can still hire any other
//   PENDING provider from the BidBoard.
//
// Listing offers are always bilateral (one buyer, one seller), so they go
// straight to the NegotiationCard flow.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

function amountOf(item) {
  return item.counterAmount ?? item.amount ?? item.offerPrice ?? null;
}

function isExpired(item) {
  return Boolean(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now());
}

// Within ONE provider's counter-chain, only the leaf matters.
function leavesOnly(items, parentKey) {
  const parentIds = new Set(items.map((i) => i[parentKey]).filter(Boolean));
  return items.filter((i) => !parentIds.has(i.id));
}

// ---- NegotiationRow (bilateral only — listing offers + provider-side quotes) ---
function NegotiationRow({ item, busyKey, counterDraft, onCounterDraftChange, onRespond }) {
  const acceptAction = item.type === 'LISTING_OFFER' ? 'ACCEPT' : 'ACCEPT';
  const amount       = amountOf(item);
  const expired      = isExpired(item);
  let canAct         = ['PENDING', 'COUNTERED'].includes(item.status) && !expired;
  let myTurn         = false;
  let waitingMessage = null;

  if (item.type === 'LISTING_OFFER') {
    if (item.status === 'PENDING')   { myTurn = item.viewerRole === 'SELLER'; }
    if (item.status === 'COUNTERED') {
      myTurn = item.counteredBy !== undefined
        ? item.viewerRole !== (item.counteredBy === 'BUYER' ? 'BUYER' : 'SELLER')
        : item.viewerRole === 'BUYER';
    }
  } else {
    // Provider-side transport/inspection quote
    if (item.status === 'PENDING')   myTurn = item.viewerRole === 'REQUESTER';
    if (item.status === 'COUNTERED') {
      const nextTurn = item.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
      myTurn = item.viewerRole === nextTurn;
    }
  }

  if (canAct && !myTurn) {
    waitingMessage = 'Waiting for the other party to respond.';
    canAct = false;
  }
  if (expired) {
    canAct = false;
    waitingMessage = 'This quote has expired.';
  }

  const anyBusy = busyKey.startsWith(item.id + ':');
  const busy    = (action) => busyKey === `${item.id}:${action}`;

  return (
    <article className={`neg-card${myTurn ? ' neg-card--my-turn' : ''}`}>
      {myTurn && (
        <span className="neg-turn-label" aria-label="Your turn to respond">⚡ Your turn</span>
      )}
      <div className="row-between">
        <div>
          <span className="role-chip">{item.status}</span>{' '}
          <span className="role-chip" style={{ marginLeft: 6 }}>{item.subtitle}</span>
          <h3 className="neg-title">{item.title}</h3>
          <p className="neg-amount">
            {Number.isFinite(amount) ? amount.toLocaleString() : '—'}
            {' '}<span className="neg-amount-unit">ETB</span>
          </p>
        </div>
        {item.linkTo && <Link className="btn btn-outline" to={item.linkTo}>Open</Link>}
      </div>

      {item.message && <p className="muted">{item.message}</p>}
      {waitingMessage && <p className="muted" style={{ marginTop: 8 }}>{waitingMessage}</p>}
      {item.status === 'REJECTED' && <p className="muted" style={{ marginTop: 8 }}>This negotiation was rejected.</p>}
      {item.status === 'ACCEPTED' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Agreed at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>.
        </p>
      )}

      {canAct && (
        <div className="neg-actions">
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy}
            onClick={() => onRespond(item, acceptAction)}>
            {busy(acceptAction) ? 'Accepting…' : 'Accept'}
          </button>

          {!(item.type === 'LISTING_OFFER' && item.viewerRole === 'BUYER') && (
            <button type="button" className="sd-btn sd-btn-outline" disabled={anyBusy}
              onClick={() => onRespond(item, 'REJECT')}>
              {busy('REJECT') ? 'Rejecting…' : 'Reject'}
            </button>
          )}

          {item.type === 'LISTING_OFFER' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="number" min="1" step="0.01"
                className="sd-counter-input"
                placeholder="Counter amount (ETB)"
                value={counterDraft}
                onChange={(e) => onCounterDraftChange(e.target.value)}
                aria-label="Counter-offer amount"
              />
              <button
                type="button" className="sd-btn sd-btn-outline"
                disabled={anyBusy || !counterDraft}
                onClick={() => onRespond(item, item.status === 'COUNTERED' ? 'RE_COUNTER' : 'COUNTER', counterDraft)}>
                {busy('COUNTER') || busy('RE_COUNTER') ? 'Countering…' : 'Counter'}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ============================================================================
// Main component
// ============================================================================
export default function Negotiations() {
  const { user } = useAuth();

  // Bilateral items (listing offers + provider-side quotes)
  const [items,            setItems]            = useState([]);
  // Competition groups (inspection/transport, requester side)
  const [compGroups,       setCompGroups]       = useState([]);

  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState('');
  const [filter,           setFilter]           = useState('active');
  const [typeFilter,       setTypeFilter]       = useState('all');
  const [busyKey,          setBusyKey]          = useState('');
  const [counterDrafts,    setCounterDrafts]    = useState({});
  const [toastMsg,         setToastMsg]         = useState('');

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setError('');
    const roles    = user.roles || [];
    const collected = [];
    const groups    = [];

    try {
      // ---- 1. Listing offers (always bilateral) --------------------------
      const [mineRes, listingResults] = await Promise.all([
        api.get('/offers/mine'),
        Promise.all(
          SELLER_LISTING_STATUSES.map((s) => api.get('/listings', { params: { sellerId: user.id, status: s } }))
        ),
      ]);

      const buyerOffers  = (mineRes.data?.offers || []).map((o) => ({ ...o, viewerRole: 'BUYER' }));
      const myListings   = listingResults.flatMap((r) => r.data?.listings || []);
      const sellerOfferResults = await Promise.all(
        myListings.map((l) => api.get(`/offers/listing/${l.id}`))
      );
      const sellerOffers = myListings.flatMap((l, i) =>
        (sellerOfferResults[i].data?.offers || []).map((o) => ({ ...o, listing: l, viewerRole: 'SELLER' }))
      );

      leavesOnly([...buyerOffers, ...sellerOffers], 'parentOfferId').forEach((offer) => {
        collected.push({
          type:        'LISTING_OFFER',
          id:          offer.id,
          status:      offer.status,
          counteredBy: offer.counteredBy,
          amount:      amountOf(offer),
          message:     offer.message,
          viewerRole:  offer.viewerRole,
          title:       offer.listing?.title || offer.listing?.cropType || 'Agricultural listing',
          subtitle:    offer.viewerRole === 'SELLER' ? 'Listing offer · you are the seller' : 'Listing offer · you are the buyer',
          linkTo:      offer.listingId ? `/listings/${offer.listingId}` : null,
          expiresAt:   offer.expiresAt,
          raw:         offer,
        });
      });

      // ---- 2. Transport & inspection — requester side -------------------
      // GET /orders nests both quote arrays. We split them into:
      //   a) competition groups (BidBoard) — all active quotes, not filtered by leavesOnly
      //   b) bilateral negotiation items  — the provider's own quote leaf (provider view)
      const ordersRes = await api.get('/orders');
      const orders    = ordersRes.data?.orders || [];

      orders.forEach((order) => {
        // ---- TRANSPORT ---
        const job = order.transportJob;
        if (job && job.method === 'HIRE_TRANSPORTER' && Array.isArray(job.quotes)) {
          const isRequester =
            (job.arrangingParty === 'SELLER' && order.sellerId === user.id) ||
            (job.arrangingParty === 'BUYER'  && order.buyerId  === user.id) ||
            (job.arrangingParty === 'JOINT'  && (order.buyerId === user.id || order.sellerId === user.id));

          if (isRequester) {
            // All active quotes across every competing provider → BidBoard
            const active = job.quotes.filter((q) => ['PENDING', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status));
            if (active.length > 0) {
              groups.push({
                key:       `transport:${job.id}`,
                type:      'TRANSPORT_QUOTE',
                jobId:     job.id,
                requestId: null,
                orderId:   order.id,
                label:     `Transport · ${order.listing?.cropType || order.listing?.title || 'order'}`,
                quotes:    active,
                orderLink: `/orders/${order.id}`,
              });
            }
          }
        }

        // ---- INSPECTION ---
        (order.inspectionRequests || []).forEach((request) => {
          if (request.requestedById !== user.id) return;
          if (!Array.isArray(request.quotes)) return;

          const active = request.quotes.filter((q) =>
            ['PENDING', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status)
          );
          if (active.length > 0) {
            groups.push({
              key:       `inspection:${request.id}`,
              type:      'INSPECTION_QUOTE',
              requestId: request.id,
              jobId:     null,
              orderId:   order.id,
              label:     `Inspection · ${order.listing?.cropType || order.listing?.title || 'listing'}`,
              quotes:    active,
              orderLink: `/orders/${order.id}`,
            });
          }
        });
      });

      // ---- 3. Transport quotes, provider side (truck owners) ------------
      if (roles.includes('TRUCK_OWNER')) {
        const openRes = await api.get('/transport/open');
        (openRes.data?.jobs || []).forEach((job) => {
          const myQuotes = (job.quotes || []).filter((q) => ['PENDING', 'COUNTERED'].includes(q.status));
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type:        'TRANSPORT_QUOTE',
              id:          quote.id,
              status:      quote.status,
              counteredBy: quote.counteredBy,
              amount:      amountOf(quote),
              message:     quote.message,
              viewerRole:  'PROVIDER',
              title:       `Transport bid · order for ${job.order?.buyer?.name || job.order?.seller?.name || 'a buyer'}`,
              subtitle:    'You submitted this quote',
              linkTo:      null,
              expiresAt:   quote.expiresAt,
              raw:         { quoteId: quote.id },
            });
          });
        });
      }

      // ---- 4. Inspection quotes, provider side (inspectors) -------------
      if (roles.includes('INSPECTOR')) {
        const availableRes = await api.get('/inspections/available');
        (availableRes.data?.requests || []).forEach((request) => {
          const myQuotes = (request.quotes || []).filter((q) => ['PENDING', 'COUNTERED'].includes(q.status));
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type:        'INSPECTION_QUOTE',
              id:          quote.id,
              status:      quote.status,
              counteredBy: quote.counteredBy,
              amount:      amountOf(quote),
              message:     quote.message,
              viewerRole:  'PROVIDER',
              title:       `Inspection bid · ${request.listing?.cropType || request.listing?.title || 'listing'}`,
              subtitle:    `Requested by ${request.requestedBy?.name || 'buyer'}`,
              linkTo:      null,
              expiresAt:   quote.expiresAt,
              raw:         { requestId: request.id, quoteId: quote.id },
            });
          });
        });
      }

      setItems(collected);
      setCompGroups(groups);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load negotiations');
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.roles]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ---- Respond: bilateral (NegotiationRow) ---
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
        const payload = { action };
        if (action === 'COUNTER') payload.counterAmount = Number(counterAmount);
        response = await api.patch(`/transport/quotes/${item.raw.quoteId}`, payload);
      } else if (item.type === 'INSPECTION_QUOTE') {
        const { requestId, quoteId } = item.raw;
        if      (action === 'ACCEPT')  response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/accept`);
        else if (action === 'REJECT')  response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/reject`);
        else if (action === 'COUNTER') response = await api.post(`/inspections/${requestId}/quotes/${quoteId}/counter`, { counterAmount: Number(counterAmount) });
      }
      toast(response?.data?.message || 'Updated.');
      setCounterDrafts((prev) => ({ ...prev, [item.id]: '' }));
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update this negotiation.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  // ---- Respond: BidBoard (competition groups) ---
  const respondBid = useCallback(async (group, quote, action, counterAmount) => {
    const key = `bid:${quote.id}:${action}`;
    setBusyKey(key);
    try {
      let response;
      if (group.type === 'INSPECTION_QUOTE') {
        if      (action === 'ACCEPT')  response = await api.patch(`/inspections/${group.requestId}/quotes/${quote.id}/accept`);
        else if (action === 'REJECT')  response = await api.patch(`/inspections/${group.requestId}/quotes/${quote.id}/reject`);
        else if (action === 'COUNTER') response = await api.post(`/inspections/${group.requestId}/quotes/${quote.id}/counter`, { counterAmount: Number(counterAmount) });
      } else if (group.type === 'TRANSPORT_QUOTE') {
        const payload = { action };
        if (action === 'COUNTER') payload.counterAmount = Number(counterAmount);
        response = await api.patch(`/transport/quotes/${quote.id}`, payload);
      }
      toast(response?.data?.message || (action === 'ACCEPT' ? 'Provider hired!' : 'Offer sent.'));
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update this bid.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  const visible = useMemo(() => {
    let list = [...items].sort((a, b) =>
      (a.status === b.status ? 0 : ['PENDING', 'COUNTERED'].includes(a.status) ? -1 : 1)
    );
    if (filter === 'active') list = list.filter((i) => ['PENDING', 'COUNTERED'].includes(i.status));
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter);
    return list;
  }, [items, filter, typeFilter]);

  const activeCompGroups = compGroups.filter((g) =>
    typeFilter === 'all' || g.type === typeFilter
  );

  const myTurnCount = items.filter((i) => {
    if (!['PENDING', 'COUNTERED'].includes(i.status)) return false;
    if (i.type === 'LISTING_OFFER') {
      if (i.status === 'PENDING')   return i.viewerRole === 'SELLER';
      return i.counteredBy !== undefined
        ? i.viewerRole !== (i.counteredBy === 'BUYER' ? 'BUYER' : 'SELLER')
        : i.viewerRole === 'BUYER';
    }
    return i.status === 'PENDING'
      ? i.viewerRole === 'REQUESTER'
      : (i.counteredBy === 'REQUESTER' ? i.viewerRole === 'PROVIDER' : i.viewerRole === 'REQUESTER');
  }).length;

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">
          Agree on price and terms for listings, transport, and inspections — as either party.
        </p>

        {/* Tab filters */}
        <div className="sd-tabs" style={{ margin: '20px 0 8px' }}>
          <button type="button" className={`sd-tab ${filter === 'active' ? 'sd-active' : ''}`} onClick={() => setFilter('active')}>Active</button>
          <button type="button" className={`sd-tab ${filter === 'all'    ? 'sd-active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
        <div className="sd-tabs" style={{ margin: '0 0 20px' }}>
          <button type="button" className={`sd-tab ${typeFilter === 'all'              ? 'sd-active' : ''}`} onClick={() => setTypeFilter('all')}>All types</button>
          <button type="button" className={`sd-tab ${typeFilter === 'LISTING_OFFER'    ? 'sd-active' : ''}`} onClick={() => setTypeFilter('LISTING_OFFER')}>Listing offers</button>
          <button type="button" className={`sd-tab ${typeFilter === 'TRANSPORT_QUOTE'  ? 'sd-active' : ''}`} onClick={() => setTypeFilter('TRANSPORT_QUOTE')}>Transport</button>
          <button type="button" className={`sd-tab ${typeFilter === 'INSPECTION_QUOTE' ? 'sd-active' : ''}`} onClick={() => setTypeFilter('INSPECTION_QUOTE')}>Inspection</button>
        </div>

        {error   && <div className="alert error">{error}</div>}
        {loading && <p>Loading negotiations…</p>}

        {!loading && (
          <>
            {/* ============================================================ */}
            {/* COMPETITION PHASE — BidBoard for each inspection/transport    */}
            {/* request. Multiple service providers bid; requester selects.   */}
            {/* ============================================================ */}
            {activeCompGroups.length > 0 && (
              <section className="neg-section" aria-labelledby="comp-heading">
                <h2 className="neg-section-title" id="comp-heading">
                  Select a service provider
                  <span className="neg-section-sub">
                    Compare competing bids and hire the best match — or negotiate a price first.
                  </span>
                </h2>

                {activeCompGroups.map((group) => (
                  <div key={group.key} className="neg-group">
                    <div className="neg-group-header">
                      <strong>{group.label}</strong>
                      {group.orderLink && (
                        <a href={group.orderLink} className="neg-group-link">View order →</a>
                      )}
                    </div>
                    <BidBoard
                      quotes={group.quotes}
                      type={group.type}
                      requestId={group.requestId}
                      orderLink={null /* already shown in header */}
                      onRespond={(quote, action, amount) => respondBid(group, quote, action, amount)}
                      disabled={!!busyKey}
                    />
                  </div>
                ))}
              </section>
            )}

            {/* ============================================================ */}
            {/* BILATERAL NEGOTIATIONS — listing offers + provider-side quotes */}
            {/* ============================================================ */}
            {visible.length > 0 && (
              <section className="neg-section" aria-labelledby="bilat-heading">
                <h2 className="neg-section-title" id="bilat-heading">
                  {activeCompGroups.length > 0 ? 'Listing offer negotiations' : 'Negotiations'}
                  {myTurnCount > 0 && (
                    <span className="neg-section-badge">{myTurnCount} need your response</span>
                  )}
                </h2>

                <div style={{ display: 'grid', gap: 12 }}>
                  {visible.map((item) => (
                    <NegotiationRow
                      key={`${item.type}:${item.id}`}
                      item={item}
                      busyKey={busyKey}
                      counterDraft={counterDrafts[item.id] || ''}
                      onCounterDraftChange={(val) => setCounterDrafts((prev) => ({ ...prev, [item.id]: val }))}
                      onRespond={respond}
                    />
                  ))}
                </div>
              </section>
            )}

            {activeCompGroups.length === 0 && visible.length === 0 && (
              <div className="card notice">No negotiations here yet.</div>
            )}
          </>
        )}

        {toastMsg && <div className="sd-toast">{toastMsg}</div>}
      </div>
    </main>
  );
}
