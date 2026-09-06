import React, { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';

const ROLE_LABEL = { BUYER: 'Buyer', SELLER: 'Seller', TRUCK_OWNER: 'Transporter' };

export default function OrderDetail() {
  const { orderId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();

  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const [ratingDrafts, setRatingDrafts] = useState({});
  const [messageText, setMessageText] = useState('');
  const [selectedReceiverId, setSelectedReceiverId] = useState('');

  async function load() {
    try {
      const r = await api.get(`/orders/${orderId}`);
      setOrder(r.data.order);
    } catch (e) {
      setError(e.response?.data?.error || 'Order not found');
    }
  }
  useEffect(() => { load(); }, [orderId]);

  async function acceptQuote(id) {
    setBusy(id);
    try { await api.patch(`/transport/quotes/${id}/accept`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not accept quote'); }
    finally { setBusy(''); }
  }

  async function payTransport() {
    const t = order.transportJob;
    setBusy('pay-transport'); setError('');
    try { await startChapaPayment({ type: 'TRANSPORT', orderId, amount: t.agreedAmount, method: payMethod }); }
    catch (e) { setError(e.response?.data?.error || e.message || 'Could not start payment'); setBusy(''); }
  }

  async function payMarketplace() {
    setBusy('pay-marketplace'); setError('');
    try { await startChapaPayment({ type: 'MARKETPLACE', orderId, amount: order.finalPrice, method: payMethod }); }
    catch (e) { setError(e.response?.data?.error || e.message || 'Could not start payment'); setBusy(''); }
  }

  async function resumePayment(paymentId, busyKey) {
    setBusy(busyKey); setError('');
    try { await chapaInitializeAndRedirect(paymentId); }
    catch (e) { setError(e.response?.data?.error || e.message || 'Could not resume payment'); setBusy(''); }
  }

  async function confirmReceipt() {
    setBusy('receipt');
    try { await api.patch(`/orders/${orderId}/confirm-receipt`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not confirm receipt'); }
    finally { setBusy(''); }
  }

  // ---------------------------------------------------------------------
  // RATINGS
  // ---------------------------------------------------------------------
  // Backend (ratings.js) only accepts ratings once an order is COMPLETED
  // or DELIVERED, only from a real participant (buyer/seller/assigned
  // truck owner), and only one rating per (order, target, role).
  function ratingKey(targetId, role) { return `${targetId}-${role}`; }

  function draftFor(key) {
    return ratingDrafts[key] || { score: 0, comment: '' };
  }

  function setDraftScore(key, score) {
    setRatingDrafts((d) => ({ ...d, [key]: { ...draftFor(key), score } }));
  }

  function setDraftComment(key, comment) {
    setRatingDrafts((d) => ({ ...d, [key]: { ...draftFor(key), comment } }));
  }

  async function submitRating(target) {
    const key = ratingKey(target.id, target.role);
    const draft = draftFor(key);
    if (!draft.score) { setError('Choose a star rating before submitting.'); return; }
    setBusy(`rate-${key}`); setError('');
    try {
      await api.post('/ratings', {
        orderId,
        toUserId: target.id,
        role: target.role,
        score: draft.score,
        comment: draft.comment?.trim() || undefined,
      });
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not submit rating');
    } finally {
      setBusy('');
    }
  }

  // ---------------------------------------------------------------------
  // MESSAGES
  // ---------------------------------------------------------------------
  async function sendMessage(receiverId) {
    const content = messageText.trim();
    if (!content) return;
    if (!receiverId) { setError('Choose who to message.'); return; }
    setBusy('send-message'); setError('');
    try {
      await api.post('/messages', { receiverId, content, orderId });
      setMessageText('');
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not send message');
    } finally {
      setBusy('');
    }
  }

  if (!order) {
    return <main className="section"><div className="container-narrow loading">{error || 'Loading order…'}</div></main>;
  }

  const t = order.transportJob;

  const canChooseQuote = t && ['BUYER', 'SELLER'].some((r) => user?.roles?.includes(r)) &&
    (order.buyerId === user?.id || order.sellerId === user?.id) &&
    ['REQUESTED', 'QUOTED'].includes(t.status) && !t.truckOwnerId;

  const transportPayment = (order.payments || []).find((p) => p.type === 'TRANSPORT' && ['PENDING', 'PAID'].includes(p.status));
  const canPayTransport = t && t.method === 'HIRE_TRANSPORTER' && t.truckOwnerId && t.agreedAmount != null &&
    !transportPayment && (order.buyerId === user?.id || order.sellerId === user?.id);
  const canResumeTransportPayment = transportPayment?.status === 'PENDING' && (order.buyerId === user?.id || order.sellerId === user?.id);

  const marketplacePayment = (order.payments || []).find((p) => p.type === 'MARKETPLACE' && ['PENDING', 'PAID'].includes(p.status));
  const canPayMarketplace = order.status === 'PENDING_PAYMENT' && order.buyerId === user?.id && !marketplacePayment;
  const canResumeMarketplacePayment = marketplacePayment?.status === 'PENDING' && order.buyerId === user?.id;

  const title = order.listing?.title || order.listing?.cropType || 'Order';

  // Everyone who can legitimately be rated or messaged on this order.
  const participants = [
    { id: order.buyerId, name: order.buyer?.name, role: 'BUYER' },
    { id: order.sellerId, name: order.seller?.name, role: 'SELLER' },
  ];
  if (t?.truckOwnerId && t.truckOwner) {
    participants.push({ id: t.truckOwnerId, name: t.truckOwner.name, role: 'TRUCK_OWNER' });
  }
  const nameById = Object.fromEntries(participants.map((p) => [p.id, p.name || 'MarketBridge user']));
  const others = participants.filter((p) => p.id !== user?.id);

  const canRate = ['COMPLETED', 'DELIVERED'].includes(order.status) && others.length > 0;
  const ratingsGiven = order.ratings || [];

  const thread = order.messages || [];
  const activeReceiverId = selectedReceiverId || others[0]?.id || '';

  return (
    <main className="section">
      <div className="container-narrow">
        <button className="back-link" onClick={() => nav(-1)}>← Back</button>
        {error && <div className="alert error">{error}</div>}

        <div className="page-header compact-header">
          <div>
            <span className="eyebrow">ORDER {order.id.slice(0, 8)}</span>
            <h1>{title}</h1>
            <p><span className="badge">{order.status}</span> · {Number(order.finalPrice).toLocaleString()} ETB</p>
          </div>
        </div>

        <div className="card">
          <h2>Parties</h2>
          <div className="detail-facts">
            <div><span>Buyer</span><strong>{order.buyer?.name}</strong></div>
            <div><span>Seller</span><strong>{order.seller?.name}</strong></div>
            <div><span>Amount</span><strong>{Number(order.finalPrice).toLocaleString()} ETB</strong></div>
          </div>
        </div>

        {canPayMarketplace && (
          <div className="card">
            <h2>Payment</h2>
            <p className="muted">This order is awaiting payment before the seller can proceed.</p>
            <p>Amount due: <strong>{Number(order.finalPrice).toLocaleString()} ETB</strong></p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option value="TELEBIRR">Telebirr</option>
                <option value="CBE">CBE</option>
                <option value="QR">QR</option>
                <option value="OTHER">Other</option>
              </select>
              <button className="btn btn-primary" disabled={busy === 'pay-marketplace'} onClick={payMarketplace}>
                {busy === 'pay-marketplace' ? 'Submitting…' : 'Pay for this order'}
              </button>
            </div>
          </div>
        )}

        {canResumeMarketplacePayment && (
          <div className="card">
            <h2>Payment</h2>
            <p className="muted">You started a payment for this order but it hasn't completed yet.</p>
            <button className="btn btn-primary" disabled={busy === 'resume-marketplace'} onClick={() => resumePayment(marketplacePayment.id, 'resume-marketplace')}>
              {busy === 'resume-marketplace' ? 'Redirecting…' : 'Resume payment'}
            </button>
          </div>
        )}

        {marketplacePayment?.status === 'PAID' && order.status === 'PENDING_PAYMENT' && (
          <div className="card"><p className="muted">Payment confirmed — waiting for the order status to update.</p></div>
        )}

        <div className="card">
          <div className="row-between">
            <div>
              <h2>Transport</h2>
              <p className="muted">The buyer or seller arranges transport. MarketBridge does not auto-assign a transporter.</p>
            </div>
            {!t && order.status !== 'CANCELLED' && <Link className="btn btn-primary" to={`/orders/${order.id}/transport`}>Arrange transport</Link>}
          </div>

          {t ? (
            <>
              <p><strong>{t.arrangingParty}</strong> · {t.method} · <span className="badge">{t.status}</span></p>
              <p>{t.pickupLocation} → {t.destination}</p>
              {t.truckOwner && <p>Transporter: <strong>{t.truckOwner.name}</strong> · Truck {t.truck?.registration}</p>}

              {canPayTransport && (
                <div className="notice">
                  <p>Transport fee due: <strong>{Number(t.agreedAmount).toLocaleString()} ETB</strong></p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                      <option value="TELEBIRR">Telebirr</option>
                      <option value="CBE">CBE</option>
                      <option value="QR">QR</option>
                      <option value="OTHER">Other</option>
                    </select>
                    <button className="btn btn-primary btn-sm" disabled={busy === 'pay-transport'} onClick={payTransport}>
                      {busy === 'pay-transport' ? 'Submitting…' : 'Pay for transport'}
                    </button>
                  </div>
                </div>
              )}

              {canResumeTransportPayment && (
                <div className="notice">
                  <p>Your transport payment hasn't completed yet.</p>
                  <button className="btn btn-primary btn-sm" disabled={busy === 'resume-transport'} onClick={() => resumePayment(transportPayment.id, 'resume-transport')}>
                    {busy === 'resume-transport' ? 'Redirecting…' : 'Resume payment'}
                  </button>
                </div>
              )}

              {transportPayment?.status === 'PAID' && <p className="muted">Transport payment confirmed.</p>}

              {t.method === 'HIRE_TRANSPORTER' && !t.truckOwnerId && (
                <div className="match-box">
                  <h3>Transport quotes</h3>
                  {t.quotes?.length ? t.quotes.map((q) => (
                    <div className="transporter" key={q.id}>
                      <div>
                        <strong>{q.truckOwner?.name}</strong>
                        <p>{q.truck?.truckType} · {q.truck?.capacity}t · {q.truck?.registration} · ★ {q.truckOwner?.rating?.toFixed?.(1) || '—'}</p>
                        {q.message && <p className="muted">{q.message}</p>}
                      </div>
                      <div>
                        <strong>{Number(q.amount).toLocaleString()} ETB</strong>
                        {canChooseQuote && (
                          <button className="btn btn-sm" disabled={busy === q.id} onClick={() => acceptQuote(q.id)}>
                            {busy === q.id ? 'Accepting…' : 'Accept quote'}
                          </button>
                        )}
                      </div>
                    </div>
                  )) : <p className="muted">Waiting for registered truck owners to submit quotes.</p>}
                </div>
              )}
            </>
          ) : <div className="notice">No transport arrangement recorded yet.</div>}
        </div>

        {order.status === 'DELIVERED' && order.buyerId === user?.id && (
          <div className="card">
            <h2>Confirm receipt</h2>
            <p className="muted">Confirm only after you have physically received the produce/product.</p>
            <button className="btn btn-primary" disabled={busy === 'receipt'} onClick={confirmReceipt}>
              {busy === 'receipt' ? 'Confirming…' : 'Confirm receipt & complete order'}
            </button>
          </div>
        )}

        {canRate && (
          <div className="card">
            <h2>Rate this order</h2>
            <p className="muted">Leave a rating for the other people involved in this order.</p>
            {others.map((target) => {
              const key = ratingKey(target.id, target.role);
              const given = ratingsGiven.find((r) => r.fromUserId === user?.id && r.toUserId === target.id && r.role === target.role);
              const draft = draftFor(key);

              return (
                <div className="rating-row" key={key}>
                  <div>
                    <span className="rating-row-who">{target.name || 'MarketBridge user'}</span>
                    <span className="rating-row-role">{ROLE_LABEL[target.role]}</span>
                    {given && (
                      <div className="rating-comment-box" style={{ marginTop: 6 }}>
                        {given.comment && <p className="muted" style={{ margin: 0 }}>“{given.comment}”</p>}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {given ? (
                      <div className="rating-given">
                        <span className="rating-stars">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <span key={n} className={`star-btn ${n <= given.score ? 'filled' : ''}`}>★</span>
                          ))}
                        </span>
                        Rated
                      </div>
                    ) : (
                      <>
                        <div className="rating-stars">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`star-btn ${n <= draft.score ? 'filled' : ''}`}
                              onClick={() => setDraftScore(key, n)}
                              aria-label={`${n} star${n > 1 ? 's' : ''}`}
                            >★</button>
                          ))}
                        </div>
                        <div className="rating-comment-box">
                          <input
                            placeholder="Optional comment"
                            value={draft.comment}
                            onChange={(e) => setDraftComment(key, e.target.value)}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busy === `rate-${key}`}
                            onClick={() => submitRating(target)}
                          >
                            {busy === `rate-${key}` ? 'Submitting…' : 'Submit rating'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {others.length > 0 && (
          <div className="card msg-card">
            <h2>Messages</h2>
            {others.length > 1 && (
              <div className="msg-recipient">
                <label>Message</label>
                <select value={activeReceiverId} onChange={(e) => setSelectedReceiverId(e.target.value)}>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.name} ({ROLE_LABEL[o.role]})</option>)}
                </select>
              </div>
            )}

            <div className="msg-thread">
              {thread.length === 0 && <p className="msg-empty">No messages yet on this order.</p>}
              {thread.map((m) => (
                <div className={`msg-bubble ${m.senderId === user?.id ? 'mine' : 'theirs'}`} key={m.id}>
                  {m.content}
                  <span className="msg-meta">
                    {m.senderId === user?.id ? 'You' : (nameById[m.senderId] || 'MarketBridge user')} · {new Date(m.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            <div className="msg-compose">
              <textarea
                rows={2}
                placeholder={`Message ${nameById[activeReceiverId] || 'the other party'}…`}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
              />
              <button className="btn btn-primary" disabled={busy === 'send-message' || !messageText.trim()} onClick={() => sendMessage(activeReceiverId)}>
                {busy === 'send-message' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}

        <div className="card">
          <h2>Payment records</h2>
          {order.payments?.length ? order.payments.map((p) => (
            <div className="payment-row" key={p.id}>
              <span>{p.type}</span>
              <strong>{Number(p.amount).toLocaleString()} ETB</strong>
              <span>{p.method}</span>
              <span className="badge">{p.status}</span>
            </div>
          )) : <p className="muted">No payment records attached to this order yet.</p>}
        </div>
      </div>
    </main>
  );
}
