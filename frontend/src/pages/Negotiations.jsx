import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import './negotiations/Negotiations.css';

// ============================================================================
// NEGOTIATIONS — unified hub for all three negotiation types
// ============================================================================
//
// 1. LISTING_OFFER      many buyers → seller selection → bilateral negotiation
// 2. TRANSPORT_QUOTE    arranging party ↔ truck owners
// 3. INSPECTION_QUOTE   requester ↔ inspectors
//
// Competition groups render inline as flat sections inside one card.
// Bilateral deals render as NegotiationRow cards.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

const ACTIVE_QUOTE_STATUSES   = ['PENDING', 'SELECTED', 'COUNTERED'];
const PREVIOUS_QUOTE_STATUSES = ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];

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

function leavesOnly(items, parentKey) {
  const parentIds = new Set(items.map((i) => i[parentKey]).filter(Boolean));
  return items.filter((i) => !parentIds.has(i.id));
}

function humanStatus(status) {
  return ({
    PENDING:   'Bid pending',
    SELECTED:  'Selected',
    COUNTERED: 'Counter-offer',
    ACCEPTED:  'Accepted',
    REJECTED:  'Rejected',
    WITHDRAWN: 'Released',
    EXPIRED:   'Expired',
  }[status] || String(status || '').replaceAll('_', ' '));
}

function amountOf(item) {
  const v = item.status === 'COUNTERED' ? (item.counterAmount ?? item.amount) : item.amount;
  return Number(v);
}

function providerOf(quote) {
  return quote.truckOwner || quote.inspector || quote.provider || {};
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || '?';
}

// ============================================================================
// CompetitionGroup — one card per inspection request / transport job
// ============================================================================
function CompetitionGroup({ group, busyKey, onRespond }) {
  const providerLabel =
    group.type === 'INSPECTION_QUOTE' ? 'inspectors' : 'truck owners';

  const activeQuotes = (group.quotes || []).filter((q) =>
    ACTIVE_QUOTE_STATUSES.includes(q.status)
  );
  const previousQuotes = (group.quotes || []).filter((q) =>
    PREVIOUS_QUOTE_STATUSES.includes(q.status)
  );

  const typeLabel =
    group.type === 'INSPECTION_QUOTE' ? 'Inspection' : 'Transport';

  return (
    <article className="neg-group">
      <header className="neg-group-head">
        <div className="neg-group-head-main">
          <span className="neg-eyebrow">{typeLabel.toUpperCase()}</span>
          <h2 className="neg-group-title">{group.label}</h2>
        </div>
        <div className="neg-group-head-side">
          <span className="neg-side-label">Status</span>
          <span className="neg-side-value">
            {activeQuotes.length > 0 ? 'Open' : 'Awaiting bids'}
          </span>
        </div>
      </header>

      {/* ── Active bids ────────────────────────────────────── */}
      <section className="neg-subsection">
        <div className="neg-subsection-head">
          <h3 className="neg-subsection-title">Active bids</h3>
          <span className="neg-subsection-meta">{activeQuotes.length}</span>
        </div>

        {activeQuotes.length === 0 ? (
          <p className="neg-empty">
            No bids yet. Registered {providerLabel} on the platform can view this
            request and submit a quote.
          </p>
        ) : (
          <ul className="neg-quote-list">
            {activeQuotes.map((quote) => (
              <QuoteRow
                key={quote.id}
                quote={quote}
                group={group}
                busyKey={busyKey}
                onRespond={onRespond}
              />
            ))}
          </ul>
        )}
      </section>

{/* ── Previous bids ──────────────────────────────────── */}
{previousQuotes.length > 0 && (
  <section className="neg-subsection neg-subsection--previous">
    <div className="neg-subsection-head">
      <h3 className="neg-subsection-title">Previous bids</h3>
      <span className="neg-subsection-meta">{previousQuotes.length}</span>
    </div>

    <details className="neg-previous">
      <summary className="neg-previous-summary">
        Check here — hired or not selected
      </summary>
      <ul className="neg-quote-list neg-quote-list--muted">
        {previousQuotes.map((quote) => (
          <PreviousQuoteRow key={quote.id} quote={quote} />
        ))}
      </ul>
    </details>
  </section>
)}

      {/* ── Notice + footer action ─────────────────────────── */}
      <footer className="neg-group-footer">
        <div className="neg-notice">
          <span className="neg-notice-prefix">Notice:</span>
          <ol className="neg-notice-list">
            <li>Competition stays open until commitment.</li>
            <li>
              Selection is not commitment. Selecting a provider opens negotiation.
              Payment is the commercial commitment.
            </li>
          </ol>
        </div>

        {group.orderLink && (
          <Link className="btn btn-outline" to={group.orderLink}>
            View order →
          </Link>
        )}
      </footer>
    </article>
  );
}

// ============================================================================
// QuoteRow — one active bid (competitive or in negotiation)
// ============================================================================
function QuoteRow({ quote, group, busyKey, onRespond }) {
  const provider = providerOf(quote);
  const amount = amountOf(quote);
  const busy = (action) => busyKey === `bid:${quote.id}:${action}`;
  const anyBusy = Boolean(busyKey) && busyKey.startsWith(`bid:${quote.id}:`);

  const turn = quoteTurn(quote);
  const myTurn = turn === 'REQUESTER' && ACTIVE_QUOTE_STATUSES.includes(quote.status);
  const isPending = quote.status === 'PENDING';
  const waitingOnProvider = quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';

  const [counterDraft, setCounterDraft] = React.useState('');
  const counterValue = Number(counterDraft);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;

  const metaParts = [
    provider.location,
    provider.rating != null && `★ ${Number(provider.rating).toFixed(1)}`,
    provider.verificationStatus,
  ].filter(Boolean);

  return (
    <li className="neg-quote-row">
      <div className="neg-quote-main">
        <div className="neg-quote-head">
          <strong className="neg-quote-name">{provider.name || 'Provider'}</strong>
          <span className="neg-quote-amount">
            {Number.isFinite(amount) ? amount.toLocaleString() : '—'}{' '}
            <small>ETB</small>
          </span>
          <span className="role-chip">{humanStatus(quote.status)}</span>
        </div>

        {metaParts.length > 0 && (
          <p className="neg-quote-meta">{metaParts.join(' · ')}</p>
        )}

        {quote.message && (
          <p className="neg-quote-message">"{quote.message}"</p>
        )}

        {waitingOnProvider && (
          <p className="neg-quote-waiting">
            You countered {Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB
            {' — waiting for the provider to respond.'}
          </p>
        )}
      </div>

      {myTurn && (
        <div className="neg-quote-actions">
          {isPending && (
            <button
              type="button"
              className="sd-btn sd-btn-primary"
              disabled={anyBusy}
              onClick={() => onRespond(quote, 'SELECT')}
            >
              {busy('SELECT') ? 'Selecting…' : 'Select for negotiation'}
            </button>
          )}

          {!isPending && (
            <>
              <button
                type="button"
                className="sd-btn sd-btn-primary"
                disabled={anyBusy}
                onClick={() => onRespond(quote, 'ACCEPT')}
              >
                {busy('ACCEPT') ? 'Accepting…' : 'Accept deal'}
              </button>

              <button
                type="button"
                className="sd-btn sd-btn-outline"
                disabled={anyBusy}
                onClick={() => onRespond(quote, 'REJECT')}
              >
                {busy('REJECT') ? 'Rejecting…' : 'Reject'}
              </button>

              <AmountPicker
                className="neg-counter-picker"
                reference={amountOf(quote)}
                placeholder="Counter (ETB)"
                value={counterDraft}
                disabled={anyBusy}
                onChange={setCounterDraft}
                ariaLabel="Counter amount in ETB"
              />

              <button
                type="button"
                className="sd-btn sd-btn-outline"
                disabled={!counterValid || anyBusy}
                onClick={() => onRespond(quote, 'COUNTER', counterValue)}
              >
                {busy('COUNTER') ? 'Sending…' : 'Counter'}
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function PreviousQuoteRow({ quote }) {
  const provider = providerOf(quote);
  const amount = amountOf(quote);
  const metaParts = [
    provider.location,
    provider.rating != null && `★ ${Number(provider.rating).toFixed(1)}`,
  ].filter(Boolean);

  return (
    <li className="neg-quote-row neg-quote-row--muted">
      <div className="neg-quote-main">
        <div className="neg-quote-head">
          <strong className="neg-quote-name">{provider.name || 'Provider'}</strong>
          <span className="neg-quote-amount">
            {Number.isFinite(amount) ? amount.toLocaleString() : '—'}{' '}
            <small>ETB</small>
          </span>
          <span className="role-chip">{humanStatus(quote.status)}</span>
        </div>
        {metaParts.length > 0 && (
          <p className="neg-quote-meta">{metaParts.join(' · ')}</p>
        )}
      </div>
    </li>
  );
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

      <header className="neg-card-head">
        <div className="neg-card-head-main">
          <span className="neg-eyebrow">
            {item.type === 'LISTING_OFFER' ? 'LISTING OFFER'
              : item.type === 'TRANSPORT_QUOTE' ? 'TRANSPORT'
              : 'INSPECTION'}
          </span>
          <h3 className="neg-title">{item.title}</h3>
          <p className="neg-card-subtitle">{item.subtitle}</p>
        </div>
        <div className="neg-card-head-side">
          <span className="neg-side-label">Current</span>
          <span className="neg-side-value">
            {Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB
          </span>
        </div>
      </header>

      <div className="neg-deal-status">
        <span className="role-chip">{humanStatus(item.status)}</span>
        {item.viewerRole && <span className="role-chip">You are the {item.viewerRole.toLowerCase()}</span>}
      </div>

      {item.message && <p className="neg-deal-context">{item.message}</p>}

      {waitingMessage && <p className="neg-waiting">{waitingMessage}</p>}

      {item.status === 'REJECTED' && (
        <p className="neg-waiting">This negotiation was rejected.</p>
      )}

      {item.status === 'ACCEPTED' && (
        <p className="neg-deal-context">
          Provisional agreement at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>.
        </p>
      )}

      {canAct && (
        <div className="neg-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={anyBusy}
            onClick={() => onRespond(item, acceptAction)}
          >
            {busy(acceptAction)
              ? (acceptAction === 'SELECT' ? 'Selecting…' : 'Accepting…')
              : (acceptAction === 'SELECT' ? 'Select buyer for negotiation' : 'Accept provisional deal')}
          </button>

          {!(item.type === 'LISTING_OFFER' && item.viewerRole === 'BUYER') && (
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              disabled={anyBusy}
              onClick={() => onRespond(item, 'REJECT')}
            >
              {busy('REJECT') ? 'Rejecting…' : 'Reject'}
            </button>
          )}

          <AmountPicker
            className="neg-counter-picker"
            reference={amountOf(item)}
            placeholder="Counter (ETB)"
            value={counterDraft}
            disabled={anyBusy}
            onChange={onCounterDraftChange}
            ariaLabel="Counter amount in ETB"
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

      {item.linkTo && (
        <footer className="neg-card-footer">
          <Link className="btn btn-outline" to={item.linkTo}>Open listing →</Link>
        </footer>
      )}
    </article>
  );
}

// ============================================================================
// Main page
// ============================================================================
export default function Negotiations() {
  const { user } = useAuth();

  const [compGroups,    setCompGroups]    = useState([]);
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
      // ---- 1. Listing offers ---------------------------------------------
      const [mineRes, listingResults] = await Promise.all([
        api.get('/offers/mine'),
        Promise.all(
          SELLER_LISTING_STATUSES.map((s) =>
            api.get('/listings', { params: { sellerId: user.id, status: s } })
          )
        ),
      ]);

      const buyerOffers = (mineRes.data?.offers || []).map((o) => ({ ...o, viewerRole: 'BUYER' }));
      const myListings  = listingResults.flatMap((r) => r.data?.listings || []);
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

      // ---- 2. Transport & inspection, REQUESTER side ---------------------
      const ordersRes = await api.get('/orders');
      const orders    = ordersRes.data?.orders || [];

      orders.forEach((order) => {
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

      // ---- 3. Transport quotes, PROVIDER side ----------------------------
      if (roles.includes('TRUCK_OWNER')) {
        const openRes = await api.get('/transport/open');
        (openRes.data?.jobs || []).forEach((job) => {
          const myQuotes = leavesOnly(job.quotes || [], 'parentQuoteId').filter((q) =>
            ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status)
          );
          myQuotes.forEach((quote) => {
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

      // ---- 4. Inspection quotes, PROVIDER side ---------------------------
      if (roles.includes('INSPECTOR')) {
        const availableRes = await api.get('/inspections/available');
        (availableRes.data?.requests || []).forEach((request) => {
          const myQuotes = leavesOnly(request.quotes || [], 'parentQuoteId').filter((q) =>
            ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED', 'REJECTED'].includes(q.status)
          );
          myQuotes.forEach((quote) => {
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

  // ---- Respond: competition group (inline BidBoard actions) --------------
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
      toast(
        response?.data?.message ||
        (action === 'ACCEPT' ? '✓ Provider hired!'
          : action === 'SELECT' ? 'Bid selected — negotiation opened.'
          : 'Offer sent.')
      );
      await loadAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not update this bid.');
    } finally {
      setBusyKey('');
    }
  }, [loadAll, toast]);

  // ---- Filters -----------------------------------------------------------
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
    <main className="section neg-page">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">
          Agree on price and terms for listings, transport, and inspections — as either party.
        </p>

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
            {visibleGroups.length > 0 && (
              <section className="neg-section" aria-labelledby="comp-heading">
                <h2 className="neg-section-title" id="comp-heading">
                  Select a service provider
                  <span className="neg-section-sub">
                    Review every competing quote, select one provider for bilateral negotiation, then confirm payment when you are ready to commit.
                  </span>
                </h2>

                {visibleGroups.map((group) => (
                  <CompetitionGroup
                    key={group.key}
                    group={group}
                    busyKey={busyKey}
                    onRespond={(quote, action, amount) => respondBid(group, quote, action, amount)}
                  />
                ))}
              </section>
            )}

            {visible.length > 0 && (
              <section className="neg-section" aria-labelledby="bilat-heading">
                {visibleGroups.length > 0 && (
                  <h2 className="neg-section-title" id="bilat-heading">
                    Active deals & negotiations
                    <span className="neg-section-sub">
                      Offers and counters are provisional. Payment is what commits the agreed transaction or service.
                    </span>
                  </h2>
                )}
                <div className="neg-deal-list">
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
