import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import BidBoard from '../components/BidBoard.jsx';

// ============================================================================
// NEGOTIATIONS — unified hub for all three negotiation types
// ============================================================================
//
// 1. LISTING_OFFER      many buyers → seller selection → bilateral negotiation
// 2. TRANSPORT_QUOTE    arranging party ↔ truck owners (competition → bilateral)
// 3. INSPECTION_QUOTE   requester ↔ inspectors        (competition → bilateral)
//
// Types 2 and 3 have two sequential phases:
//
//  Competition phase  (status === 'PENDING')
//    Many providers have bid. The requester sees a BidBoard with all competing
//    quotes side-by-side, sorted by price. They select one to open negotiation.
//    → PATCH /inspections/:id/quotes/:qid/select
//    → PATCH /transport/quotes/:qid/select
//
//  Negotiation phase  (status === 'SELECTED' or 'COUNTERED')
//    One-on-one back-and-forth. The selected quote gets Accept / Counter /
//    Reject controls. The other PENDING bids remain visible and selectable.
//    → PATCH /inspections/:id/quotes/:qid/accept
//    → POST  /inspections/:id/quotes/:qid/counter  {counterAmount}
//    → PATCH /inspections/:id/quotes/:qid/reject
//    → PATCH /transport/quotes/:qid  {action, counterAmount?}
//
// Listing offers have a competition phase: many PENDING buyers remain visible until
// the seller selects one buyer. SELECTED then opens bilateral negotiation.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

// Mirrors the turn rule in routes/inspections.js and routes/transport.js
function quoteTurn(quote) {
  if (quote.status === 'PENDING')   return 'REQUESTER';
  if (quote.status === 'SELECTED')  return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function isExpired(item) {
  return Boolean(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now());
}

// Within ONE provider's counter-chain, keep only the leaf (most recent quote).
// Quotes from different providers have no parent-child link so all are kept.
function leavesOnly(items, parentKey) {
  const parentIds = new Set(items.map((i) => i[parentKey]).filter(Boolean));
  return items.filter((i) => !parentIds.has(i.id));
}

function humanStatus(status) {
  return ({
    PENDING:  'Bid pending',
    SELECTED: 'Selected',
    COUNTERED:'Counter-offer',
    ACCEPTED: 'Accepted',
    REJECTED: 'Rejected',
    EXPIRED:  'Expired',
  }[status] || String(status || '').replaceAll('_', ' '));
}

function amountOf(item) {
  const v = item.status === 'COUNTERED' ? (item.counterAmount ?? item.amount) : item.amount;
  return Number(v);
}

// ============================================================================
// NegotiationRow — bilateral card for listing offers + provider-side quotes
// ============================================================================
function NegotiationRow({ item, busyKey, counterDraft, onCounterDraftChange, onRespond }) {
  const amount       = item.amount;
  const busy         = (action) => busyKey === `${item.id}:${action}`;
  const anyBusy      = Boolean(busyKey) && busyKey.startsWith(`${item.id}:`);
  const expired      = isExpired(item);
  const counterValue = Number(counterDraft);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;

  let canAct        = false;
  let acceptAction  = 'ACCEPT';
  let counterAction = 'COUNTER';
  let waitingMessage = null;

  if (item.type === 'LISTING_OFFER') {
    if (item.viewerRole === 'SELLER') {
      // Seller can select any still-pending buyer. Selection does NOT commit
      // the listing; it only opens one-to-one negotiation with that buyer.
      if (item.status === 'PENDING') {
        canAct = true;
        acceptAction = 'SELECT';
      } else {
        canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'BUYER');
        if (!canAct && item.status === 'COUNTERED' && item.counteredBy === 'SELLER')
          waitingMessage = 'You made the latest counter. Waiting for the buyer.';
      }
    } else {
      acceptAction  = item.status === 'SELECTED' ? 'ACCEPT_SELECTED' : 'ACCEPT_COUNTER';
      counterAction = 'RE_COUNTER';
      canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'SELLER');
      if (!canAct && item.status === 'PENDING') waitingMessage = 'Your offer is competing with other buyer offers. Waiting for the seller to select a buyer.';
      if (!canAct && item.status === 'COUNTERED' && item.counteredBy === 'BUYER')
        waitingMessage = 'You made the latest counter. Waiting for the seller.';
    }
  } else {
    // PROVIDER-side transport/inspection quotes — turn-based after a SELECTED/COUNTERED state
    const turn = quoteTurn(item);
    canAct = turn === item.viewerRole && ['SELECTED', 'COUNTERED'].includes(item.status);
    if (!canAct && turn) {
      const other = item.viewerRole === 'PROVIDER'
        ? (item.type === 'TRANSPORT_QUOTE' ? 'arranging party' : 'requester')
        : (item.type === 'TRANSPORT_QUOTE' ? 'truck owner' : 'inspector');
      waitingMessage = `Waiting for the ${other} to respond.`;
    }
  }

  if (expired && ['PENDING', 'SELECTED', 'COUNTERED'].includes(item.status)) {
    canAct = false;
    waitingMessage = 'This quote has expired.';
  }

  const myTurn = canAct && !waitingMessage;

  return (
    <article className={`neg-card${myTurn ? ' neg-card--my-turn' : ''}`}>
      {myTurn && <span className="neg-turn-label" aria-label="Your turn">⚡ Your turn</span>}
      <div className="row-between">
        <div>
          <span className="role-chip">{humanStatus(item.status)}</span>{' '}
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
      {item.status === 'REJECTED' && (
        <p className="muted" style={{ marginTop: 8 }}>This negotiation was rejected.</p>
      )}
      {item.status === 'ACCEPTED' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Provisional agreement at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>. Payment is required before the inspector/transporter is committed.
        </p>
      )}

      {canAct && (
        <div className="neg-actions">
          <button type="button" className="sd-btn sd-btn-primary" disabled={anyBusy}
            onClick={() => onRespond(item, acceptAction)}>
            {busy(acceptAction)
              ? (acceptAction === 'SELECT' ? 'Selecting…' : 'Accepting…')
              : (acceptAction === 'SELECT' ? 'Select buyer for negotiation' : 'Accept')}
          </button>

          {!(item.type === 'LISTING_OFFER' && item.viewerRole === 'BUYER') && (
            <button type="button" className="sd-btn sd-btn-outline" disabled={anyBusy}
              onClick={() => onRespond(item, 'REJECT')}>
              {busy('REJECT') ? 'Rejecting…' : 'Reject'}
            </button>
          )}

          <input
            type="number" min="0.01" step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(e) => onCounterDraftChange(e.target.value)}
            style={{ width: 120 }}
          />
          <button
            type="button" className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() => onRespond(item, counterAction, counterValue)}>
            {busy(counterAction) ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}
    </article>
  );
}

// ============================================================================
// Main page
// ============================================================================
export default function Negotiations() {
  const { user } = useAuth();

  // compGroups: inspection/transport requests where viewer is REQUESTER.
  // Each group is shown as a BidBoard (competition + negotiation in one view).
  const [compGroups,    setCompGroups]    = useState([]);
  // items: listing offers + provider-side quotes (bilateral NegotiationRow).
  const [items,         setItems]         = useState([]);

  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [filter,        setFilter]        = useState('active');
  const [typeFilter,    setTypeFilter]    = useState('all');
  const [busyKey,       setBusyKey]       = useState('');
  const [counterDrafts, setCounterDrafts] = useState({});
  const [toastMsg,      setToastMsg]      = useState('');

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  // --------------------------------------------------------------------------
  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setError('');
    const roles     = user.roles || [];
    const collected = [];
    const groups    = [];

    try {
      // ---- 1. Listing offers: competition → selection → negotiation -----
      const [mineRes, listingResults] = await Promise.all([
        api.get('/offers/mine'),
        Promise.all(
          SELLER_LISTING_STATUSES.map((s) =>
            api.get('/listings', { params: { sellerId: user.id, status: s } })
          )
        ),
      ]);

      // Every buyer's leaf offer remains visible while the listing is active.
      // A selected buyer enters bilateral negotiation; other PENDING buyers
      // remain available to the seller until one offer is accepted.
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
          subtitle:    offer.viewerRole === 'SELLER'
            ? 'Listing offer · you are the seller'
            : 'Listing offer · you are the buyer',
          linkTo:    offer.listingId ? `/listings/${offer.listingId}` : null,
          expiresAt: offer.expiresAt,
          raw:       offer,
        });
      });

      // ---- 2. Transport & inspection, REQUESTER side → BidBoard groups ---
      // GET /orders nests both quote arrays. We collect ALL active quotes per
      // request/job into competition groups, NOT individual NegotiationRows.
      const ordersRes = await api.get('/orders');
      const orders    = ordersRes.data?.orders || [];

      orders.forEach((order) => {
        // Transport
        const job = order.transportJob;
        if (job && job.method === 'HIRE_TRANSPORTER' && Array.isArray(job.quotes)) {
          const isRequester =
            (job.arrangingParty === 'SELLER' && order.sellerId === user.id) ||
            (job.arrangingParty === 'BUYER'  && order.buyerId  === user.id) ||
            (job.arrangingParty === 'JOINT'  &&
              (order.buyerId === user.id || order.sellerId === user.id));

          if (isRequester) {
            const visible = job.quotes.filter((q) =>
              ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status)
            );
            if (visible.length > 0) {
              groups.push({
                key:       `transport:${job.id}`,
                type:      'TRANSPORT_QUOTE',
                jobId:     job.id,
                requestId: null,
                label:     `Transport — ${order.listing?.cropType || order.listing?.title || 'order'}`,
                quotes:    visible,
                orderLink: `/orders/${order.id}`,
              });
            }
          }
        }

        // Inspection
        (order.inspectionRequests || []).forEach((request) => {
          if (request.requestedById !== user.id) return;
          if (!Array.isArray(request.quotes))   return;

          const visible = request.quotes.filter((q) =>
            ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status)
          );
          if (visible.length > 0) {
            groups.push({
              key:       `inspection:${request.id}`,
              type:      'INSPECTION_QUOTE',
              requestId: request.id,
              jobId:     null,
              label:     `Inspection — ${order.listing?.cropType || order.listing?.title || 'listing'}`,
              quotes:    visible,
              orderLink: `/orders/${order.id}`,
            });
          }
        });
      });

      // ---- 3. Transport quotes, PROVIDER side (truck owners) -------------
      if (roles.includes('TRUCK_OWNER')) {
        const openRes = await api.get('/transport/open');
        (openRes.data?.jobs || []).forEach((job) => {
          const myQuotes = (job.quotes || []).filter((q) =>
            ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status)
          );
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type:        'TRANSPORT_QUOTE',
              id:          quote.id,
              status:      quote.status,
              counteredBy: quote.counteredBy,
              amount:      amountOf(quote),
              message:     quote.message,
              viewerRole:  'PROVIDER',
              title:       `Transport bid — order for ${job.order?.buyer?.name || job.order?.seller?.name || 'buyer'}`,
              subtitle:    'You submitted this quote',
              linkTo:      null,
              expiresAt:   quote.expiresAt,
              raw:         { quoteId: quote.id },
            });
          });
        });
      }

      // ---- 4. Inspection quotes, PROVIDER side (inspectors) --------------
      if (roles.includes('INSPECTOR')) {
        const availableRes = await api.get('/inspections/available');
        (availableRes.data?.requests || []).forEach((request) => {
          const myQuotes = (request.quotes || []).filter((q) =>
            ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status)
          );
          leavesOnly(myQuotes, 'parentQuoteId').forEach((quote) => {
            collected.push({
              type:        'INSPECTION_QUOTE',
              id:          quote.id,
              status:      quote.status,
              counteredBy: quote.counteredBy,
              amount:      amountOf(quote),
              message:     quote.message,
              viewerRole:  'PROVIDER',
              title:       `Inspection bid — ${request.listing?.cropType || request.listing?.title || 'listing'}`,
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

  // ---- Respond: bilateral NegotiationRow ---------------------------------
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
        if (action === 'SELECT') {
          response = await api.patch(`/transport/quotes/${item.raw.quoteId}/select`);
        } else {
          const payload = { action };
          if (action === 'COUNTER') payload.counterAmount = Number(counterAmount);
          response = await api.patch(`/transport/quotes/${item.raw.quoteId}`, payload);
        }
      } else if (item.type === 'INSPECTION_QUOTE') {
        const { requestId, quoteId } = item.raw;
        if      (action === 'SELECT')  response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/select`);
        else if (action === 'ACCEPT')  response = await api.patch(`/inspections/${requestId}/quotes/${quoteId}/accept`);
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

  // ---- Respond: BidBoard (competition groups) ----------------------------
  const respondBid = useCallback(async (group, quote, action, counterAmount) => {
    const key = `bid:${quote.id}:${action}`;
    setBusyKey(key);
    try {
      let response;
      if (group.type === 'INSPECTION_QUOTE') {
        const { requestId } = group;
        if      (action === 'SELECT')  response = await api.patch(`/inspections/${requestId}/quotes/${quote.id}/select`);
        else if (action === 'ACCEPT')  response = await api.patch(`/inspections/${requestId}/quotes/${quote.id}/accept`);
        else if (action === 'REJECT')  response = await api.patch(`/inspections/${requestId}/quotes/${quote.id}/reject`);
        else if (action === 'COUNTER') response = await api.post(`/inspections/${requestId}/quotes/${quote.id}/counter`, { counterAmount: Number(counterAmount) });
      } else if (group.type === 'TRANSPORT_QUOTE') {
        if (action === 'SELECT') {
          response = await api.patch(`/transport/quotes/${quote.id}/select`);
        } else {
          const payload = { action };
          if (action === 'COUNTER') payload.counterAmount = Number(counterAmount);
          response = await api.patch(`/transport/quotes/${quote.id}`, payload);
        }
      }
      toast(response?.data?.message || (action === 'ACCEPT' ? '✓ Provider hired!' : action === 'SELECT' ? 'Bid selected — negotiation opened.' : 'Offer sent.'));
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update this bid.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  // ---- Filter bilateral items -------------------------------------------
  const visible = useMemo(() => {
    let list = [...items].sort((a, b) =>
      ['PENDING', 'SELECTED', 'COUNTERED'].includes(a.status) ? -1 : 1
    );
    if (filter === 'active') list = list.filter((i) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(i.status));
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter);
    return list;
  }, [items, filter, typeFilter]);

  const visibleGroups = compGroups.filter((g) =>
    typeFilter === 'all' || g.type === typeFilter
  );

  const hasAnything = visibleGroups.length > 0 || visible.length > 0;

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">
          Agree on price and terms for listings, transport, and inspections — as either party.
        </p>

        {/* Tabs */}
        <div className="sd-tabs" style={{ margin: '20px 0 8px' }}>
          <button type="button" className={`sd-tab${filter === 'active' ? ' sd-active' : ''}`}
            onClick={() => setFilter('active')}>Active</button>
          <button type="button" className={`sd-tab${filter === 'all' ? ' sd-active' : ''}`}
            onClick={() => setFilter('all')}>All</button>
        </div>
        <div className="sd-tabs" style={{ margin: '0 0 20px' }}>
          {[
            { id: 'all',              label: 'All types'       },
            { id: 'LISTING_OFFER',    label: 'Listing offers'  },
            { id: 'TRANSPORT_QUOTE',  label: 'Transport'       },
            { id: 'INSPECTION_QUOTE', label: 'Inspection'      },
          ].map(({ id, label }) => (
            <button key={id} type="button"
              className={`sd-tab${typeFilter === id ? ' sd-active' : ''}`}
              onClick={() => setTypeFilter(id)}>{label}</button>
          ))}
        </div>

        {error   && <div className="alert error">{error}</div>}
        {loading && <p>Loading negotiations…</p>}

        {!loading && (
          <>
            {/* ============================================================
                COMPETITION PHASE — BidBoard per inspection/transport request
                ============================================================ */}
            {visibleGroups.length > 0 && (
              <section className="neg-section" aria-labelledby="comp-heading">
                <h2 className="neg-section-title" id="comp-heading">
                  Select a service provider
                  <span className="neg-section-sub">
                    Compare all competing bids and select the best — or negotiate a price before committing.
                  </span>
                </h2>

                {visibleGroups.map((group) => (
                  <div key={group.key} className="neg-group">
                    <div className="neg-group-header">
                      <strong>{group.label}</strong>
                      {group.orderLink && (
                        <Link className="neg-group-link" to={group.orderLink}>View order →</Link>
                      )}
                    </div>
                    <BidBoard
                      quotes={group.quotes}
                      type={group.type}
                      requestId={group.requestId}
                      orderLink={null}
                      onRespond={(quote, action, amount) => respondBid(group, quote, action, amount)}
                      disabled={!!busyKey}
                    />
                  </div>
                ))}
              </section>
            )}

            {/* ============================================================
                BILATERAL NEGOTIATIONS — listing offers + provider-side quotes
                ============================================================ */}
            {visible.length > 0 && (
              <section className="neg-section" aria-labelledby="bilat-heading">
                {visibleGroups.length > 0 && (
                  <h2 className="neg-section-title" id="bilat-heading">
                    Listing offer negotiations
                  </h2>
                )}
                <div style={{ display: 'grid', gap: 12 }}>
                  {visible.map((item) => (
                    <NegotiationRow
                      key={`${item.type}:${item.id}`}
                      item={item}
                      busyKey={busyKey}
                      counterDraft={counterDrafts[item.id] || ''}
                      onCounterDraftChange={(val) =>
                        setCounterDrafts((prev) => ({ ...prev, [item.id]: val }))
                      }
                      onRespond={respond}
                    />
                  ))}
                </div>
              </section>
            )}

            {!hasAnything && (
              <div className="card notice">No negotiations here yet.</div>
            )}
          </>
        )}

        {toastMsg && <div className="sd-toast">{toastMsg}</div>}
      </div>
    </main>
  );
}
