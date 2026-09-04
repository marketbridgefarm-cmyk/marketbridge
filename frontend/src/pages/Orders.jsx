import React,{useEffect,useState}from'react';
import {Link} from 'react-router-dom';
import api from '../api/client';
import {useAuth} from '../context/AuthContext.jsx';

const shortId=(id)=>id?.slice(0,8)||'—';
const money=(v)=>Number(v||0).toLocaleString();

export default function Orders(){
  const {user}=useAuth();
  const [orders,setOrders]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{let alive=true;(async()=>{try{const r=await api.get('/orders');if(alive)setOrders(r.data.orders||[])}catch(e){if(alive)setError(e.response?.data?.error||'Could not load orders')}finally{if(alive)setLoading(false)}})();return()=>{alive=false}},[]);
  return <main className="section"><div className="container-narrow">
    <div className="page-header"><div><span className="eyebrow">ORDERS</span><h1>Your orders</h1><p>Every accepted offer becomes an order. Open an order to continue with payment, transport and delivery.</p></div></div>
    {error&&<div className="alert error">{error}</div>}
    <div className="card">
      {loading?<p>Loading orders…</p>:orders.length===0?<div className="notice">No orders yet. Accepted offers will appear here.</div>:
      <div className="sd-cards">{orders.map(o=><div className="sd-card" key={o.id}>
        <div className="row-between"><div><span className="eyebrow">ORDER {shortId(o.id)}</span><h2>{o.listing?.title||o.listing?.cropType||'Order'}</h2></div><span className="badge">{o.status}</span></div>
        <p>{money(o.finalPrice)} ETB · {user?.id===o.buyerId?'Seller':'Buyer'}: {user?.id===o.buyerId?(o.seller?.name||'—'):(o.buyer?.name||'—')}</p>
        <Link className="btn btn-primary" to={`/orders/${o.id}`}>View order</Link>
      </div>)}</div>}
    </div>
  </div></main>
}
