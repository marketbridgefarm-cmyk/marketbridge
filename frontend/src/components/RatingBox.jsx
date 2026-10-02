import React, { useState } from 'react';
import api from '../api/client';
import RatingStars from './RatingStars.jsx';
import './RatingBox.css';

// One "who can I rate" target: { toUserId, name, role }
function buildTargets(order, userId) {
  const targets = [];
  if (order.buyerId === userId && order.seller) {
    targets.push({ toUserId: order.sellerId, name: order.seller.name, role: 'SELLER' });
  }
  if (order.sellerId === userId && order.buyer) {
    targets.push({ toUserId: order.buyerId, name: order.buyer.name, role: 'BUYER' });
  }
  const truckOwnerId = order.transportJob?.truckOwnerId;
  const truckOwnerName = order.transportJob?.truckOwner?.name;
  if (
    truckOwnerId &&
    truckOwnerId !== userId &&
    (order.buyerId === userId || order.sellerId === userId)
  ) {
    targets.push({
      toUserId: truckOwnerId,
      name: truckOwnerName || 'the truck owner',
      role: 'TRUCK_OWNER',
    });
  }
  return targets;
}

function nameFor(order, id) {
  if (id === order.buyerId) return order.buyer?.name || 'Buyer';
  if (id === order.sellerId) return order.seller?.name || 'Seller';
  if (id === order.transportJob?.truckOwnerId) {
    return order.transportJob?.truckOwner?.name || 'Truck owner';
  }
  return 'Someone';
}

function RatingForm({ orderId, target, onDone }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!score) {
      setError('Choose a star rating first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/ratings', {
        orderId,
        toUserId: target.toUserId,
        role: target.role,
        score,
        comment: comment.trim() || undefined,
      });
      onDone();
    } catch (e) {
      setError(
        e.response?.data?.error ||
          e.response?.data?.errors?.[0]?.msg ||
          'Could not submit rating'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rating-form">
      <div className="rating-form-head">
        <span className="rating-form-role">{target.role.replace(/_/g, ' ')}</span>
        <strong className="rating-form-name">Rate {target.name}</strong>
      </div>

      <RatingStars value={score} interactive onChange={setScore} size={26} />

      <textarea
        className="rating-comment"
        placeholder="Optional comment — how did it go?"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={1000}
      />

      {error && <div className="alert error small">{error}</div>}

      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busy}
        onClick={submit}
      >
        {busy ? 'Submitting…' : 'Submit rating'}
      </button>
    </div>
  );
}

export default function RatingBox({ order, userId, onRated }) {
  const canRateAtAll = ['DELIVERED', 'COMPLETED'].includes(order.status);
  const existing = Array.isArray(order?.ratings) ? order.ratings : [];
  const alreadyRated = (toUserId, role) =>
    existing.some(
      (r) => r.fromUserId === userId && r.toUserId === toUserId && r.role === role
    );

  const targets = canRateAtAll
    ? buildTargets(order, userId).filter((t) => !alreadyRated(t.toUserId, t.role))
    : [];

  const myRatings = existing.filter((r) => r.fromUserId === userId);

  // Sayings-style collapsible — open by default when there's history
  // worth showing; users can collapse it to hide the list.
  const [historyOpen, setHistoryOpen] = useState(true);

  const subtitle =
    !canRateAtAll
      ? 'Opens after delivery'
      : targets.length === 0 && myRatings.length > 0
        ? 'All done'
        : targets.length > 0
          ? `${targets.length} pending`
          : null;

  return (
    <section className="card rating-card">
      <header className="card-head">
        <div className="card-head-text">
          <span className="eyebrow">RATINGS</span>
          <h2>Ratings on this order</h2>
        </div>
        {subtitle && <span className="card-block-note">{subtitle}</span>}
      </header>

      <div className="card-body">
        {/* Not-yet-available / all-done states */}
        {!canRateAtAll ? (
          <section className="card-block">
            <div className="card-block-title">
              <h3>Not available yet</h3>
            </div>
            <div className="card-block-body">
              <p className="muted">
                Ratings open up once this order has been delivered.
              </p>
            </div>
          </section>
        ) : targets.length === 0 && myRatings.length > 0 ? (
          <section className="card-block">
            <div className="card-block-title">
              <h3>All done</h3>
            </div>
            <div className="card-block-body">
              <p className="muted">
                You've rated everyone you can on this order — thank you.
              </p>
            </div>
          </section>
        ) : null}

        {/* Rating forms — the actionable area, always visible */}
        {targets.length > 0 && (
          <section className="card-block">
            <div className="card-block-title">
              <h3>Rate a participant</h3>
              <span className="card-block-note">
                {targets.length} pending
              </span>
            </div>
            <div className="card-block-body">
              <div className="rating-form-list">
                {targets.map((t) => (
                  <RatingForm
                    key={`${t.toUserId}-${t.role}`}
                    orderId={order.id}
                    target={t}
                    onDone={onRated}
                  />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Submitted ratings — Sayings-style collapsible */}
        {existing.length > 0 && (
          <details
            className="rating-sayings"
            open={historyOpen}
            onToggle={(e) => setHistoryOpen(e.currentTarget.open)}
          >
            <summary className="rating-sayings-summary">
              <span className="rating-sayings-label">Submitted ratings</span>
              <span className="rating-sayings-count">{existing.length}</span>
              <span className="rating-sayings-chevron" aria-hidden="true">
                ▾
              </span>
            </summary>

            <div className="rating-list">
              {existing.map((r) => (
                <div className="rating-list-row" key={r.id}>
                  <div className="rating-list-row-head">
                    <strong>{nameFor(order, r.fromUserId)}</strong>
                    <span className="muted">
                      {' '}rated {nameFor(order, r.toUserId)}
                    </span>
                  </div>
                  <RatingStars value={r.score} />
                  {r.comment && <p className="muted">{r.comment}</p>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
