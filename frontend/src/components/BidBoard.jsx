import React, { useState } from 'react';
import AmountPicker from './AmountPicker.jsx';
import { Link } from 'react-router-dom';
import './BidBoard.css';

// ============================================================================
// BID BOARD — competitive service-provider quote selection
// ============================================================================
// Same props and API contract as the previous version. The visual change is
// that bids render as flat rows inside the host card, not as bordered cards.
// ============================================================================

const money = (v) => Number(v || 0).toLocaleString();

function quoteTurn(quote) {
  if (quote.status === 'PENDING')   return 'REQUESTER';
  if (quote.status === 'SELECTED')  return 'REQUESTER';
  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
  }
  return null;
}

function isQuoteExpired(quote) {
  return Boolean(quote.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
}

function supersededIds(quotes) {
  const ids = new Set(quotes.map((q) => q.parentQuoteId).filter(Boolean));
  quotes.forEach((q) => { if ((q._count?.childQuotes || 0) > 0) ids.add(q.id); });
  return ids;
}

// Amount currently on the table (the latest counter, if any).
function shownAmount(q) {
  const v = (q.status === 'COUNTERED' || q.status === 'ACCEPTED') && q.counterAmount != null
    ? q.counterAmount
    : q.amount;
  return Number(v) || 0;
}

function providerOf(quote) {
  return quote.inspector || quote.truckOwner || quote.provider || {};
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || '?';
}

function statusChip(status) {
  if (status === 'ACCEPTED')  return { label: 'Hired', tone: 'good' };
  if (status === 'COUNTERED') return { label: 'Counter', tone: 'wait' };
  if (status === 'SELECTED')  return { label: 'Selected', tone: 'info' };
  if (status === 'PENDING')   return { label: 'Pending', tone: 'neutral' };
  if (status === 'EXPIRED')   return { label: 'Expired', tone: 'muted' };
  if (status === 'WITHDRAWN') return { label: 'Released', tone: 'muted' };
  if (status === 'REJECTED')  return { label: 'Not selected', tone: 'muted' };
  return { label: String(status || '').replace(/_/g, ' '), tone: 'neutral' };
}

// ---- Individual bid row -------------------------------------------------
function BidRow({ quote, type, onRespond, disabled }) {
  const [showCounter, setShowCounter] = useState(false);
  const [counterAmount, setCounterAmount] = useState('');
  const [busy, setBusy] = useState('');

  const provider   = providerOf(quote);
  const isPending  = quote.status === 'PENDING';
  const isSelected = quote.status === 'SELECTED';
  const isNeg      = quote.status === 'COUNTERED';
  const isActive   = isPending || isSelected || isNeg;
  const isHired    = quote.status === 'ACCEPTED';
  const isDone     = ['REJECTED', 'EXPIRED', 'WITHDRAWN'].includes(quote.status);
  const expired    = isActive && isQuoteExpired(quote);
  const turn       = quoteTurn(quote);
  const myTurn     = !expired && (isSelected || (isNeg && turn === 'REQUESTER'));
  const waiting    = !expired && isNeg && turn === 'PROVIDER';

  const displayAmount = (isNeg || isHired) && quote.counterAmount != null
    ? quote.counterAmount
    : quote.amount;

  const chip = statusChip(quote.status);

  async function handle(action) {
    if (busy) return;
    setBusy(action);
    try {
      await onRespond(quote, action, action === 'COUNTER' ? counterAmount : undefined);
      if (action === 'COUNTER') { setShowCounter(false); setCounterAmount(''); }
    } catch (_) {
      // The host reports the error; keep the counter form open so nothing typed is lost.
    } finally {
      setBusy('');
    }
  }

  const isProviderPlaceholder = !provider.name;

  return (
    <li className={[
      'bb-row',
      myTurn    ? 'bb-row--turn'   : '',
      isHired   ? 'bb-row--hired'  : '',
      isDone    ? 'bb-row--closed' : '',
    ].filter(Boolean).join(' ')}>

      {/* ── Provider + price ────────────────────────────── */}
      <div className="bb-row-main">
        <span className="bb-avatar" aria-hidden="true">{initialsOf(provider.name)}</span>

        <div className="bb-row-body">
          <div className="bb-row-line">
            <strong className="bb-name">{provider.name || 'Provider'}</strong>
            {provider.verificationStatus === 'VERIFIED' && (
              <span className="bb-verified">✓ Verified</span>
            )}
            {provider.rating != null && (
              <span className="bb-rating">★ {Number(provider.rating).toFixed(1)}</span>
            )}
            {type === 'TRANSPORT_QUOTE' && provider.truckCapacity && (
              <span className="bb-spec">{provider.truckCapacity} t</span>
            )}
          </div>

          {!isProviderPlaceholder && (
            <p className="bb-meta">
              {provider.location || 'Location not set'}
            </p>
          )}

          {quote.message && (
            <p className="bb-message">"{quote.message}"</p>
          )}

          {(isSelected || isNeg) && (
            <p className={`bb-turn-note${myTurn ? ' is-mine' : ''}`}>
              {isSelected && myTurn && 'You selected this bid — accept, counter, or reject below.'}
              {isNeg && myTurn && `Provider countered · last offer ${money(quote.counterAmount)} ETB — your turn.`}
              {isNeg && waiting && `You offered ${money(quote.counterAmount)} ETB — waiting for provider.`}
            </p>
          )}

          {expired && (
            <p className="bb-turn-note is-warn">
              Quote expired
              {turn === 'REQUESTER'
                ? ' — reject it to clear it, or select another bid.'
                : ' — waiting on the provider, or select another bid.'}
            </p>
          )}

          {isHired && (
            <p className="bb-turn-note is-hired">
              ✓ Provisional agreement — {type === 'INSPECTION_QUOTE' ? 'inspector' : 'transporter'} selected;
              payment is still required to commit.
            </p>
          )}
        </div>

        <div className="bb-row-side">
          <span className="bb-price">
            {money(displayAmount)} <small>ETB</small>
          </span>
          <span className={`bb-chip bb-chip--${chip.tone}`}>{chip.label}</span>
        </div>
      </div>

      {/* ── CTAs ─────────────────────────────────────────── */}
      {isActive && !disabled && (
        <div className="bb-actions">
          {isPending && !expired && (
            <button
              type="button"
              className="bb-btn bb-btn-primary"
              disabled={!!busy}
              onClick={() => handle('SELECT')}
            >
              {busy === 'SELECT' ? 'Selecting…' : 'Select for negotiation'}
            </button>
          )}

          {expired && turn === 'REQUESTER' && (
            <button
              type="button"
              className="bb-btn bb-btn-light"
              disabled={!!busy}
              onClick={() => handle('REJECT')}
            >
              {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
            </button>
          )}

          {myTurn && (
            <>
              <button
                type="button"
                className="bb-btn bb-btn-primary"
                disabled={!!busy}
                onClick={() => handle('ACCEPT')}
              >
                {busy === 'ACCEPT'
                  ? 'Accepting…'
                  : (type === 'INSPECTION_QUOTE'
                      ? `Accept inspector offer · ${money(displayAmount)} ETB`
                      : `Accept provisional deal · ${money(displayAmount)} ETB`)}
              </button>

              {!showCounter ? (
                <button
                  type="button"
                  className="bb-btn bb-btn-outline"
                  disabled={!!busy}
                  onClick={() => setShowCounter(true)}
                >
                  {isNeg
                    ? 'Counter again'
                    : (type === 'INSPECTION_QUOTE' ? 'Counter inspector' : 'Negotiate price')}
                </button>
              ) : (
                <>
                  <AmountPicker
                    className="bb-counter-picker"
                    reference={Number(displayAmount)}
                    min={1}
                    placeholder="Select your offer (ETB)"
                    value={counterAmount}
                    onChange={setCounterAmount}
                    ariaLabel="Counter-offer amount"
                  />
                  <button
                    type="button"
                    className="bb-btn bb-btn-primary"
                    disabled={!counterAmount || !!busy}
                    onClick={() => handle('COUNTER')}
                  >
                    {busy === 'COUNTER' ? 'Sending…' : 'Send offer'}
                  </button>
                  <button
                    type="button"
                    className="bb-btn bb-btn-light"
                    onClick={() => { setShowCounter(false); setCounterAmount(''); }}
                  >
                    Cancel
                  </button>
                </>
              )}

              <button
                type="button"
                className="bb-btn bb-btn-light bb-btn-spacer"
                disabled={!!busy}
                onClick={() => handle('REJECT')}
              >
                {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---- The board ----------------------------------------------------------
export default function BidBoard({ quotes, type, requestId, orderLink, onRespond, disabled }) {
  const [sortBy, setSortBy] = useState('price');

  if (!Array.isArray(quotes) || quotes.length === 0) return null;

  const active = quotes.filter((q) =>
    ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status)
  );

  const superseded = supersededIds(quotes);
  const leafActive = active.filter((q) => !superseded.has(q.id));
  const resolved   = quotes.filter(
    (q) => !['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status) && !superseded.has(q.id),
  );

  const sorted = [...leafActive].sort((a, b) => {
    if (sortBy === 'price') return shownAmount(a) - shownAmount(b);
    const na = providerOf(a).name || '';
    const nb = providerOf(b).name || '';
    return na.localeCompare(nb);
  });

  const myTurnCount = leafActive.filter(
    (q) => q.status === 'SELECTED' || (q.status === 'COUNTERED' && quoteTurn(q) === 'REQUESTER'),
  ).length;

  const providerLabel = type === 'INSPECTION_QUOTE' ? 'inspectors' : 'truck owners';

  return (
    <div className="bb-board">

      {/* ── Section header ─────────────────────────────── */}
      <div className="bb-board-head">
        <div className="bb-board-head-main">
          <h3 className="bb-board-title">Active bids</h3>
          <p className="bb-board-sub">
            {leafActive.length} active bid{leafActive.length === 1 ? '' : 's'}
            {myTurnCount > 0 && ` · ${myTurnCount} awaiting your response`}
          </p>
        </div>

        <div className="bb-board-head-side">
          {leafActive.length > 1 && (
            <div className="bb-sort">
              <span className="bb-sort-label">Sort</span>
              <button
                type="button"
                className={`bb-sort-btn${sortBy === 'price' ? ' is-active' : ''}`}
                onClick={() => setSortBy('price')}
              >
                Price ↑
              </button>
              <button
                type="button"
                className={`bb-sort-btn${sortBy === 'name' ? ' is-active' : ''}`}
                onClick={() => setSortBy('name')}
              >
                Name
              </button>
            </div>
          )}
          {orderLink && (
            <Link className="bb-board-link" to={orderLink}>View order →</Link>
          )}
        </div>
      </div>

      {/* ── Active rows ────────────────────────────────── */}
      {sorted.length === 0 ? (
        <p className="bb-empty">
          No bids yet. Registered {providerLabel} on the platform can view this
          request and submit a quote.
        </p>
      ) : (
        <ul className="bb-list">
          {sorted.map((q) => (
            <BidRow
              key={q.id}
              quote={q}
              type={type}
              requestId={requestId}
              onRespond={onRespond}
              disabled={disabled}
            />
          ))}
        </ul>
      )}

      {/* ── Previous bids ──────────────────────────────── */}
      {resolved.length > 0 && (
        <details className="bb-previous">
          <summary className="bb-previous-summary">
            Previous bids ({resolved.length}) — hired or not selected
          </summary>
          <ul className="bb-list bb-list--muted">
            {resolved.map((q) => (
              <BidRow
                key={q.id}
                quote={q}
                type={type}
                onRespond={onRespond}
                disabled={true}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
