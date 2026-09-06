import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { chapaInitializeAndRedirect } from '../utils/chapaCheckout';

export default function DigitalMarketplace(){
 const {user}=useAuth(); const [products,setProducts]=useState([]),[search,setSearch]=useState(''),[myPurchases,setMyPurchases]=useState([]);
 const [form,setForm]=useState({title:'',productType:'ebook',price:'',description:'',file:null}); const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [busyId,setBusyId]=useState('');
 async function load(){try{const r=await api.get('/digital-products',{params:{search}});setProducts(r.data.products||[])}catch(e){setError(e.response?.data?.error||'Could not load products')}}
 async function loadMyPurchases(){if(!user?.roles?.includes('BUYER'))return;try{const r=await api.get('/digital-products/purchases/mine');setMyPurchases(r.data.purchases||[])}catch(e){/* non-fatal — buy button just won't show resume state */}}
 useEffect(()=>{load();loadMyPurchases()},[]);
 async function submit(e){e.preventDefault();setError('');setMessage(''); if(!form.file){setError('Choose a file');return} const fd=new FormData(); fd.append('title',form.title);fd.append('productType',form.productType);fd.append('price',form.price);fd.append('description',form.description);fd.append('file',form.file); try{await api.post('/digital-products',fd,{headers:{'Content-Type':'multipart/form-data'}});setForm({title:'',productType:'ebook',price:'',description:'',file:null});setMessage('Product published securely.');load()}catch(e){setError(e.response?.data?.error||'Could not publish product')}}
 async function purchase(p){setError('');setMessage('');setBusyId(p.id);try{const r=await api.post(`/digital-products/${p.id}/purchase`,{method:'OTHER'});await chapaInitializeAndRedirect(r.data.payment?.id)}catch(e){setError(e.response?.data?.error||e.message||'Could not create purchase');setBusyId('')}}
 async function resumePurchase(paymentId,productId){setError('');setBusyId(productId);try{await chapaInitializeAndRedirect(paymentId)}catch(e){setError(e.response?.data?.error||e.message||'Could not resume payment');setBusyId('')}}
 async function download(purchaseId,productId){setError('');setBusyId(productId);try{const r=await api.get(`/digital-products/${purchaseId}/download`);window.open(r.data.downloadUrl,'_blank','noopener')}catch(e){setError(e.response?.data?.error||e.message||'Could not get download link')}finally{setBusyId('')}}
 function purchaseFor(productId){return myPurchases.find(pu=>pu.product?.id===productId)}
 return <main className="section"><div className="container-wide"><div className="page-header"><div><span className="eyebrow">DIGITAL MARKETPLACE</span><h1>Useful products, delivered digitally.</h1><p>Files are stored privately and downloads are available only after verified payment.</p></div></div>
 <div className="search-panel"><div><label>Search digital products</label><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by title"/></div><button className="btn btn-primary" onClick={load}>Search</button></div>
 {error&&<div className="alert error">{error}</div>}
 {message&&<div className="alert">{message}</div>}
 {user?.roles?.includes('SELLER')&&<div className="card form-card"><h2>Publish a digital product</h2><div className="form-grid"><div><label>Title</label><input value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></div><div><label>Type</label><select value={form.productType} onChange={e=>setForm({...form,productType:e.target.value})}>{['ebook','template','graphic','photo','software_license','course','document'].map(x=><option key={x}>{x}</option>)}</select></div><div><label>Price (ETB)</label><input type="number" min="0.01" step="0.01" value={form.price} onChange={e=>setForm({...form,price:e.target.value})}/></div><div><label>Private file</label><input type="file" onChange={e=>setForm({...form,file:e.target.files?.[0]||null})}/></div></div><label>Description</label><textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/><button className="btn btn-primary" onClick={submit}>Publish securely</button></div>}
 <div className="listing-grid">{products.map(p=>{
   const existingPurchase=purchaseFor(p.id);
   const paymentStatus=existingPurchase?.payment?.status;
   return <article className="digital-card card" key={p.id}><div className="digital-icon">{p.productType?.slice(0,1).toUpperCase()}</div><span className="tag">{p.productType?.replaceAll('_',' ')}</span><h3>{p.title}</h3><p className="muted">{p.description||'Digital product from an independent seller.'}</p><div className="row-between"><strong>{Number(p.price).toLocaleString()} ETB</strong><span className="small">By {p.seller?.name||'Seller'}</span></div>
     {user?.roles?.includes('BUYER')&&paymentStatus==='PAID'&&<button className="btn btn-primary" disabled={busyId===p.id} onClick={()=>download(existingPurchase.id,p.id)}>{busyId===p.id?'Getting link…':'Download'}</button>}
     {user?.roles?.includes('BUYER')&&paymentStatus==='PENDING'&&<button className="btn btn-primary" disabled={busyId===p.id} onClick={()=>resumePurchase(existingPurchase.payment.id,p.id)}>{busyId===p.id?'Redirecting…':'Resume payment'}</button>}
     {user?.roles?.includes('BUYER')&&!paymentStatus&&<button className="btn btn-primary" disabled={busyId===p.id} onClick={()=>purchase(p)}>{busyId===p.id?'Starting…':'Buy'}</button>}
   </article>
 })}</div>{!products.length&&<div className="empty card">No digital products found.</div>}</div></main>
}
