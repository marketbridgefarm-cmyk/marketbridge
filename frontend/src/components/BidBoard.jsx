import React, { useState } from 'react';
import { Link } from 'react-router-dom';

// ============================================================================
// BID BOARD
// ============================================================================
// Displays ALL competing service-provider quotes on one inspection request or
// transport job. Unlike NegotiationCard (which assumes a bilateral back-and-
// forth between two fixed parties) this component shows N competing providers
// so the requester can compare and hire the best offer.
//
// Two CTAs per active bid:
//   "Hire for X ETB"   → onRespond(quote, 'ACCEPT')
//   "Negotiate"        → expands an inline counter-offer form
//                        → onRespond(quote, 'COUNTER', amount)
//
// Quotes with status COUNTERED stay on the board; the requester can still
// hire a different (PENDING) provider or continue the counter-chain with the
// COUNTERED one.
//
// Props
//   quotes     {array}    Raw quote objects from the order/request.
//                         Expected fields: id, status, amount, message,
//                         parentQuoteId, counteredBy, inspector|truckOwner.
//   type       {string}   'INSPECTION_QUOTE' | 'TRANSPORT_QUOTE'
//   requestId  {string}   Inspection request ID (INSPECTION_QUOTE only)
//   orderLink  {string}   Optional link to the parent order for context
//   onRespond  {function} (quote, action, amount?) => Promise<void>
//              action: 'ACCEPT' | 'COUNTER' | 'REJECT'
//   disabled   {boolean}  Lock all CTAs (viewer is not the requester, or order
//                         is in a state where actions are blocked)
// ============================================================================

const money = (v) => Number(v || 0).toLocaleString();

// Which side needs to act on this counter-chain?
function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

// ---- individual bid card ------------------------------------------------
function BidCard({ quote, type, onRespond, disabled }) {
  const [showCounter, setShowCounter] = useState(false);
  const [counterAmount, setCounterAmount] = useState('');
  const [busy, setBusy] = useState('');

  const provider = quote.inspector || quote.truckOwner || quote.provider || {};
  const isActive    = ['PENDING', 'COUNTERED'].includes(quote.status);
  const isHired     = quote.status === 'ACCEPTED';
  const isRejected  = ['REJECTED', 'EXPIRED'].includes(quote.status);
  const isNeg       = quote.status === 'COUNTERED';
  const turn        = quoteTurn(quote);
  const myTurn      = isNeg && turn === 'REQUESTER';

  async function handle(action) {
    if (busy) return;
    setBusy(action);
    try {
      await onRespond(quote, action, action === 'COUNTER' ? counterAmount : undefined);
      if (action === 'COUNTER') { setShowCounter(false); setCounterAmount(''); }
    } finally {
      setBusy('');
    }
  }

  return (
    <div
      className={[
        'bid-card',
        isHired    ? 'bid-card--hired'     : '',
        isRejected ? 'bid-card--rejected'  : '',
        isNeg      ? 'bid-card--countered' : '',
        myTurn     ? 'bid-card--my-turn'   : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Provider info */}
      <div className="bid-card-header">
        <div className="bid-card-provider">
          <span className="bid-card-avatar" aria-hidden="true">
            {(provider.name || '?').slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong className="bid-card-name">{provider.name || 'Provider'}</strong>
            <div className="bid-card-meta">
              {provider.verificationStatus === 'VERIFIED' && (
                <span className="bid-card-verified">✓ Verified</span>
              )}
              {provider.rating != null && (
                <span className="bid-card-rating">★ {Number(provider.rating).toFixed(1)}</span>
              )}
              {type === 'TRANSPORT_QUOTE' && provider.truckCapacity && (
                <span className="bid-card-spec">{provider.truckCapacity} t</span>
              )}
            </div>
          </div>
        </div>

        {/* Price */}
        <div className="bid-card-price-block">
          <span className="bid-card-price">{money(quote.amount)}</span>
          <span className="bid-card-currency"> ETB</span>
        </div>
      </div>

      {/* Provider message / pitch */}
      {quote.message && <p className="bid-card-message">{quote.message}</p>}

      {/* Negotiation state label */}
      {isNeg && (
        <div className={`bid-card-neg-bar${myTurn ? ' bid-card-neg-bar--mine' : ''}`}>
          {myTurn
            ? '⚡ Provider countered — your turn to respond'
            : '⏳ You countered — waiting for provider response'}
          {quote.counterAmount != null && (
            <strong> · Last offer: {money(quote.counterAmount)} ETB</strong>
          )}
        </div>
      )}

      {/* Hired */}
      {isHired && (
        <div className="bid-card-status-bar bid-card-status-bar--hired">
          ✓ Hired — this inspector is assigned to the order
        </div>
      )}

      {/* Rejected / expired */}
      {isRejected && (
        <div className="bid-card-status-bar bid-card-status-bar--rejected">
          {quote.status === 'EXPIRED' ? 'Quote expired' : 'Not selected'}
        </div>
      )}

      {/* CTAs — only for active quotes when not disabled */}
      {isActive && !disabled && (
        <div className="bid-card-actions">
          {/* Hire directly at quoted/latest price */}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!!busy}
            onClick={() => handle('ACCEPT')}
          >
            {busy === 'ACCEPT'
              ? 'Hiring…'
              : `Hire for ${money(quote.counterAmount ?? quote.amount)} ETB`}
          </button>

          {/* Negotiate (counter-offer) */}
          {!showCounter ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={!!busy}
              onClick={() => setShowCounter(true)}
            >
              {isNeg ? 'Counter again' : 'Negotiate'}
            </button>
          ) : (
            <div className="bid-card-counter-row">
              <input
                type="number"
                min="1"
                step="0.01"
                className="bid-card-counter-input"
                placeholder="Your offer (ETB)"
                value={counterAmount}
                onChange={(e) => setCounterAmount(e.target.value)}
                aria-label="Counter-offer amount"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!counterAmount || !!busy}
                onClick={() => handle('COUNTER')}
              >
                {busy === 'COUNTER' ? 'Sending…' : 'Send offer'}
              </button>
              <button
                type="button"
                className="btn btn-light btn-sm"
                onClick={() => { setShowCounter(false); setCounterAmount(''); }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Reject — only for transport (inspection: just don't hire the others) */}
          {type === 'TRANSPORT_QUOTE' && (
            <button
              type="button"
              className="btn btn-light btn-sm"
              disabled={!!busy}
              onClick={() => handle('REJECT')}
            >
              {busy === 'REJECT' ? 'Rejecting…' : 'Decline'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- the board itself ------------------------------------------------------
export default function BidBoard({ quotes, type, requestId, orderLink, onRespond, disabled }) {
  const [sortBy, setSortBy] = useState('price');

  const active   = quotes.filter((q) => ['PENDING', 'COUNTERED'].includes(q.status));
  const resolved = quotes.filter((q) => !['PENDING', 'COUNTERED'].includes(q.status));

  const sorted = [...active].sort((a, b) => {
    if (sortBy === 'price') return (a.amount || 0) - (b.amount || 0);
    // sort by name
    const na = (a.inspector || a.truckOwner || {}).name || '';
    const nb = (b.inspector || b.truckOwner || {}).name || '';
    return na.localeCompare(nb);
  });

  const myTurnCount = active.filter(
    (q) => q.status === 'COUNTERED' && quoteTurn(q) === 'REQUESTER',
  ).length;

  return (
    <div className="bid-board">
      {/* Board header */}
      <div className="bid-board-header">
        <div className="bid-board-summary">
          <strong>{active.length} active bid{active.length === 1 ? '' : 's'}</strong>
          {myTurnCount > 0 && (
            <span className="bid-board-turn-badge">{myTurnCount} awaiting your response</span>
          )}
          {orderLink && (
            <Link className="bid-board-order-link" to={orderLink}>View order →</Link>
          )}
        </div>
        {active.length > 1 && (
          <div className="bid-board-sort">
            <span>Sort:</span>
            <button
              type="button"
              className={`bid-sort-btn${sortBy === 'price' ? ' active' : ''}`}
              onClick={() => setSortBy('price')}
            >
              Price ↑
            </button>
            <button
              type="button"
              className={`bid-sort-btn${sortBy === 'name' ? ' active' : ''}`}
              onClick={() => setSortBy('name')}
            >
              Name
            </button>
          </div>
        )}
      </div>

      {/* Active bids */}
      {sorted.length === 0 ? (
        <div className="bid-board-empty">
          No bids yet. Registered{' '}
          {type === 'INSPECTION_QUOTE' ? 'inspectors' : 'truck owners'}{' '}
          on the platform can view this request and submit a quote.
        </div>
      ) : (
        <div className="bid-board-list">
          {sorted.map((q) => (
            <BidCard
              key={q.id}
              quote={q}
              type={type}
              requestId={requestId}
              onRespond={onRespond}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      {/* Resolved bids (collapsed) */}
      {resolved.length > 0 && (
        <details className="bid-board-resolved">
          <summary>
            Previous bids ({resolved.length}) — hired or not selected
          </summary>
          <div className="bid-board-list bid-board-list--resolved">
            {resolved.map((q) => (
              <BidCard
                key={q.id}
                quote={q}
                type={type}
                onRespond={onRespond}
                disabled={true}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
