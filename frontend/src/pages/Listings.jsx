import React,{useEffect,useState} from 'react';
import api from '../api/client';
import ListingCard from '../components/ListingCard.jsx';
import {Link} from 'react-router-dom';

export default function Listings({category='AGRICULTURAL'}) {
  const agriculture=category==='AGRICULTURAL';
  const [listings,setListings]=useState([]),[filters,setFilters]=useState({cropType:'',title:'',location:'',minQuantity:''}),[loading,setLoading]=useState(true),[error,setError]=useState('');
  async function fetchListings(){setLoading(true);setError('');try{const r=await api.get('/listings',{params:{...filters,category}});setListings(r.data.listings||[])}catch(e){setError('Could not load marketplace listings.')}finally{setLoading(false)}}
  useEffect(()=>{fetchListings()},[category]);
  return <main className="section"><div className="container-wide">
    <div className="page-header"><div><span className="eyebrow">{agriculture?'AGRICULTURAL MARKETPLACE':'PRODUCT MARKETPLACE'}</span><h1>{agriculture?'Find produce at the source.':'Buy and sell physical products.'}</h1><p>{agriculture?'Compare bulk farm listings, quantities, locations and asking prices.':'A general marketplace for physical goods. Any member can buy and sell.'}</p></div><Link to="/create-listing" className="btn btn-primary">+ {agriculture?'List produce':'List product'}</Link></div>
    <div className="search-panel">
      <div><label>{agriculture?'Produce':'Product'}</label><input value={agriculture?filters.cropType:filters.title} onChange={e=>setFilters({...filters,[agriculture?'cropType':'title']:e.target.value})} placeholder={agriculture?'Potatoes, wheat, barley...':'What are you looking for?'}/></div>
      <div><label>Location</label><input value={filters.location} onChange={e=>setFilters({...filters,location:e.target.value})} placeholder="Region, town or district"/></div>
      <div><label>Minimum quantity</label><input type="number" value={filters.minQuantity} onChange={e=>setFilters({...filters,minQuantity:e.target.value})}/></div>
      <button className="btn btn-primary" onClick={fetchListings}>Search</button>
    </div>
    {error&&<div className="alert error">{error}</div>}<div className="market-toolbar"><strong>{loading?'Loading…':`${listings.length} listing${listings.length===1?'':'s'}`}</strong><span className="muted">{agriculture?'Independent inspection can support bulk transactions.':'Buyers and sellers transact directly through MarketBridge workflows.'}</span></div>
    {loading?<div className="loading">Loading marketplace…</div>:<div className="listing-grid">{listings.map(l=><ListingCard key={l.id} listing={l}/>)}{!listings.length&&<div className="empty card"><h3>No matching listings</h3><p>Try a broader search.</p></div>}</div>}
  </div></main>;
}
