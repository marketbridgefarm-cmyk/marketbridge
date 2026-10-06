import React, { useEffect, useState } from 'react';
import AmountPicker from './AmountPicker.jsx';

// ============================================================================
// ORDER DECISION PANEL
// ----------------------------------------------------------------------------
// One guided block that walks the buyer (and informs the seller) through:
//
//   1. Price review (optional, both parties can propose)
//   2. Buyer decision (BUY / CANCEL)
//
// Backend guarantee this panel leans on: the buyer can always commit at the
// current agreed price, even while a price review is pending. Doing so
// automatically closes the pending proposal and records the commitment.
//
// IMPORTANT: every numeric input in this panel goes through AmountPicker, not
// a free <input type="number">. That is the only way a buyer or seller can
// type a price on the platform, and it prevents a phone number or any other
// contact string from being smuggled into a numeric field.
// ============================================================================

const REASON_OPTIONS = [
  ['MARKET_PRICE_RISE', 'Market price increased'],
  ['MARKET_PRICE_FALL', 'Market price decreased'],
  ['QUALITY_OR_QUANTITY_CHANGE', 'Inspected quantity / quality differs'],
  ['FRESHNESS_OR_DAMAGE', 'Freshness or damage finding'],
  ['OTHER_INSPECTION_FINDING', 'Other inspection finding'],
];

const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const formatDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function findLeafReview(reviews) {
  const list = Array.isArray(reviews) ? reviews.slice() : [];
  if (!list.length) return null;
  const parentIds = new Set(list.map((r) => r.parentId).filter(Boolean));
  const leaves = list.filter((r) => !parentIds.has(r.id));
  return (
    leaves.sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    )[0] || null
  );
}

function moneyDelta(from, to) {
  const a = Number(from || 0);
  const b = Number(to || 0);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  const delta = b - a;
  const percent = (delta / a) * 100;
  return {
    delta,
    percent,
    sign: delta > 0 ? '+' : '',
  };
}

export default function OrderDecisionPanel({
  order,
  currentUserId,
  isBuyer,
  isSeller,
  isParticipant,
  busy,
  onBuy,
  onCancel,
  onProposePrice,
  onRespondReview,
  onScrollToPayment,
}) {
  const allReviews = Array.isArray(order?.priceReviews) ? order.priceReviews : [];
  const leaf = findLeafReview(allReviews);
  const pendingReview = leaf && leaf.status === 'PENDING' ? leaf : null;
  const lastRejected = leaf && leaf.status === 'REJECTED' ? leaf : null;

  const currentPrice = Number(order?.finalPrice || 0);
  const originalPrice = Number(order?.originalFinalPrice || currentPrice);
  const buyerDecision = order?.buyerDecision;

  // ---- local state --------------------------------------------------------

  const [showProposeForm, setShowProposeForm] = useState(false);
  const [proposedPrice, setProposedPrice] = useState('');
  const [proposedReason, setProposedReason] = useState('QUALITY_OR_QUANTITY_CHANGE');

  const [counterAmount, setCounterAmount] = useState('');
  const [counterReason, setCounterReason] = useState('QUALITY_OR_QUANTITY_CHANGE');

  // Reset the forms whenever the active review changes so a stale proposal
  // does not leak into a new negotiation.
  useEffect(() => {
    setShowProposeForm(false);
    setProposedPrice('');
    setProposedReason('QUALITY_OR_QUANTITY_CHANGE');
    setCounterAmount('');
    setCounterReason('QUALITY_OR_QUANTITY_CHANGE');
  }, [pendingReview?.id, buyerDecision]);

  // ---- helpers ------------------------------------------------------------

  const isPendingFromMe = pendingReview && pendingReview.proposedById === currentUserId;
  const isPendingFromOther = pendingReview && pendingReview.proposedById !== currentUserId;

  const proposalDelta =
    pendingReview ? moneyDelta(currentPrice, Number(pendingReview.proposedPrice)) : null;

  const isProposedPriceValid =
    Number(proposedPrice) > 0 && Number(proposedPrice) !== currentPrice;

  const isCounterValid =
    Number(counterAmount) > 0 &&
    Number(counterAmount) !== Number(pendingReview?.proposedPrice || 0);

  // ---- render -------------------------------------------------------------

  return (
    <div className="od-card-section od-decision-panel">
      <div className="od-card-section-head">
        <h3 className="od-card-section-title">
          {buyerDecision === 'BUY'
            ? 'Purchase decision'
            : buyerDecision === 'CANCEL'
            ? 'Purchase cancelled'
            : pendingReview
            ? 'Price review in progress'
            : 'Price & purchase decision'}
        </h3>
        {currentPrice > 0 && (
          <div className="od-card-section-meta">
            {money(currentPrice)} ETB
          </div>
        )}
      </div>

      {/* ─────────────────────── Buyer: decision already recorded ────── */}
      {buyerDecision === 'BUY' && (
        <div className="od-decision-state od-decision-state--buy">
          <div className="od-decision-state-icon" aria-hidden="true">✓</div>
          <div className="od-decision-state-body">
            <strong>BUY decision recorded</strong>
            <p className="muted">
              Committed at <strong>{money(currentPrice)} ETB</strong>
              {order?.buyerDecisionAt && <> on {formatDateTime(order.buyerDecisionAt)}</>}.
            </p>
            <p className="muted small">
              Goods payment is now available in the Payment Center below.
            </p>
            {onScrollToPayment && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onScrollToPayment}
              >
                Go to payment center
              </button>
            )}
          </div>
        </div>
      )}

      {buyerDecision === 'CANCEL' && (
        <div className="od-decision-state od-decision-state--cancel">
          <div className="od-decision-state-icon" aria-hidden="true">×</div>
          <div className="od-decision-state-body">
            <strong>Purchase cancelled after inspection</strong>
            <p className="muted">
              Recorded {order?.buyerDecisionAt ? formatDateTime(order.buyerDecisionAt) : ''}.
            </p>
            <p className="muted small">
              Any completed inspection fee is refunded automatically.
            </p>
          </div>
        </div>
      )}

      {/* ─────────────────────── Pending review: other party proposed ─ */}
      {!buyerDecision && isPendingFromOther && (
        <div className="od-decision-block">
          <div className="od-decision-block-head">
            <span className="od-decision-eyebrow">
              PRICE REVIEW PROPOSED BY {isBuyer ? 'SELLER' : 'BUYER'}
            </span>
            <strong className="od-decision-block-price">
              {money(pendingReview.proposedPrice)} ETB
            </strong>
          </div>

          <div className="od-decision-block-facts">
            <div>
              <span>Current agreed price</span>
              <strong>{money(currentPrice)} ETB</strong>
            </div>
            <div>
              <span>Proposed change</span>
              <strong>
                {proposalDelta
                  ? `${proposalDelta.sign}${money(proposalDelta.delta)} ETB (${proposalDelta.sign}${proposalDelta.percent.toFixed(2)}%)`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>Reason</span>
              <strong>
                {REASON_OPTIONS.find(([k]) => k === pendingReview.reasonCode)?.[1] ||
                  pendingReview.reasonCode}
              </strong>
            </div>
          </div>

          {isParticipant && (
            <>
              <div className="od-decision-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(busy)}
                  onClick={() => onRespondReview(pendingReview.id, 'ACCEPT')}
                >
                  {busy ? 'Accepting…' : `Accept ${money(pendingReview.proposedPrice)} ETB`}
                </button>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={Boolean(busy)}
                  onClick={() => onRespondReview(pendingReview.id, 'REJECT')}
                >
                  Reject proposal
                </button>
              </div>

              <details className="od-decision-more">
                <summary>Counter this proposal</summary>
                <div className="od-decision-form-grid">
                  <label>
                    Your counter (ETB)
                    <AmountPicker
                      reference={Number(pendingReview?.proposedPrice || currentPrice)}
                      min={1}
                      placeholder="Select your counter"
                      value={counterAmount}
                      disabled={Boolean(busy)}
                      onChange={setCounterAmount}
                      ariaLabel="Your counter in ETB"
                    />
                  </label>
                  <label>
                    Reason
                    <select
                      value={counterReason}
                      onChange={(e) => setCounterReason(e.target.value)}
                    >
                      {REASON_OPTIONS.map(([value, text]) => (
                        <option key={value} value={value}>{text}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={Boolean(busy) || !isCounterValid}
                  onClick={() =>
                    onRespondReview(
                      pendingReview.id,
                      'COUNTER',
                      Number(counterAmount),
                      counterReason
                    )
                  }
                >
                  Send counter-proposal
                </button>
              </details>
            </>
          )}

          {isBuyer && (
            <div className="od-decision-escape">
              <p className="muted small">
                Or decline this proposal and commit at the current agreed price:
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(busy)}
                onClick={onBuy}
              >
                Buy at current price — {money(currentPrice)} ETB
              </button>
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────── Pending review: I proposed ─────────── */}
      {!buyerDecision && isPendingFromMe && (
        <div className="od-decision-block">
          <div className="od-decision-block-head">
            <span className="od-decision-eyebrow">
              YOUR PROPOSAL — AWAITING RESPONSE
            </span>
            <strong className="od-decision-block-price">
              {money(pendingReview.proposedPrice)} ETB
            </strong>
          </div>

          <div className="od-decision-block-facts">
            <div>
              <span>Current agreed price</span>
              <strong>{money(currentPrice)} ETB</strong>
            </div>
            <div>
              <span>Proposed change</span>
              <strong>
                {proposalDelta
                  ? `${proposalDelta.sign}${money(proposalDelta.delta)} ETB (${proposalDelta.sign}${proposalDelta.percent.toFixed(2)}%)`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>Reason</span>
              <strong>
                {REASON_OPTIONS.find(([k]) => k === pendingReview.reasonCode)?.[1] ||
                  pendingReview.reasonCode}
              </strong>
            </div>
          </div>

          <p className="muted small">
            Waiting for the {isBuyer ? 'seller' : 'buyer'} to respond.
          </p>

          {isBuyer && (
            <div className="od-decision-escape">
              <p className="muted small">
                Don&apos;t wait — commit at the current agreed price and move the order forward:
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(busy)}
                onClick={onBuy}
              >
                Buy at current price — {money(currentPrice)} ETB
              </button>
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────── No pending review, no decision yet ─── */}
      {!buyerDecision && !pendingReview && (
        <div className="od-decision-block">
          {lastRejected && (
            <p className="muted small">
              The previous price proposal was rejected.
              {lastRejected.proposedById === currentUserId
                ? ' You can propose a new price or proceed at the current one.'
                : ' You can propose a new price or proceed at the current one.'}
            </p>
          )}

          <div className="od-decision-block-facts">
            <div>
              <span>Current agreed price</span>
              <strong>{money(currentPrice)} ETB</strong>
            </div>
            {originalPrice !== currentPrice && (
              <div>
                <span>Original negotiated price</span>
                <strong>{money(originalPrice)} ETB</strong>
              </div>
            )}
            <div>
              <span>Inspected report</span>
              <strong>Published</strong>
            </div>
          </div>

          {isBuyer && (
            <>
              <p className="muted">
                The inspection report is published. Review the findings above, then
                choose whether to propose a revised price or commit at the agreed
                price.
              </p>

              {!showProposeForm ? (
                <div className="od-decision-actions">
                  <button
                    type="button"
                    className="btn btn-light"
                    onClick={() => setShowProposeForm(true)}
                  >
                    Propose a different price
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={Boolean(busy)}
                    onClick={onBuy}
                  >
                    Buy at {money(currentPrice)} ETB
                  </button>
                </div>
              ) : (
                <div className="od-decision-propose">
                  <div className="od-decision-form-grid">
                    <label>
                      Your proposed price (ETB)
                      <AmountPicker
                        reference={currentPrice}
                        min={1}
                        placeholder="Select your proposed price"
                        value={proposedPrice}
                        disabled={Boolean(busy)}
                        onChange={setProposedPrice}
                        ariaLabel="Your proposed price in ETB"
                      />
                    </label>
                    <label>
                      Reason
                      <select
                        value={proposedReason}
                        onChange={(e) => setProposedReason(e.target.value)}
                      >
                        {REASON_OPTIONS.map(([value, text]) => (
                          <option key={value} value={value}>{text}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="od-decision-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={Boolean(busy) || !isProposedPriceValid}
                      onClick={async () => {
                        const ok = await onProposePrice(
                          Number(proposedPrice),
                          proposedReason
                        );
                        if (ok) setShowProposeForm(false);
                      }}
                    >
                      Send proposal to seller
                    </button>
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={() => setShowProposeForm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="muted small">
                    The seller must accept, counter, or reject. Meanwhile you can
                    still commit at {money(currentPrice)} ETB at any time.
                  </p>
                </div>
              )}

              <div className="od-decision-cancel-row">
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={Boolean(busy)}
                  onClick={onCancel}
                >
                  Cancel after inspection
                </button>
                <span className="muted small">
                  Ends the order and refunds any completed inspection fee.
                </span>
              </div>
            </>
          )}

          {isSeller && (
            <>
              <p className="muted">
                The inspection report is published. The buyer is reviewing it and
                will decide whether to commit, propose a revised price, or cancel.
              </p>

              {!showProposeForm ? (
                <div className="od-decision-actions">
                  <button
                    type="button"
                    className="btn btn-light"
                    onClick={() => setShowProposeForm(true)}
                  >
                    Propose a revised price
                  </button>
                </div>
              ) : (
                <div className="od-decision-propose">
                  <div className="od-decision-form-grid">
                    <label>
                      Your proposed price (ETB)
                      <AmountPicker
                        reference={currentPrice}
                        min={1}
                        placeholder="Select your proposed price"
                        value={proposedPrice}
                        disabled={Boolean(busy)}
                        onChange={setProposedPrice}
                        ariaLabel="Your proposed price in ETB"
                      />
                    </label>
                    <label>
                      Reason
                      <select
                        value={proposedReason}
                        onChange={(e) => setProposedReason(e.target.value)}
                      >
                        {REASON_OPTIONS.map(([value, text]) => (
                          <option key={value} value={value}>{text}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="od-decision-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={Boolean(busy) || !isProposedPriceValid}
                      onClick={async () => {
                        const ok = await onProposePrice(
                          Number(proposedPrice),
                          proposedReason
                        );
                        if (ok) setShowProposeForm(false);
                      }}
                    >
                      Send proposal to buyer
                    </button>
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={() => setShowProposeForm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="muted small">
                    Useful when the market has moved since the original agreement,
                    or when produce needs to be cleared quickly at a lower price.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
