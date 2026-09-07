import React, { useState } from 'react';
import api from '../api/client';
import RatingStars from './RatingStars.jsx';

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
  if (truckOwnerId && truckOwnerId !== userId && (order.buyerId === userId || order.sellerId === userId)) {
    targets.push({ toUserId: truckOwnerId, name: truckOwnerName || 'the truck owner', role: 'TRUCK_OWNER' });
  }
  return targets;
}

function nameFor(order, id) {
  if (id === order.buyerId) return order.buyer?.name || 'Buyer';
  if (id === order.sellerId) return order.seller?.name || 'Seller';
  if (id === order.transportJob?.truckOwnerId) return order.transportJob?.truckOwner?.name || 'Truck owner';
  return 'Someone';
}

function RatingForm({ orderId, target, onDone }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!score) { setError('Choose a star rating first.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.post('/ratings', { orderId, toUserId: target.toUserId, role: target.role, score, comment: comment.trim() || undefined });
      onDone();
    } catch (e) {
      setError(e.response?.data?.error || e.response?.data?.errors?.[0]?.msg || 'Could not submit rating');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rating-form">
      <p>Rate {target.name}</p>
      <RatingStars value={score} interactive onChange={setScore} size={24} />
      <textarea
        className="rating-comment"
        placeholder="Optional comment — how did it go?"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={1000}
      />
      {error && <div className="alert error small">{error}</div>}
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>
        {busy ? 'Submitting…' : 'Submit rating'}
      </button>
    </div>
  );
}

export default function RatingBox({ order, userId, onRated }) {
  const canRateAtAll = ['DELIVERED', 'COMPLETED'].includes(order.status);
  const existing = order.ratings || [];
  const alreadyRated = (toUserId, role) =>
    existing.some((r) => r.fromUserId === userId && r.toUserId === toUserId && r.role === role);

  const targets = canRateAtAll ? buildTargets(order, userId).filter((t) => !alreadyRated(t.toUserId, t.role)) : [];

  return (
    <div className="card">
      <h2>Ratings</h2>
      {!canRateAtAll && <p className="muted">Ratings open up once this order has been delivered.</p>}

      {canRateAtAll && targets.length === 0 && existing.filter((r) => r.fromUserId === userId).length > 0 && (
        <p className="muted">You've rated everyone you can on this order — thank you.</p>
      )}

      {targets.map((t) => (
        <RatingForm key={`${t.toUserId}-${t.role}`} orderId={order.id} target={t} onDone={onRated} />
      ))}

      {existing.length > 0 && (
        <div className="rating-list">
          <h3>Ratings on this order</h3>
          {existing.map((r) => (
            <div className="rating-list-row" key={r.id}>
              <div>
                <strong>{nameFor(order, r.fromUserId)}</strong>
                <span className="muted"> rated {nameFor(order, r.toUserId)}</span>
              </div>
              <RatingStars value={r.score} />
              {r.comment && <p className="muted">{r.comment}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
