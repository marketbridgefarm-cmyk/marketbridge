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
//                       → PROVISIONAL → CONFIRM (order) or RELEASE (24h + reason + cap)
// 2. TRANSPORT_QUOTE    arranging party ↔ truck owners
// 3. INSPECTION_QUOTE   requester ↔ inspectors
//
// Competition groups render inline as flat sections inside one card.
// Bilateral deals render as NegotiationRow cards.
//
// Notices come from GET /api/notifications, which merges the order-event,
// inspection waiting-list, and transport waiting-list notification tables
// into one timeline. The backend returns each row with a `scope` field
// ('ORDER' | 'INSPECTION' | 'TRANSPORT') so the UI can label where it came
// from without three separate fetches.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

const ACTIVE_QUOTE_STATUSES   = ['PENDING', 'SELECTED', 'COUNTERED'];
const PREVIOUS_QUOTE_STATUSES = ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];
const PRICE_ADJUSTMENT_OPTIONS = [
  { value: 'MARKET_PRICE_RISE', label: 'Seller: perishable-goods market price has risen' },
  { value: 'MARKET_PRICE_FALL', label: 'Buyer: market price has fallen suddenly' },
  { value: 'QUALITY_OR_QUANTITY_CHANGE', label: 'Review due to confirmed quality or quantity difference' },
  { value: 'KEEP_CURRENT_PRICE', label: 'Keep the current negotiated price' },
];
const RELEASE_REASONS = [
  ['PROVIDER_UNAVAILABLE', 'Provider is unavailable'],
  ['NO_RESPONSE', 'Provider is not responding'],
  ['PRICE_CHANGED', 'Price changed'],
  ['SCHEDULE_CONFLICT', 'Schedule conflict'],
  ['OTHER', 'Other (add a note)'],
];

const NOTICE_SCOPE_LABEL = {
  ORDER:      'Order',
  INSPECTION: 'Inspection',
  TRANSPORT:  'Transport',
};

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
    PENDING:     'Bid pending',
    SELECTED:    'Selected',
    COUNTERED:   'Counter-offer',
    PROVISIONAL: 'Provisional agreement',
    ACCEPTED:    'Accepted',
    REJECTED:    'Rejected',
    WITHDRAWN:   'Released',
    EXPIRED:     'Expired',
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

  const hasActiveNegotiation = activeQuotes.some((q) =>
    ['SELECTED', 'COUNTERED'].includes(q.status)
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
                hasActiveNegotiation={hasActiveNegotiation}
              />
            ))}
          </ul>
        )}
      </section>

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
function QuoteRow({ quote, group, busyKey, onRespond, hasActiveNegotiation }) {
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
            hasActiveNegotiation ? (
              <p className="neg-waiting">
                Locked — another bidder is currently in active negotiation.
              </p>
            ) : (
              <button
                type="button"
                className="sd-btn sd-btn-primary"
                disabled={anyBusy}
                onClick={() => onRespond(quote, 'SELECT')}
              >
                {busy('SELECT') ? 'Selecting…' : 'Select for negotiation'}
              </button>
            )
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
                className="sd-btn sd-btn-outline sd-btn-danger"
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
  const [reasonCode, setReasonCode] = React.useState('');
  const [releaseReason, setReleaseReason] = React.useState('');
  const [releaseNote, setReleaseNote] = React.useState('');

  const requiresReason = item.type === 'LISTING_OFFER';
  const canSubmitCounter = counterValid && (!requiresReason || Boolean(reasonCode));

  const isProvisional = item.type === 'LISTING_OFFER' && item.status === 'PROVISIONAL';
  const provisionalAvailableAt = isProvisional && item.raw?.provisionalReleaseAvailableAt
    ? new Date(item.raw.provisionalReleaseAvailableAt)
    : null;
  const releaseUnlocked = !provisionalAvailableAt || provisionalAvailableAt.getTime() <= Date.now();
  const needsReleaseNote = releaseReason === 'OTHER';
  const canSubmitRelease =
    Boolean(releaseReason) && (!needsReleaseNote || releaseNote.trim().length > 0);

  let canAct        = false;
  let acceptAction  = 'ACCEPT';
  let counterAction = 'COUNTER';
  let waitingMessage = null;

  if (item.type === 'LISTING_OFFER') {
    if (item.status === 'PROVISIONAL') {
      canAct = false;
    } else if (item.viewerRole === 'SELLER') {
      if (item.status === 'PENDING') {
        if (item.listingLocked) {
          waitingMessage = 'Waiting list locked: you are negotiating with a selected buyer or an order is in progress. You can select another bid when that buyer rejects, you release a silent buyer, or the order is cancelled.';
        } else {
          canAct = true;
          acceptAction = 'SELECT';
        }
      } else {
        canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'BUYER');
        if (!canAct && item.status === 'COUNTERED' && item.counteredBy === 'SELLER')
          waitingMessage = 'You made the latest counter. Waiting for the buyer.';
      }
    } else {
      acceptAction  = item.status === 'SELECTED' ? 'ACCEPT_SELECTED' : 'ACCEPT_COUNTER';
      counterAction = 'RE_COUNTER';
      canAct = item.status === 'SELECTED' || (item.status === 'COUNTERED' && item.counteredBy === 'SELLER');
      if (!canAct && item.status === 'PENDING') waitingMessage = 'You are on the seller\'s waiting list. The seller can select you only when the current negotiation or order ends. You will be notified, and you can leave the list at any time.';
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

  if (expired && ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(item.status)) {
    canAct = false;
    waitingMessage = 'This quote has expired.';
  }

  const myTurn = canAct && !waitingMessage;

  return (
    <article className={`neg-card${myTurn ? ' neg-card--my-turn' : ''}${isProvisional ? ' neg-card--provisional' : ''}`}>
      {myTurn && <span className="neg-turn-label" aria-label="Your turn">⚡ Your turn</span>}
      {isProvisional && <span className="neg-turn-label" aria-label="Provisional">⏳ Provisional</span>}

      <header className="neg-card-head">
        <div className="neg-card-head-main">
          <span className="neg-eyebrow">
            {item.type === 'LISTING_OFFER' ? 'LISTING OFFER'
              : item.type === 'TRANSPORT_QUOTE' ? 'TRANSPORT'
              : 'INSPECTION'}
          </span>
          <h3 className="neg-title">{item.title}</h3>
          {item.type !== 'LISTING_OFFER' && item.subtitle && (
            <p className="neg-card-subtitle">{item.subtitle}</p>
          )}
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

      {item.type === 'LISTING_OFFER' && item.marketReference?.unitPrice > 0 && (
        <p className="neg-deal-context">
          Market reference: <strong>{item.marketReference.unitPrice.toLocaleString()} ETB/{item.raw?.listing?.unit || 'unit'}</strong>
          {item.marketReference.sampleSize ? ` · ${item.marketReference.sampleSize} comparable ${item.marketReference.source === 'RECENT_COMPLETED_ORDERS' ? 'sales' : 'listings'}` : ''}
          {item.marketReference.minUnitPrice > 0 && item.marketReference.maxUnitPrice > 0 ? ` · range ${item.marketReference.minUnitPrice.toLocaleString()}–${item.marketReference.maxUnitPrice.toLocaleString()} ETB` : ''}.
          <span className="muted"> Advisory only — it does not change the negotiated price.</span>
        </p>
      )}

      {item.message && <p className="neg-deal-context">{item.message}</p>}

      {waitingMessage && <p className="neg-waiting">{waitingMessage}</p>}

      {item.status === 'REJECTED' && (
        <p className="neg-waiting">This negotiation was rejected.</p>
      )}

      {item.status === 'ACCEPTED' && (
        <p className="neg-deal-context">
          Agreement at <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>. Order created.
        </p>
      )}

      {isProvisional && (
        <>
          <p className="neg-deal-context">
            A provisional price of <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong> has been agreed.
            Either party can confirm to create the order.
          </p>

          <div className="neg-actions">
            <button
              type="button"
              className="sd-btn sd-btn-primary"
              disabled={anyBusy}
              onClick={() => onRespond(item, 'CONFIRM_PROVISIONAL')}
            >
              {busy('CONFIRM_PROVISIONAL') ? 'Confirming…' : 'Confirm & create order'}
            </button>
          </div>

          {releaseUnlocked ? (
            <div className="neg-actions">
              <select
                className="neg-reason-picker"
                aria-label="Reason for releasing"
                value={releaseReason}
                onChange={(e) => setReleaseReason(e.target.value)}
                disabled={anyBusy}
              >
                <option value="">Choose a reason (required)</option>
                {RELEASE_REASONS.map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
              {needsReleaseNote && (
                <input
                  type="text"
                  className="neg-counter-picker"
                  maxLength={200}
                  placeholder="Short note"
                  value={releaseNote}
                  onChange={(e) => setReleaseNote(e.target.value)}
                  disabled={anyBusy}
                />
              )}
              <button
                type="button"
                className="sd-btn sd-btn-outline sd-btn-danger"
                disabled={!canSubmitRelease || anyBusy}
                onClick={() => onRespond(item, 'RELEASE_PROVISIONAL', null, undefined, releaseReason, releaseNote)}
              >
                {busy('RELEASE_PROVISIONAL') ? 'Releasing…' : 'Release provisional'}
              </button>
            </div>
          ) : (
            <p className="neg-waiting">
              Release opens {provisionalAvailableAt.toLocaleString()} (24h after the provisional agreement).
            </p>
          )}

          <p className="neg-deal-context muted">
            Releasing a provisional agreement is recorded against your account. After 2 provisional releases on this listing, further releases require admin review.
          </p>
        </>
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
              : (acceptAction === 'SELECT' ? 'Select buyer for negotiation' : 'Agree price (provisional)')}
          </button>

          {!(item.type === 'LISTING_OFFER' && item.viewerRole === 'SELLER') && (
            <button
              type="button"
              className="sd-btn sd-btn-outline sd-btn-danger"
              disabled={anyBusy}
              onClick={() => onRespond(item, 'REJECT')}
            >
              {busy('REJECT') ? 'Rejecting…' : 'Reject'}
            </button>
          )}

          {requiresReason && (
            <select
              className="neg-reason-picker"
              aria-label="Price adjustment reason"
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
              disabled={anyBusy}
            >
              <option value="">Choose a reason (required)</option>
              {PRICE_ADJUSTMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
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
            disabled={!canSubmitCounter || anyBusy}
            onClick={() => onRespond(item, counterAction, counterValue, reasonCode || undefined)}
          >
            {busy(counterAction) ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}

      {item.type === 'LISTING_OFFER' && item.viewerRole === 'SELLER' && item.raw?.releaseAvailableAt && ['SELECTED', 'COUNTERED'].includes(item.status) && (
        <div className="neg-actions">
          {new Date(item.raw.releaseAvailableAt).getTime() <= Date.now() ? (
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              disabled={anyBusy}
              onClick={() => onRespond(item, 'RELEASE')}
            >
              {busy('RELEASE') ? 'Releasing…' : 'Release buyer (no response)'}
            </button>
          ) : (
            <p className="neg-deal-context">
              If the buyer stays silent you can release them from {new Date(item.raw.releaseAvailableAt).toLocaleString()}. The buyer can bid again.
            </p>
          )}
        </div>
      )}

      {item.type === 'LISTING_OFFER' && item.viewerRole === 'BUYER' && item.status === 'PENDING' && !expired && (
        <div className="neg-actions">
          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={anyBusy}
            onClick={() => onRespond(item, 'WITHDRAW')}
          >
            {busy('WITHDRAW') ? 'Leaving…' : 'Leave waiting list'}
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
  const [notices,       setNotices]       = useState([]);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), 2500);
  }, []);

  const markNoticesRead = useCallback(async () => {
    try {
      await api.post('/notifications/read-all');
      setNotices((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
    } catch (_) { /* ignore */ }
  }, []);

  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setError('');
    const roles     = user.roles || [];
    const collected = [];
    const groups    = [];

    // Unified notification feed: order events + inspection waiting-list +
    // transport waiting-list, merged server-side into one array.
    api.get('/notifications', { params: { limit: 50 } })
      .then((res) => setNotices(res.data?.notifications || []))
      .catch(() => {});

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

      const leafOffers = leavesOnly([...buyerOffers, ...sellerOffers], 'parentOfferId');
      const lockedListingIds = new Set(
        leafOffers
          .filter((o) => o.viewerRole === 'SELLER' && ['SELECTED', 'COUNTERED', 'PROVISIONAL', 'ACCEPTED'].includes(o.status))
          .map((o) => o.listingId)
      );

      leafOffers.forEach((offer) => {
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
          listingLocked: offer.viewerRole === 'SELLER' && offer.status === 'PENDING' && lockedListingIds.has(offer.listingId),
          marketReference: offer.marketReferenceUnitPrice ? { unitPrice: Number(offer.marketReferenceUnitPrice), source: offer.marketReferenceSource, sampleSize: offer.marketSampleSize, minUnitPrice: Number(offer.marketMinUnitPrice || 0), maxUnitPrice: Number(offer.marketMaxUnitPrice || 0) } : null,
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
              raw:         { jobId: job.id, quoteId: quote.id },
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
  const respond = useCallback(async (item, action, counterAmount, reasonCode, releaseReason, releaseNote) => {
    const key = `${item.id}:${action}`;
    setBusyKey(key);
    try {
      let response;
      if (item.type === 'LISTING_OFFER') {
        const payload = { action };
        if (action === 'COUNTER' || action === 'RE_COUNTER') {
          payload.counterAmount = Number(counterAmount);
          if (reasonCode) payload.reasonCode = reasonCode;
        }
        if (action === 'RELEASE_PROVISIONAL') {
          payload.reason = releaseReason;
          if (releaseNote) payload.note = releaseNote;
        }
        response = await api.patch(`/offers/${item.raw.id}`, payload);
      } else if (item.type === 'TRANSPORT_QUOTE') {
        const base = `/transport/${item.raw.jobId}/quotes/${item.raw.quoteId}`;
        if (action === 'SELECT')       response = await api.patch(`${base}/select`);
        else if (action === 'ACCEPT')  response = await api.patch(`${base}/accept`);
        else if (action === 'REJECT')  response = await api.patch(`${base}/reject`);
        else if (action === 'WITHDRAW') response = await api.patch(`${base}/withdraw`);
        else if (action === 'COUNTER') response = await api.post(`${base}/counter`, { counterAmount: Number(counterAmount) });
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
        const base = `/transport/${group.jobId}/quotes/${quote.id}`;
        if (action === 'SELECT')       response = await api.patch(`${base}/select`);
        else if (action === 'ACCEPT')  response = await api.patch(`${base}/accept`);
        else if (action === 'REJECT')  response = await api.patch(`${base}/reject`);
        else if (action === 'WITHDRAW') response = await api.patch(`${base}/withdraw`);
        else if (action === 'COUNTER') response = await api.post(`${base}/counter`, { counterAmount: Number(counterAmount) });
      }
      toast(
        response?.data?.message ||
        (action === 'ACCEPT' ? '✓ Provider selected and agreed!'
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
    let list = [...items].sort((a, b) => {
      const aActive = ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(a.status);
      const bActive = ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(b.status);
      if (aActive === bActive) return 0;
      return aActive ? -1 : 1;
    });
    if (filter === 'active') list = list.filter((i) => ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL'].includes(i.status));
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter);
    return list;
  }, [items, filter, typeFilter]);

  const visibleGroups = compGroups.filter((g) =>
    typeFilter === 'all' || g.type === typeFilter
  );

  const hasAnything = visibleGroups.length > 0 || visible.length > 0;
  const unreadNotices = notices.filter((n) => !n.readAt);

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

        {unreadNotices.length > 0 && (
          <section className="card neg-notices" aria-label="Waiting list and order updates">
            <h2 className="neg-notices-title">Updates on your bids</h2>
            {unreadNotices.slice(0, 5).map((n) => (
              <p key={`${n.scope || 'ORDER'}:${n.id}`} className="neg-notices-item">
                {n.scope && (
                  <span className="role-chip" style={{ marginRight: 6 }}>
                    {NOTICE_SCOPE_LABEL[n.scope] || n.scope}
                  </span>
                )}
                <strong>{n.title}.</strong> {n.body}
              </p>
            ))}
            <button type="button" className="sd-btn sd-btn-outline" onClick={markNoticesRead}>
              Mark all as read
            </button>
          </section>
        )}

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
