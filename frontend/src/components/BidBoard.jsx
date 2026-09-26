import React, { useState } from 'react';
import { Link } from 'react-router-dom';

// ============================================================================
// BID BOARD — competitive service-provider quote selection
// ============================================================================
//
// Shows ALL competing quotes on one inspection request or transport job so
// the requester can compare and hire. There are two sequential phases:
//
//  COMPETITION phase  (quote.status === 'PENDING')
//    Any number of providers have submitted bids. The requester reviews them
//    all and picks one with the "Select for negotiation" button.
//    → PATCH /inspections/:id/quotes/:qid/select   (inspection)
//    → PATCH /transport/quotes/:qid/select          (transport)
//    The backend marks that quote SELECTED and keeps the others PENDING so
//    the requester can still switch to a different provider later.
//
//  NEGOTIATION phase  (quote.status === 'SELECTED' or 'COUNTERED')
//    Exactly one quote is in negotiation at a time. The requester can:
//      Accept  → PATCH …/accept  (inspection) | PATCH …/quotes/:id {ACCEPT}
//      Counter → POST  …/counter {counterAmount}  | PATCH …/quotes/:id {COUNTER}
//      Reject  → PATCH …/reject  | PATCH …/quotes/:id {REJECT}
//    While this negotiation runs the other PENDING bids remain visible.
//    The requester can SELECT a different one at any time (the backend
//    atomically moves the current SELECTED back to PENDING).
//
// Props
//   quotes     {array}    Raw quote objects (all statuses).
//                         Fields used: id, status, amount, counterAmount,
//                         counteredBy, message, parentQuoteId,
//                         inspector | truckOwner | provider.
//   type       {string}   'INSPECTION_QUOTE' | 'TRANSPORT_QUOTE'
//   requestId  {string}   Inspection request ID (INSPECTION_QUOTE only)
//   orderLink  {string?}  Link shown in the board header
//   onRespond  {fn}       (quote, action, amount?) => Promise<void>
//                         action: 'SELECT' | 'ACCEPT' | 'COUNTER' | 'REJECT'
//   disabled   {boolean}  Lock all CTAs (not the requester, or order closed)
// ============================================================================

const money = (v) => Number(v || 0).toLocaleString();

// Back-end turn rule — mirrors routes/inspections.js and routes/transport.js
function quoteTurn(quote) {
  if (quote.status === 'PENDING')   return 'REQUESTER'; // requester picks from competition
  if (quote.status === 'SELECTED')  return 'REQUESTER'; // requester acts first after selecting
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

// ---- Individual bid card ------------------------------------------------
function BidCard({ quote, type, onRespond, disabled }) {
  const [showCounter, setShowCounter] = useState(false);
  const [counterAmount, setCounterAmount] = useState('');
  const [busy, setBusy] = useState('');

  const provider   = quote.inspector || quote.truckOwner || quote.provider || {};
  const isPending  = quote.status === 'PENDING';
  const isSelected = quote.status === 'SELECTED';
  const isNeg      = quote.status === 'COUNTERED';
  const isActive   = isPending || isSelected || isNeg;
  const isHired    = quote.status === 'ACCEPTED';
  const isDone     = ['REJECTED', 'EXPIRED'].includes(quote.status);
  const turn       = quoteTurn(quote);
  // In BidBoard the viewer is always the REQUESTER
  const myTurn     = isSelected || (isNeg && turn === 'REQUESTER');
  const waiting    = isNeg && turn === 'PROVIDER';

  // Current effective price — use counterAmount when in negotiation
  const displayAmount = (isNeg || isHired) && quote.counterAmount != null
    ? quote.counterAmount
    : quote.amount;

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
    <div className={[
      'bid-card',
      isPending  ? 'bid-card--pending'   : '',
      isSelected ? 'bid-card--selected'  : '',
      isNeg      ? 'bid-card--countered' : '',
      myTurn     ? 'bid-card--my-turn'   : '',
      isHired    ? 'bid-card--hired'     : '',
      isDone     ? 'bid-card--rejected'  : '',
    ].filter(Boolean).join(' ')}>

      {/* ---- Provider row ---- */}
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

        <div className="bid-card-price-block">
          <span className="bid-card-price">{money(displayAmount)}</span>
          <span className="bid-card-currency"> ETB</span>
          {isSelected && (
            <div style={{ textAlign: 'right', marginTop: 3 }}>
              <span className="bid-card-verified" style={{ fontSize: 10 }}>Selected</span>
            </div>
          )}
        </div>
      </div>

      {/* Optional pitch message */}
      {quote.message && <p className="bid-card-message">{quote.message}</p>}

      {/* Negotiation state bar */}
      {(isSelected || isNeg) && (
        <div className={`bid-card-neg-bar${myTurn ? ' bid-card-neg-bar--mine' : ''}`}>
          {isSelected && myTurn && '⚡ You selected this bid — accept, counter, or reject below'}
          {isNeg && myTurn && `⚡ Provider countered · last offer: ${money(quote.counterAmount)} ETB — your turn`}
          {isNeg && waiting && `⏳ You offered ${money(quote.counterAmount)} ETB — waiting for provider`}
        </div>
      )}

      {/* Hired */}
      {isHired && (
        <div className="bid-card-status-bar bid-card-status-bar--hired">
          ✓ Hired — {type === 'INSPECTION_QUOTE' ? 'inspector' : 'transporter'} assigned
        </div>
      )}

      {/* Rejected / expired */}
      {isDone && (
        <div className="bid-card-status-bar bid-card-status-bar--rejected">
          {quote.status === 'EXPIRED' ? 'Quote expired' : 'Not selected'}
        </div>
      )}

      {/* ---- CTAs ---- */}
      {isActive && !disabled && (
        <div className="bid-card-actions">

          {/* COMPETITION PHASE — PENDING: only action is SELECT */}
          {isPending && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={!!busy}
              onClick={() => handle('SELECT')}
            >
              {busy === 'SELECT' ? 'Selecting…' : 'Select for negotiation'}
            </button>
          )}

          {/* NEGOTIATION PHASE — SELECTED or COUNTERED (my turn): ACCEPT + Counter + Reject */}
          {myTurn && (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() => handle('ACCEPT')}
              >
                {busy === 'ACCEPT'
                  ? 'Hiring…'
                  : `Hire for ${money(displayAmount)} ETB`}
              </button>

              {!showCounter ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={!!busy}
                  onClick={() => setShowCounter(true)}
                >
                  {isNeg ? 'Counter again' : 'Negotiate price'}
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
                    autoFocus
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

              <button
                type="button"
                className="btn btn-light btn-sm"
                disabled={!!busy}
                onClick={() => handle('REJECT')}
                style={{ marginLeft: 'auto' }}
              >
                {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---- The board ----------------------------------------------------------
export default function BidBoard({ quotes, type, requestId, orderLink, onRespond, disabled }) {
  const [sortBy, setSortBy] = useState('price');

  if (!Array.isArray(quotes) || quotes.length === 0) return null;

  const active   = quotes.filter((q) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status));
  const resolved = quotes.filter((q) => !['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status));

  // Within each provider's counter-chain keep only the leaf (most recent).
  // Quotes from different providers have no parent-child link so they are all kept.
  const leafActive = (() => {
    const parentIds = new Set(active.map((q) => q.parentQuoteId).filter(Boolean));
    return active.filter((q) => !parentIds.has(q.id));
  })();

  const sorted = [...leafActive].sort((a, b) => {
    if (sortBy === 'price') return (a.amount || 0) - (b.amount || 0);
    const na = (a.inspector || a.truckOwner || {}).name || '';
    const nb = (b.inspector || b.truckOwner || {}).name || '';
    return na.localeCompare(nb);
  });

  const myTurnCount = leafActive.filter(
    (q) => q.status === 'SELECTED' || (q.status === 'COUNTERED' && quoteTurn(q) === 'REQUESTER'),
  ).length;

  return (
    <div className="bid-board">
      {/* Header */}
      <div className="bid-board-header">
        <div className="bid-board-summary">
          <strong>
            {leafActive.length} active bid{leafActive.length === 1 ? '' : 's'}
          </strong>
          {myTurnCount > 0 && (
            <span className="bid-board-turn-badge">{myTurnCount} awaiting your response</span>
          )}
          {orderLink && (
            <Link className="bid-board-order-link" to={orderLink}>View order →</Link>
          )}
        </div>
        {leafActive.length > 1 && (
          <div className="bid-board-sort">
            <span>Sort:</span>
            <button type="button" className={`bid-sort-btn${sortBy === 'price' ? ' active' : ''}`}
              onClick={() => setSortBy('price')}>Price ↑</button>
            <button type="button" className={`bid-sort-btn${sortBy === 'name' ? ' active' : ''}`}
              onClick={() => setSortBy('name')}>Name</button>
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

      {/* Resolved bids */}
      {resolved.length > 0 && (
        <details className="bid-board-resolved">
          <summary>Previous bids ({resolved.length}) — hired or not selected</summary>
          <div className="bid-board-list bid-board-list--resolved">
            {resolved.map((q) => (
              <BidCard key={q.id} quote={q} type={type} onRespond={onRespond} disabled={true} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
