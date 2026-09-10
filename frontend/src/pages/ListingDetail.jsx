import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';

const money = (n) => Number(n || 0).toLocaleString();

export default function ListingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [listing, setListing] = useState(null);
  const [offerAmount, setOfferAmount] = useState('');
  const [message, setMessage] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [inspector, setInspector] = useState('');
  const [feeForInspector, setFeeForInspector] = useState('');
  const [inspectionPayMethod, setInspectionPayMethod] = useState('TELEBIRR');
  const [payingInspectionId, setPayingInspectionId] = useState('');
  const [buying, setBuying] = useState(false);
  const [buyMethod, setBuyMethod] = useState('TELEBIRR');
  const [buyerCounter, setBuyerCounter] = useState('');

  async function load() {
    try {
      const response = await api.get(`/listings/${id}`);
      setListing(response.data.listing);
    } catch (e) {
      setError(e.response?.data?.error || 'Listing not found.');
    }
  }

  useEffect(() => { load(); }, [id]);

  async function submitOffer(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/offers', { listingId: id, amount: Number(offerAmount), message });
      setMsg('Offer submitted. Other buyers can still see this listing until an offer is accepted.');
      setOfferAmount('');
      setMessage('');
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not submit offer');
    }
  }

  async function buyProduct() {
    setError('');
    setMsg('');
    setBuying(true);
    try {
      const response = await api.post('/orders/buy-now', { listingId: id });
      const order = response.data.order;
      await startChapaPayment({
        type: 'MARKETPLACE',
        orderId: order.id,
        amount: order.finalPrice,
        method: buyMethod,
      });
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not start purchase');
      setBuying(false);
    }
  }

  async function requestInspection(mode) {
    setError('');
    if (inspector && (!feeForInspector || Number(feeForInspector) <= 0)) {
      setError('Enter the agreed inspection fee before requesting this inspector.');
      return;
    }
    try {
      const body = { listingId: id, mode };
      if (inspector) {
        body.inspectorId = inspector;
        body.fee = Number(feeForInspector);
      }
      await api.post('/inspections', body);
      setMsg('Inspection request created.');
      setInspector('');
      setFeeForInspector('');
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not request inspection');
    }
  }

  async function respondToOffer(offerId, action, counterAmount) {
    setError('');
    try {
      const payload = { action };
      if (counterAmount != null) payload.counterAmount = Number(counterAmount);
      const response = await api.patch(`/offers/${offerId}`, payload);
      setMsg(response.data?.message || 'Negotiation updated.');
      setBuyerCounter('');
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Action failed');
    }
  }

  async function chooseInspector() {
    try {
      const response = await api.get('/inspections/inspectors', { params: { location: listing.location } });
      const options = response.data.inspectors || [];
      if (!options.length) { setError('No inspectors were found in this area.'); return; }
      setInspector(options[0].id);
      setMsg(`Inspector selected: ${options[0].name}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load inspectors');
    }
  }

  async function payInspection(request) {
    setError('');
    setPayingInspectionId(request.id);
    try {
      await startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, amount: request.fee, method: inspectionPayMethod });
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not start inspection payment');
      setPayingInspectionId('');
    }
  }

  async function resumeInspectionPayment(paymentId, requestId) {
    setError('');
    setPayingInspectionId(requestId);
    try {
      await chapaInitializeAndRedirect(paymentId);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not resume payment');
      setPayingInspectionId('');
    }
  }

  if (!listing) return <main className="section"><div className="container-wide loading">Loading listing…</div></main>;

  const isOwner = user?.id === listing.sellerId;
  const isBuyer = user?.roles?.includes('BUYER') && !isOwner;
  const isAgricultural = listing.category === 'AGRICULTURAL';
  const isAvailable = listing.status === 'ACTIVE';
  const listingParentIds = new Set((listing.offers || []).map((offer) => offer.parentOfferId).filter(Boolean));
  const myLatestOffer = (listing.offers || [])
    .filter((offer) => offer.buyerId === user?.id && !listingParentIds.has(offer.id))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
  const sellerCounterWaitingForBuyer = myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'SELLER';
  const buyerCounterWaitingForSeller = myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'BUYER';

  return (
    <main className="section">
      <div className="container-wide">
        <Link className="back-link" to={isAgricultural ? '/agricultural' : '/products'}>← Back to marketplace</Link>
        <div className="detail-grid">
          <section>
            <div className="detail-media">
              {listing.photos?.[0] ? <img src={listing.photos[0]} alt={listing.title || listing.cropType} /> : <div className="media-placeholder">{listing.title || listing.cropType}</div>}
            </div>
            <div className="card detail-content">
              <div className="listing-meta">
                <span className="tag">{isAgricultural ? 'AGRICULTURE' : 'PRODUCT'}</span>
                <span className="badge">{listing.status}</span>
              </div>
              <h1>{listing.title || listing.cropType}</h1>
              <p className="lead">{Number(listing.quantity).toLocaleString()} {listing.unit} {isAvailable ? 'available' : 'currently reserved / unavailable'} · {listing.location}</p>
              <div className="detail-facts">
                <div><span>Asking price</span><strong>{money(listing.askingPrice)} ETB</strong></div>
                <div><span>Ready</span><strong>{listing.readinessDate ? new Date(listing.readinessDate).toLocaleDateString() : 'To be agreed'}</strong></div>
                <div><span>Seller</span><strong>{listing.seller?.name}</strong></div>
              </div>
              <p className="muted">A pending, rejected or countered offer does not remove a listing from buyer availability. Acceptance creates a temporary reservation.</p>
              {(() => {
                const myOrder = (listing.orders || []).find((o) => o.buyerId === user?.id);
                if (!myOrder) return null;
                return (
                  <p style={{ marginTop: 8 }}>
                    <Link className="btn btn-primary btn-sm" to={`/orders/${myOrder.id}`}>
                      View your order ({myOrder.status.replaceAll('_', ' ')}) →
                    </Link>
                  </p>
                );
              })()}
            </div>
            {isAgricultural && (
              <div className="card">
                <h2>Inspection evidence</h2>
                {listing.inspectionRequests?.length ? listing.inspectionRequests.map((request) => (
                  <div className="evidence" key={request.id}>
                    <div><strong>{request.mode.replaceAll('_', ' ')}</strong><span className="badge" style={{ marginLeft: 8 }}>{request.status}</span></div>
                    {request.inspector && <p>Inspector: {request.inspector.name}</p>}
                    {(() => {
                      if (request.requestedById !== user?.id || request.fee == null) return null;
                      const existing = (request.payments || []).find((p) => ['PENDING', 'PAID'].includes(p.status));
                      if (existing?.status === 'PAID') return <p className="muted" style={{ marginTop: 8 }}>Inspection fee paid.</p>;
                      if (existing?.status === 'PENDING') {
                        return <div style={{ marginTop: 8 }}><p className="muted">Your fee payment hasn't completed yet.</p><button type="button" className="btn btn-primary btn-sm" disabled={payingInspectionId === request.id} onClick={() => resumeInspectionPayment(existing.id, request.id)}>{payingInspectionId === request.id ? 'Redirecting…' : 'Resume payment'}</button></div>;
                      }
                      return <div style={{ marginTop: 8 }}><p>Fee due: <strong>{Number(request.fee).toLocaleString()} ETB</strong></p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><select value={inspectionPayMethod} onChange={(e) => setInspectionPayMethod(e.target.value)}><option value="TELEBIRR">Telebirr</option><option value="CBE">CBE</option><option value="QR">QR</option><option value="OTHER">Other</option></select><button type="button" className="btn btn-primary btn-sm" disabled={payingInspectionId === request.id} onClick={() => payInspection(request)}>{payingInspectionId === request.id ? 'Submitting…' : 'Pay inspection fee'}</button></div></div>;
                    })()}
                    {request.report ? <p>✓ {request.report.quantity} verified · {request.report.grade || 'Grade not stated'}{request.report.moisture != null ? ` · ${request.report.moisture}% moisture` : ''}</p> : <p className="muted">Report pending.</p>}
                    {request.report && (
                      <EvidenceGallery
                        listUrl={`/inspections/${request.id}/evidence`}
                        mediaUrl={(evidenceId) => `/inspections/${request.id}/evidence/${evidenceId}/media`}
                      />
                    )}
                  </div>
                )) : <p className="muted">No inspection yet.</p>}
              </div>
            )}
          </section>

          <aside>
            {msg && <div className="alert success">{msg}</div>}
            {error && <div className="alert error">{error}</div>}

            {isBuyer && myLatestOffer && isAgricultural && (
              <div className="card" id="negotiation">
                <h2>Your negotiation</h2>
                <p>Current amount: <strong>{money(myLatestOffer.counterAmount ?? myLatestOffer.amount)} ETB</strong></p>
                <span className="badge">{myLatestOffer.status}</span>
                {sellerCounterWaitingForBuyer && (
                  <>
                    <p className="muted" style={{ marginTop: 10 }}>The seller has countered. <strong>Your turn.</strong></p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary" onClick={() => respondToOffer(myLatestOffer.id, 'ACCEPT_COUNTER')}>Accept seller counter</button>
                      <input type="number" min="0.01" step="0.01" placeholder="Counter ETB" value={buyerCounter} onChange={(e) => setBuyerCounter(e.target.value)} style={{ minWidth: 140 }} />
                      <button className="btn btn-light" disabled={!buyerCounter} onClick={() => respondToOffer(myLatestOffer.id, 'RE_COUNTER', buyerCounter)}>Counter seller</button>
                    </div>
                  </>
                )}
                {buyerCounterWaitingForSeller && <p className="muted" style={{ marginTop: 10 }}>You made the latest counter. Waiting for the seller.</p>}
                {myLatestOffer.status === 'PENDING' && <p className="muted" style={{ marginTop: 10 }}>Waiting for the seller to respond.</p>}
                {myLatestOffer.status === 'REJECTED' && <p className="muted" style={{ marginTop: 10 }}>The seller rejected this offer. If the listing is available, you can make a new offer.</p>}
                {myLatestOffer.status === 'ACCEPTED' && <Link className="btn btn-primary full" style={{ marginTop: 10 }} to={(listing.orders || []).find((o) => o.buyerId === user?.id)?.id ? `/orders/${(listing.orders || []).find((o) => o.buyerId === user?.id).id}` : '#'}>Continue to order →</Link>}
              </div>
            )}

            {isBuyer && (
              <div className="card sticky-card">
                <h2>{isAvailable ? (isAgricultural ? 'Make an offer' : 'Buy this product') : 'Listing unavailable'}</h2>
                {!isAvailable ? (
                  <>
                    <p className="muted">This listing has an accepted offer and is temporarily unavailable to new buyers.</p>
                    <Link className="btn btn-light full" to={isAgricultural ? '/agricultural' : '/products'}>Browse available listings</Link>
                  </>
                ) : isAgricultural ? (
                  <>
                    <p className="muted">Your offer does not reserve the listing. The seller decides whether to accept, reject or counter.</p>
                    <form onSubmit={submitOffer}>
                      <label>Your offer (ETB)</label>
                      <input required type="number" min="0.01" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} />
                      <label>Message</label>
                      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional message to the farmer" />
                      <button className="btn btn-primary full">Submit offer</button>
                    </form>
                    {isAgricultural && (
                      <>
                        <hr />
                        <h3>Quality check</h3>
                        <p className="small muted">Request an independent inspection.</p>
                        {inspector && <input type="number" min="1" step="0.01" placeholder="Agreed fee (ETB)" value={feeForInspector} onChange={(e) => setFeeForInspector(e.target.value)} style={{ marginBottom: 8, width: '100%' }} />}
                        <button className="btn btn-light full" onClick={() => requestInspection('BUYER_REQUESTED')}>Request inspection</button>
                        <button className="btn btn-light full" style={{ marginTop: 8 }} onClick={chooseInspector}>Find an inspector</button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <p className="muted">This product uses Buy Now. Your order is reserved while payment is completed.</p>
                    <label>Payment method</label>
                    <select value={buyMethod} onChange={(e) => setBuyMethod(e.target.value)} style={{ width: '100%', marginBottom: 10 }}>
                      <option value="TELEBIRR">Telebirr</option>
                      <option value="CBE">CBE</option>
                      <option value="QR">QR</option>
                      <option value="OTHER">Other</option>
                    </select>
                    <button type="button" className="btn btn-primary full" disabled={buying} onClick={buyProduct}>
                      {buying ? 'Starting payment…' : `Buy for ${money(listing.askingPrice)} ETB`}
                    </button>
                  </>
                )}
              </div>
            )}

            {isOwner && (
              <div className="card sticky-card">
                <h2>Seller controls</h2>
                <p className="small muted">Only the seller can change price or listing status.</p>
                {isAgricultural && (
                  <>
                    {inspector && <input type="number" min="1" step="0.01" placeholder="Agreed fee (ETB)" value={feeForInspector} onChange={(e) => setFeeForInspector(e.target.value)} style={{ marginBottom: 8, width: '100%' }} />}
                    <button className="btn btn-light full" onClick={() => requestInspection('SELLER_REQUESTED')}>Request inspection</button>
                    <button className="btn btn-light full" style={{ marginTop: 8 }} onClick={chooseInspector}>Find an inspector</button>
                  </>
                )}
                <h3 className="mt">Offers received</h3>
                {(() => {
                  const parentIds = new Set((listing.offers || []).map((offer) => offer.parentOfferId).filter(Boolean));
                  const latestOffers = (listing.offers || []).filter((offer) => !parentIds.has(offer.id));
                  return latestOffers.length ? latestOffers.map((offer) => <OfferRow key={offer.id} offer={offer} onAction={respondToOffer} />) : <p className="muted">No offers yet.</p>;
                })()}
              </div>
            )}

            {!user && (
              <div className="card">
                <h2>Ready to participate?</h2>
                <p>Register to buy and sell across MarketBridge.</p>
                <Link className="btn btn-primary full" to="/register">Create account</Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function OfferRow({ offer, onAction }) {
  const [counter, setCounter] = useState('');
  const sellerCanAct =
    offer.status === 'PENDING' ||
    (offer.status === 'COUNTERED' && offer.counteredBy === 'BUYER');

  return (
    <div className="offer-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <strong>{Number(offer.counterAmount ?? offer.amount).toLocaleString()} ETB</strong>
        <span className="badge">{offer.status}</span>
      </div>
      <small>{offer.buyer?.name || 'Buyer'}</small>
      {offer.status === 'COUNTERED' && offer.counteredBy === 'SELLER' && (
        <p className="muted" style={{ marginTop: 8 }}>You made the latest counter. Waiting for the buyer.</p>
      )}
      {sellerCanAct && (
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => onAction(offer.id, 'ACCEPT')}>Accept</button>
          <button className="btn btn-sm btn-light" onClick={() => onAction(offer.id, 'REJECT')}>Reject</button>
          <input type="number" min="0.01" step="0.01" placeholder="Counter ETB" value={counter} onChange={(e) => setCounter(e.target.value)} />
          <button className="btn btn-sm btn-light" disabled={!counter} onClick={() => onAction(offer.id, 'COUNTER', counter)}>Counter</button>
        </div>
      )}
    </div>
  );
}
