import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const money = n => Number(n || 0).toLocaleString();

export default function ListingDetail() {
  const { id } = useParams(); const { user } = useAuth();
  const [listing,setListing]=useState(null); const [offerAmount,setOfferAmount]=useState(''); const [message,setMessage]=useState('');
  const [msg,setMsg]=useState(''); const [error,setError]=useState(''); const [inspector,setInspector]=useState(null);

  async function load(){ try { const r=await api.get(`/listings/${id}`); setListing(r.data.listing); } catch(e){setError('Listing not found.');} }
  useEffect(()=>{load()},[id]);
  async function submitOffer(e){e.preventDefault();setError('');try{await api.post('/offers',{listingId:id,amount:Number(offerAmount),message});setMsg('Offer submitted. The farmer retains final price authority.');setOfferAmount('');setMessage('');load()}catch(e){setError(e.response?.data?.error||'Could not submit offer')}}
  async function requestInspection(mode){setError('');try{let body={listingId:id,mode};if(inspector)body.inspectorId=inspector;await api.post('/inspections',body);setMsg('Inspection request created.');load()}catch(e){setError(e.response?.data?.error||'Could not request inspection')}}
  async function respondToOffer(offerId,action,counterAmount){try{await api.patch(`/offers/${offerId}`,{action,counterAmount:Number(counterAmount)});setMsg(`Offer ${action.toLowerCase()}ed.`);load()}catch(e){setError(e.response?.data?.error||'Action failed')}}
  async function chooseInspector(){try{const r=await api.get('/inspections/inspectors',{params:{location:listing.location}});setInspector(r.data.inspectors||[])}catch(e){setError('Could not load inspectors')}}
  if(!listing)return <main className="section"><div className="container-wide loading">Loading listing…</div></main>;
  const isOwner=user?.id===listing.sellerId, isBuyer=user?.roles?.includes('BUYER')&&!isOwner, isAgricultural=listing.category==='AGRICULTURAL';
  return <main className="section"><div className="container-wide">
    <Link className="back-link" to={isAgricultural?'/agricultural':'/products'}>← Back to marketplace</Link>
    <div className="detail-grid">
      <section>
        <div className="detail-media">{listing.photos?.[0]?<img src={listing.photos[0]} alt={listing.title||listing.cropType}/>:<div className="media-placeholder">{listing.title||listing.cropType}</div>}</div>
        <div className="card detail-content"><div className="listing-meta"><span className="tag">{isAgricultural?'AGRICULTURE':'PRODUCT'}</span><span className="badge">{listing.status}</span></div><h1>{listing.title||listing.cropType}</h1><p className="lead">{Number(listing.quantity).toLocaleString()} {listing.unit} available · {listing.location}</p>
        <div className="detail-facts"><div><span>Asking price</span><strong>{money(listing.askingPrice)} ETB</strong></div><div><span>Ready</span><strong>{listing.readinessDate?new Date(listing.readinessDate).toLocaleDateString():'To be agreed'}</strong></div><div><span>Seller</span><strong>{listing.seller?.name}</strong></div></div>
        <p className="muted">MarketBridge is an intermediary. The seller retains ownership and price authority.</p></div>
        {isAgricultural&&<div className="card"><h2>Inspection evidence</h2>{listing.inspectionRequests?.length?<>{listing.inspectionRequests.map(r=><div className="evidence" key={r.id}><div><strong>{r.mode.replaceAll('_',' ')}</strong><span className="badge">{r.status}</span></div>{r.inspector&&<p>Inspector: {r.inspector.name}</p>}{r.report?<p>✓ {r.report.quantity} verified · {r.report.grade||'Grade not stated'}{r.report.moisture!=null?` · ${r.report.moisture}% moisture`:''}{r.report.visibleDefects?` · ${r.report.visibleDefects}`:''}</p>:<p className="muted">Report pending.</p>}</div>)}</>:<p className="muted">No inspection yet. Quality-before-payment is the preferred agricultural workflow.</p>}</div>}
      </section>
      <aside>
        {msg&&<div className="alert success">{msg}</div>}{error&&<div className="alert error">{error}</div>}
        {isBuyer&&<div className="card sticky-card"><h2>Make an offer</h2><p className="muted">The seller decides whether to accept, reject or counter.</p><form onSubmit={submitOffer}><label>Your offer (ETB)</label><input required type="number" value={offerAmount} onChange={e=>setOfferAmount(e.target.value)}/><label>Message</label><textarea value={message} onChange={e=>setMessage(e.target.value)} placeholder="Optional message to the farmer"/><button className="btn btn-primary full">Submit offer</button></form>{isAgricultural&&<><hr/><h3>Quality check</h3><p className="small muted">Request an independent inspection before purchase.</p><button className="btn btn-light full" onClick={()=>requestInspection('BUYER_REQUESTED')}>Request inspection</button></>}</div>}
        {isOwner&&<div className="card sticky-card"><h2>Seller controls</h2><p className="small muted">Only the seller can change price or listing status.</p><Link className="btn btn-primary full" to={`/listings/${id}`}>Manage listing</Link>{isAgricultural&&<button className="btn btn-light full" onClick={()=>requestInspection('SELLER_REQUESTED')}>Request inspection</button>}<h3 className="mt">Offers received</h3>{listing.offers?.length?listing.offers.map(o=><OfferRow key={o.id} offer={o} onAction={respondToOffer}/>):<p className="muted">No offers yet.</p>}</div>}
        {!user&&<div className="card"><h2>Ready to participate?</h2><p>Register to buy and sell across MarketBridge marketplaces.</p><Link className="btn btn-primary full" to="/register">Create account</Link></div>}
      </aside>
    </div>
  </div></main>;
}
function OfferRow({offer,onAction}){const [counter,setCounter]=useState('');return <div className="offer-row"><strong>{Number(offer.amount).toLocaleString()} ETB</strong><span className="badge">{offer.status}</span><small>{offer.buyer?.name||'Buyer'}</small>{['PENDING','COUNTERED'].includes(offer.status)&&<div className="row-actions"><button className="btn btn-sm" onClick={()=>onAction(offer.id,'ACCEPT')}>Accept</button><button className="btn btn-sm btn-light" onClick={()=>onAction(offer.id,'REJECT')}>Reject</button><input placeholder="Counter ETB" value={counter} onChange={e=>setCounter(e.target.value)}/><button className="btn btn-sm btn-light" disabled={!counter} onClick={()=>onAction(offer.id,'COUNTER',counter)}>Counter</button></div>}</div>}
