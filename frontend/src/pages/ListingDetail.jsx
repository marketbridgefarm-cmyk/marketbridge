import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import './listing-detail/ListingDetail.css';

const money = (n) => Number(n || 0).toLocaleString();

export default function ListingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [listing, setListing] = useState(null);
  const [offerAmount, setOfferAmount] = useState('');
  const [message, setMessage] = useState('');
  const [inspectionPayMethod, setInspectionPayMethod] = useState('TELEBIRR');
  const [payingInspectionId, setPayingInspectionId] = useState('');
  const [quotesByRequest, setQuotesByRequest] = useState({});
  const [loadingQuotesId, setLoadingQuotesId] = useState('');
  const [acceptingQuoteId, setAcceptingQuoteId] = useState('');
  const [counteringQuoteId, setCounteringQuoteId] = useState('');
  const [rejectingQuoteId, setRejectingQuoteId] = useState('');
  const [quoteCounterInputs, setQuoteCounterInputs] = useState({});
  const [buyerCounter, setBuyerCounter] = useState('');
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);

  const relatedOrders = (listing?.orders || [])
    .filter((order) => order?.status !== 'CANCELLED')
    .sort((a, b) => (a?.createdAt ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() : 0));
  const relatedOrder = relatedOrders[0] || null;

  // Inspections (agricultural and product) are order-owned. ListingDetail may still show
  // the listing, but it must never create a free-floating inspection that
  // cannot participate in the exact purchase workflow.
  const activeInspectionRequest = (listing?.inspectionRequests || [])
    .filter((request) => request.status !== 'CANCELLED')
    .filter((request) => !relatedOrder?.id || !request.orderId || request.orderId === relatedOrder.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;

  async function load() {
    try {
      const response = await api.get(`/listings/${id}`);
      setListing(response.data.listing);
      setActiveMediaIndex(0);
    } catch (e) {
      showToast(e.response?.data?.error || 'Listing not found.', 'error');
    }
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!listing) return;
    const title = listing.title || listing.cropType || 'Marketplace listing';
    const description = listing.description || `${title} available on MarketBridge, an Ethiopian marketplace.`;
    document.title = `${title} | MarketBridge`;
    let meta = document.querySelector('meta[name=description]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', description.slice(0, 155));
  }, [listing]);

  async function submitOffer(e) {
    e.preventDefault();
    try {
      await api.post('/offers', { listingId: id, amount: Number(offerAmount), message });
      showToast('Offer submitted. Other buyers can still see this listing until an offer is accepted.', 'success');
      setOfferAmount('');
      setMessage('');
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not submit offer', 'error');
    }
  }


  async function requestInspection(mode) {
    try {
      if (!relatedOrder?.id) {
        showToast('Complete the offer/negotiation first. Inspection is attached to the resulting order.', 'error');
        return;
      }
      const body = { orderId: relatedOrder.id, listingId: id, mode };
      await api.post(
        '/inspections',
        body,
        { headers: { 'Idempotency-Key': `inspection:${relatedOrder.id}:${mode}` } }
      );
      showToast('Inspection request created.', 'success');
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not request inspection', 'error');
    }
  }

  async function respondToOffer(offerId, action, counterAmount) {
    try {
      const payload = { action };
      if (counterAmount != null) payload.counterAmount = Number(counterAmount);
      const response = await api.patch(`/offers/${offerId}`, payload);
      showToast(response.data?.message || 'Negotiation updated.', 'success');
      setBuyerCounter('');
      await load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Action failed', 'error');
    }
  }

  async function payInspection(request) {
    setPayingInspectionId(request.id);
    try {
      await startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, amount: request.fee, method: inspectionPayMethod });
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not start inspection payment', 'error');
      setPayingInspectionId('');
    }
  }

  async function resumeInspectionPayment(paymentId, requestId) {
    setPayingInspectionId(requestId);
    try {
      await chapaInitializeAndRedirect(paymentId);
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not resume payment', 'error');
      setPayingInspectionId('');
    }
  }

  // A payment that already reached Chapa (PROCESSING) must never be resumed
  // or re-created — only checked. See OrderDetail.jsx's checkPaymentStatus
  // for the same pattern; a stuck PROCESSING payment here used to be
  // invisible to this page (it only looked for PENDING/PAID), which left
  // the buyer re-submitting into a "payment already exists" dead end.
  async function checkInspectionPaymentStatus(paymentId, requestId) {
    setPayingInspectionId(requestId);
    try {
      const response = await api.get(`/payments/${paymentId}/chapa/verify`);
      await load();
      if (response.data?.status === 'PENDING') {
        showToast('Chapa has not confirmed this payment yet. Try again shortly, or retry once it shows FAILED.', 'info');
      }
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not check payment status', 'error');
    } finally {
      setPayingInspectionId('');
    }
  }

  async function loadQuotes(requestId) {
    setLoadingQuotesId(requestId);
    try {
      const response = await api.get(`/inspections/${requestId}/quotes`);
      setQuotesByRequest((q) => ({ ...q, [requestId]: response.data?.quotes || [] }));
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not load quotes', 'error');
    } finally {
      setLoadingQuotesId('');
    }
  }

  async function selectInspectionQuote(requestId, quoteId) {
    setAcceptingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/select`);
      showToast('Inspector bid selected. Price-deal negotiation is now open.', 'success');
      await loadQuotes(requestId);
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not select this inspection bid.', 'error');
    } finally {
      setAcceptingQuoteId('');
    }
  }

  async function acceptQuote(requestId, quoteId) {
    setAcceptingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/accept`);
      showToast('Quote accepted provisionally. The inspector is assigned after the inspection payment gate.', 'success');
      await loadQuotes(requestId);
      await load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not accept this quote — it may no longer be available.', 'error');
    } finally {
      setAcceptingQuoteId('');
    }
  }

  async function releaseInspectionAgreement(requestId, quoteId) {
    setRejectingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/withdraw`);
      showToast('Provisional inspector deal released. Other inspector bids are available again.', 'success');
      await loadQuotes(requestId);
      await load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not release the inspector agreement.', 'error');
    } finally {
      setRejectingQuoteId('');
    }
  }

  async function counterQuote(requestId, quoteId) {
    const amount = Number(quoteCounterInputs[quoteId]);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Enter a valid counter amount before sending.', 'error');
      return;
    }
    setCounteringQuoteId(quoteId);
    try {
      await api.post(`/inspections/${requestId}/quotes/${quoteId}/counter`, { counterAmount: amount });
      showToast('Counter-offer sent to the inspector.', 'success');
      setQuoteCounterInputs((q) => ({ ...q, [quoteId]: '' }));
      await loadQuotes(requestId);
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not send counter-offer.', 'error');
    } finally {
      setCounteringQuoteId('');
    }
  }

  async function rejectQuote(requestId, quoteId) {
    setRejectingQuoteId(quoteId);
    try {
      await api.patch(`/inspections/${requestId}/quotes/${quoteId}/reject`);
      showToast('Quote rejected.', 'success');
      await loadQuotes(requestId);
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not reject this quote.', 'error');
    } finally {
      setRejectingQuoteId('');
    }
  }

  // A quote's negotiation thread is only "live" at its leaf: the row that
  // no later counter-quote points back to as a parent.
  function leafQuotes(list) {
    const parentIds = new Set((list || []).map((q) => q.parentQuoteId).filter(Boolean));
    return (list || []).filter((q) => !parentIds.has(q.id));
  }

  if (!listing) return <main className="section listing-detail-page"><div className="container-wide loading">Loading listing…</div></main>;

  const isOwner = user?.id === listing.sellerId;
  const isBuyer = user?.roles?.includes('BUYER') && !isOwner;
  const isAgricultural = listing.category === 'AGRICULTURAL';
  const isProduct = listing.category === 'PRODUCT';
  // Both agricultural and products marketplaces use competition + negotiation.
  // A selected buyer is only a provisional winner; payment comes later.
  const isAvailable = listing.status === 'ACTIVE' || ((isAgricultural || isProduct) && listing.status === 'UNDER_NEGOTIATION');
  const listingParentIds = new Set((listing.offers || []).map((offer) => offer.parentOfferId).filter(Boolean));
  const myLatestOffer = (listing.offers || [])
    .filter((offer) => offer.buyerId === user?.id && !listingParentIds.has(offer.id))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
  const sellerCounterWaitingForBuyer = myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'SELLER';
  const buyerCounterWaitingForSeller = myLatestOffer?.status === 'COUNTERED' && myLatestOffer.counteredBy === 'BUYER';
  const buyerHasActiveOfferDeal = Boolean(myLatestOffer && ['SELECTED', 'COUNTERED', 'ACCEPTED'].includes(myLatestOffer.status));

  const media = [
    ...(listing.photos || []).map((url) => ({ type: 'photo', url })),
    ...(listing.videos || []).map((url) => ({ type: 'video', url })),
  ];
  const activeMediaIndexSafe = media.length ? Math.min(activeMediaIndex, media.length - 1) : 0;
  const activeMedia = media[activeMediaIndexSafe];

  return (
    <main className="section">
      <div className="container-wide">
        <Link className="back-link" to={isAgricultural ? '/agricultural' : '/products'}>← Back to marketplace</Link>
        <div className="detail-grid">
          <section>
            <div className="detail-media">
              {activeMedia ? (
                activeMedia.type === 'video'
                  ? <video src={activeMedia.url} controls />
                  : <img src={activeMedia.url} alt={listing.title || listing.cropType} />
              ) : (
                <div className="media-placeholder">{listing.title || listing.cropType}</div>
              )}
            </div>
            {media.length > 1 && (
              <div className="detail-media-thumbs">
                {media.map((m, i) => (
                  <button
                    type="button"
                    key={`${m.type}-${i}`}
                    className={`detail-media-thumb ${i === activeMediaIndexSafe ? 'active' : ''}`}
                    onClick={() => setActiveMediaIndex(i)}
                  >
                    {m.type === 'video' ? <video src={m.url} muted /> : <img src={m.url} alt="" loading="lazy" decoding="async" />}
                    {m.type === 'video' && <span className="detail-media-thumb-play">▶</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="card detail-content">
              <div className="listing-meta">
                <span className="tag">{isAgricultural ? 'AGRICULTURE' : 'PRODUCT'}</span>
                <span className="badge">{listing.status}</span>
              </div>
              <h1>{listing.title || listing.cropType}</h1>
              <p className="lead">{Number(listing.quantity).toLocaleString()} {listing.unit} {isAvailable ? 'available for competing buyers' : 'currently reserved / unavailable'} · {listing.location}</p>
              <div className="detail-facts">
                <div><span>Asking price</span><strong>{money(listing.askingPrice)} ETB</strong></div>
                <div><span>Ready</span><strong>{listing.readinessDate ? new Date(listing.readinessDate).toLocaleDateString() : 'To be agreed'}</strong></div>
                <div><span>Seller</span><strong>{listing.seller?.name}</strong></div>
              </div>
              <p className="muted">Multiple buyers can compete while this listing is active or under negotiation. Selecting a buyer opens negotiation; only acceptance creates the reservation.</p>
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
            {(isAgricultural || isProduct) && (
              <div className="card">
                <h2>Inspection evidence</h2>
                {listing.inspectionRequests?.length ? listing.inspectionRequests.map((request) => (
                  <div className="evidence" key={request.id}>
                    <div><strong>{request.mode.replaceAll('_', ' ')}</strong><span className="badge" style={{ marginLeft: 8 }}>{request.status}</span></div>
                    {request.inspector && <p>Inspector: {request.inspector.name}</p>}
                    {request.requestedById === user?.id && ['REQUESTED', 'ACCEPTED'].includes(request.status) && (
                      <div style={{ marginTop: 8 }}>
                        {!quotesByRequest[request.id] ? (
                          <button
                            type="button"
                            className="btn btn-light btn-sm"
                            disabled={loadingQuotesId === request.id}
                            onClick={() => loadQuotes(request.id)}
                          >
                            {loadingQuotesId === request.id ? 'Loading…' : 'View inspector quotes'}
                          </button>
                        ) : (
                          <div>
                            <p className="muted" style={{ marginBottom: 6 }}>
                              {quotesByRequest[request.id].filter((q) => ['PENDING', 'SELECTED', 'COUNTERED'].includes(q.status)).length} available quote(s).
                              {' '}This is a competitive inspection request. Inspectors submit sealed quotes; you select one for bilateral negotiation.
                              {request.status === 'ACCEPTED' && ' The current inspector agreement is provisional until the inspection payment settles.'}
                            </p>
                            {quotesByRequest[request.id].length === 0 && (
                              <p className="muted">No quotes submitted yet.</p>
                            )}
                            {leafQuotes(quotesByRequest[request.id]).map((quote) => {
                              const displayAmount = quote.status === 'COUNTERED' ? (quote.counterAmount ?? quote.amount) : quote.amount;
                              const isRequesterTurn = quote.status === 'SELECTED' || (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');
                              const isCompetitionBid = quote.status === 'PENDING';
                              const isWaitingOnInspector = quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';
                              return (
                                <div key={quote.id} className="evidence" style={{ marginBottom: 6 }}>
                                  <div>
                                    <strong>{quote.inspector?.name || 'Inspector'}</strong>
                                    {' — '}{Number(displayAmount).toLocaleString()} ETB
                                    <span className="badge" style={{ marginLeft: 8 }}>{quote.status}</span>
                                  </div>
                                  <p className="muted">
                                    {quote.inspector?.location || 'Location not set'}
                                    {quote.inspector?.rating != null && ` · Rating ${Number(quote.inspector.rating).toFixed(1)}`}
                                    {quote.inspector?.verificationStatus && ` · ${quote.inspector.verificationStatus}`}
                                  </p>
                                  {quote.message && <p className="muted">"{quote.message}"</p>}
                                  {isWaitingOnInspector && (
                                    <p className="muted">You countered {Number(displayAmount).toLocaleString()} ETB — waiting for the inspector to respond.</p>
                                  )}
                                  {isCompetitionBid && request.requestedById === user?.id && request.status === 'REQUESTED' && (
                                    <button type="button" className="btn btn-primary btn-sm" disabled={acceptingQuoteId === quote.id} onClick={() => selectInspectionQuote(request.id, quote.id)}>
                                      {acceptingQuoteId === quote.id ? 'Selecting…' : 'Select bid for deal'}
                                    </button>
                                  )}
                                  {quote.status === 'ACCEPTED' && request.requestedById === user?.id && (
                                    <div style={{ marginTop: 6 }}>
                                      <span className="muted small">Provisional inspector agreement. Release it if the inspector drops out before payment.</span>
                                      <button type="button" className="btn btn-light btn-sm" disabled={rejectingQuoteId === quote.id} onClick={() => releaseInspectionAgreement(request.id, quote.id)}>
                                        {rejectingQuoteId === quote.id ? 'Releasing…' : 'Release inspector agreement'}
                                      </button>
                                    </div>
                                  )}
                                  {isRequesterTurn && request.status === 'REQUESTED' && (
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        disabled={acceptingQuoteId === quote.id}
                                        onClick={() => acceptQuote(request.id, quote.id)}
                                      >
                                        {acceptingQuoteId === quote.id ? 'Accepting…' : 'Accept'}
                                      </button>
                                      <input
                                        type="number"
                                        min="1"
                                        placeholder="Counter (ETB)"
                                        style={{ width: 130 }}
                                        value={quoteCounterInputs[quote.id] || ''}
                                        onChange={(e) => setQuoteCounterInputs((q) => ({ ...q, [quote.id]: e.target.value }))}
                                      />
                                      <button
                                        type="button"
                                        className="btn btn-light btn-sm"
                                        disabled={counteringQuoteId === quote.id}
                                        onClick={() => counterQuote(request.id, quote.id)}
                                      >
                                        {counteringQuoteId === quote.id ? 'Sending…' : 'Counter'}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-light btn-sm"
                                        disabled={rejectingQuoteId === quote.id}
                                        onClick={() => rejectQuote(request.id, quote.id)}
                                      >
                                        {rejectingQuoteId === quote.id ? 'Rejecting…' : 'Reject'}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            <button
                              type="button"
                              className="btn btn-light btn-sm"
                              style={{ marginTop: 6 }}
                              disabled={loadingQuotesId === request.id}
                              onClick={() => loadQuotes(request.id)}
                            >
                              {loadingQuotesId === request.id ? 'Refreshing…' : 'Refresh quotes'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {(() => {
                      if (request.requestedById !== user?.id || request.fee == null) return null;
                      const existing = (request.payments || []).find((p) => ['PENDING', 'PROCESSING', 'PAID'].includes(p.status));
                      if (existing?.status === 'PAID') return <p className="muted" style={{ marginTop: 8 }}>Inspection fee paid.</p>;
                      if (existing?.status === 'PROCESSING') {
                        return <div style={{ marginTop: 8 }}><p className="muted">Your fee payment is being processed by Chapa.</p><button type="button" className="btn btn-primary btn-sm" disabled={payingInspectionId === request.id} onClick={() => checkInspectionPaymentStatus(existing.id, request.id)}>{payingInspectionId === request.id ? 'Checking…' : 'Check payment status'}</button></div>;
                      }
                      if (existing?.status === 'PENDING') {
                        return <div style={{ marginTop: 8 }}><p className="muted">Your fee payment hasn't completed yet.</p><button type="button" className="btn btn-primary btn-sm" disabled={payingInspectionId === request.id} onClick={() => resumeInspectionPayment(existing.id, request.id)}>{payingInspectionId === request.id ? 'Redirecting…' : 'Resume payment'}</button></div>;
                      }
                      return <div style={{ marginTop: 8 }}><p>Fee due: <strong>{Number(request.fee).toLocaleString()} ETB</strong></p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><select value={inspectionPayMethod} onChange={(e) => setInspectionPayMethod(e.target.value)}><option value="TELEBIRR">Telebirr</option><option value="QR">QR</option></select><button type="button" className="btn btn-primary btn-sm" disabled={payingInspectionId === request.id} onClick={() => payInspection(request)}>{payingInspectionId === request.id ? 'Submitting…' : 'Pay inspection fee'}</button></div></div>;
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
            {isBuyer && myLatestOffer && (isAgricultural || isProduct) && (
              <div className="card" id="negotiation">
                <h2>Your negotiation</h2>
                <p>Current amount: <strong>{money(myLatestOffer.counterAmount ?? myLatestOffer.amount)} ETB</strong></p>
                <span className="badge">{myLatestOffer.status}</span>
                {myLatestOffer.status === 'SELECTED' && (
                  <>
                    <p className="muted" style={{ marginTop: 10 }}><strong>The seller selected your bid.</strong> Competition is complete for this deal. Accept the selected price or make your counter.</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary" onClick={() => respondToOffer(myLatestOffer.id, 'ACCEPT_SELECTED')}>Accept selected price</button>
                      <input type="number" min="0.01" step="0.01" placeholder="Counter ETB" value={buyerCounter} onChange={(e) => setBuyerCounter(e.target.value)} style={{ minWidth: 140 }} />
                      <button className="btn btn-light" disabled={!buyerCounter} onClick={() => respondToOffer(myLatestOffer.id, 'RE_COUNTER', buyerCounter)}>Counter</button>
                    </div>
                  </>
                )}
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
                {myLatestOffer.status === 'PENDING' && <p className="muted" style={{ marginTop: 10 }}>Your offer remains active while other buyers may compete. The seller will select one buyer to open negotiation.</p>}
                {myLatestOffer.status === 'REJECTED' && <p className="muted" style={{ marginTop: 10 }}>The seller rejected this offer. If the listing is available, you can make a new offer.</p>}
                {myLatestOffer.status === 'ACCEPTED' && <Link className="btn btn-primary full" style={{ marginTop: 10 }} to={(listing.orders || []).find((o) => o.buyerId === user?.id)?.id ? `/orders/${(listing.orders || []).find((o) => o.buyerId === user?.id).id}` : '#'}>Continue to order →</Link>}
              </div>
            )}

            {isBuyer && (
              <div className="card sticky-card" id="make-offer">
                <h2>{!isAvailable || buyerHasActiveOfferDeal ? 'Offer unavailable' : 'Make an Offer'}</h2>
                {buyerHasActiveOfferDeal ? (
                  <div>
                    <p className="muted">You already have an active buyer offer on this listing. Continue the existing negotiation below instead of submitting another root bid.</p>
                    <button type="button" className="btn btn-light full" onClick={() => document.getElementById('negotiation')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Open negotiation</button>
                  </div>
                ) : !isAvailable ? (
                  <>
                    <p className="muted">This listing has an accepted offer and is temporarily unavailable to new buyers.</p>
                    <Link className="btn btn-light full" to={isAgricultural ? '/agricultural' : '/products'}>Browse available listings</Link>
                  </>
                ) : (isAgricultural || isProduct) ? (
                  <>
                    <p className="muted">This listing uses competitive bidding. Your first bid enters the competition; it does <strong>not</strong> charge you or reserve the product. If the seller selects your bid, you can negotiate repeatedly with the seller before accepting the provisional deal.</p>
                    <form onSubmit={submitOffer}>
                      <label>{isProduct ? 'Offer amount (ETB)' : 'Your bid / offer (ETB)'}</label>
                      <input required type="number" min="0.01" step="0.01" inputMode="decimal" placeholder={isProduct ? 'Enter the amount you want to offer (ETB)' : 'Enter your bid amount (ETB)'} value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} aria-label="Your bid amount in ETB" />
                      <label>Message</label>
                      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={isProduct ? 'Optional message to the seller' : 'Optional message to the farmer'} />
                      <button type="submit" className="btn btn-primary full" disabled={!offerAmount || Number(offerAmount) <= 0}>{isProduct ? 'Make Offer' : 'Submit bid'}</button>
                    </form>
                    {(isAgricultural || isProduct) && (
                      <>
                        <hr />
                        <h3>Quality check</h3>
                        {activeInspectionRequest ? (
                          <p className="small muted">Inspection already requested: <strong>{activeInspectionRequest.status.replaceAll('_', ' ')}</strong>. Continue with the existing inspection rather than creating another request.</p>
                        ) : (
                          <>
                            <p className="small muted">
                               {relatedOrder
                                 ? 'Request an independent inspection for this agreed order.'
                                 : 'Inspection becomes available after an offer is accepted and an order is created.'}
                             </p>
                            <button className="btn btn-light full" onClick={() => requestInspection('BUYER_REQUESTED')}>Request inspection</button>
                            
                          </>
                        )}
                      </>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {isOwner && (
              <div className="card sticky-card">
                <h2>Seller controls</h2>
                <p className="small muted">Only the seller can change price or listing status.</p>
                {(isAgricultural || isProduct) && (
                  <>
                    {activeInspectionRequest ? (
                      <p className="small muted">Inspection already requested: <strong>{activeInspectionRequest.status.replaceAll('_', ' ')}</strong>. Continue with the existing inspection.</p>
                    ) : (
                      <>
                        <button className="btn btn-light full" onClick={() => requestInspection('SELLER_REQUESTED')}>Request inspection</button>
                        
                      </>
                    )}
                  </>
                )}
                <h3 className="mt">Negotiations</h3>
                {(() => {
                  const offers = Array.isArray(listing.offers) ? listing.offers : [];
                  const byBuyer = new Map();

                  // Each parentOfferId points to the previous step in the same
                  // negotiation chain. The leaf is the only actionable offer.
                  // Group by buyer so separate negotiations do not visually
                  // stack together as if they were one conversation.
                  for (const offer of offers) {
                    const buyerId = offer.buyerId || offer.buyer?.id || offer.id;
                    const existing = byBuyer.get(buyerId);
                    if (!existing || new Date(offer.createdAt || 0) > new Date(existing.createdAt || 0)) {
                      byBuyer.set(buyerId, offer);
                    }
                  }

                  const negotiations = Array.from(byBuyer.values())
                    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

                  return negotiations.length ? (
                    <div style={{ display: 'grid', gap: 12 }}>
                      {negotiations.map((offer) => (
                        <OfferRow key={offer.id} offer={offer} onAction={respondToOffer} />
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No negotiations yet.</p>
                  );
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
  const [busy, setBusy] = useState('');

  // The seller may respond to an original PENDING offer, or to the buyer's
  // latest COUNTERED offer. A seller counter means the buyer must respond.
  const sellerCanAct =
    offer.status === 'SELECTED' ||
    (offer.status === 'COUNTERED' && String(offer.counteredBy || '').toUpperCase() === 'BUYER');

  const buyerCountered =
    offer.status === 'COUNTERED' && String(offer.counteredBy || '').toUpperCase() === 'BUYER';

  const amount = Number(offer.counterAmount ?? offer.amount);
  const minimum = Number(
    offer.listing?.minimumPrice ??
    offer.minimumPrice ??
    offer.listingMinimumPrice ??
    NaN
  );

  const submit = async (action, value) => {
    if (busy) return;
    setBusy(action);
    try {
      await onAction(offer.id, action, value);
      if (action === 'COUNTER') setCounter('');
    } finally {
      setBusy('');
    }
  };

  const counterValue = Number(counter);
  const counterValid = Number.isFinite(counterValue) && counterValue > 0;
  const counterBelowMinimum = Number.isFinite(minimum) && counterValid && counterValue < minimum;

  return (
    <div className="offer-row" style={{ padding: 12, borderRadius: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{Number.isFinite(amount) ? amount.toLocaleString() : '—'} ETB</strong>
        <span className="badge">{offer.status}</span>
      </div>
      <small>{offer.buyer?.name || 'Buyer'}</small>

      {buyerCountered && (
        <p className="muted" style={{ marginTop: 8 }}>
          <strong>Buyer countered.</strong> This is the buyer's latest price. You can accept it, reject the negotiation, or send another counter.
        </p>
      )}

      {offer.status === 'COUNTERED' && String(offer.counteredBy || '').toUpperCase() === 'SELLER' && (
        <p className="muted" style={{ marginTop: 8 }}>You made the latest counter. Waiting for the buyer.</p>
      )}

      {offer.status === 'PENDING' && (
        <div className="row-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => submit('SELECT')}>
            {busy === 'SELECT' ? 'Selecting…' : 'Select buyer for deal'}
          </button>
          <button type="button" className="btn btn-sm btn-light" disabled={Boolean(busy)} onClick={() => submit('REJECT')}>
            {busy === 'REJECT' ? 'Rejecting…' : 'Reject bid'}
          </button>
        </div>
      )}

      {sellerCanAct && (
        <div className="row-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={Boolean(busy)}
            onClick={() => submit('ACCEPT')}
          >
            {busy === 'ACCEPT' ? 'Accepting…' : 'Accept'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-light"
            disabled={Boolean(busy)}
            onClick={() => submit('REJECT')}
          >
            {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
          </button>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder={Number.isFinite(minimum) ? `Counter ≥ ${minimum}` : 'Counter ETB'}
            value={counter}
            disabled={Boolean(busy)}
            onChange={(e) => setCounter(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm btn-light"
            disabled={!counterValid || counterBelowMinimum || Boolean(busy)}
            onClick={() => submit('COUNTER', counter)}
          >
            {busy === 'COUNTER' ? 'Sending…' : 'Counter'}
          </button>
        </div>
      )}

      {!sellerCanAct && offer.status === 'COUNTERED' && String(offer.counteredBy || '').toUpperCase() !== 'BUYER' && (
        <p className="small muted" style={{ marginTop: 8 }}>Waiting for the buyer to respond.</p>
      )}

      {offer.status === 'ACCEPTED' && (
        <p className="small muted" style={{ marginTop: 8 }}>Agreed price: <strong>{Number(amount).toLocaleString()} ETB</strong>. The order can now continue to inspection and payment.</p>
      )}
    </div>
  );
}
