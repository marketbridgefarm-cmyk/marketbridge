import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ImageCarousel from '../components/ImageCarousel.jsx';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext.jsx';
import api from '../api/client';
import { chapaInitializeAndRedirect } from '../utils/chapaCheckout';

// Only TELEBIRR and QR route to a configured payment adapter (both go
// through Chapa's hosted checkout — see
// backend/src/services/paymentProviders/index.js). CBE and OTHER are
// deliberately left unconfigured there, so they're not offered as choices
// here; picking either would always fail at chapa/initialize.
const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

export default function DigitalMarketplace() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [myPurchases, setMyPurchases] = useState([]);
  const [form, setForm] = useState({ title: '', productType: 'ebook', price: '', description: '', file: null, previews: [] });
  const [busyId, setBusyId] = useState('');
  const [payMethod, setPayMethod] = useState('TELEBIRR');

  async function load() {
    try {
      const r = await api.get('/digital-products', { params: { search } });
      setProducts(r.data.products || []);
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not load products', 'error');
    }
  }

  async function loadMyPurchases() {
    if (!user) return;
    try {
      const r = await api.get('/digital-products/purchases/mine');
      setMyPurchases(r.data.purchases || []);
    } catch (e) { /* non-fatal */ }
  }

  useEffect(() => { load(); loadMyPurchases(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!form.file) { showToast('Choose a file', 'error'); return; }
    const fd = new FormData();
    fd.append('title', form.title);
    fd.append('productType', form.productType);
    fd.append('price', form.price);
    fd.append('description', form.description);
    fd.append('file', form.file);
    form.previews.forEach((img) => fd.append('previews', img));
    try {
      await api.post('/digital-products', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm({ title: '', productType: 'ebook', price: '', description: '', file: null, previews: [] });
      showToast('Product published securely.', 'success');
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Could not publish product', 'error');
    }
  }

  async function purchase(p) {
    setBusyId(p.id);
    try {
      const key = `digital-purchase:${p.id}`;
      const r = await api.post(
        `/digital-products/${p.id}/purchase`,
        { method: payMethod },
        { headers: { 'Idempotency-Key': key } }
      );
      await chapaInitializeAndRedirect(r.data.payment?.id);
    } catch (e) {
      showToast(e.response?.data?.error === 'You cannot purchase your own product' ? 'You cannot purchase your own product.' : (e.response?.data?.error || e.message || 'Could not create purchase'), 'error');
      setBusyId('');
    }
  }

  async function resumePurchase(paymentId, productId) {
    setBusyId(productId);
    try {
      await chapaInitializeAndRedirect(paymentId);
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not resume payment', 'error');
      setBusyId('');
    }
  }

  // PROCESSING means Chapa checkout already started for this purchase.
  // Must be checked, never resumed/re-bought — same pattern as
  // OrderDetail.jsx's checkPaymentStatus. Previously this status had no
  // rendering branch at all here, so a stuck PROCESSING purchase just
  // silently showed nothing to do.
  async function checkPurchaseStatus(paymentId, productId) {
    setBusyId(productId);
    try {
      const r = await api.get(`/payments/${paymentId}/chapa/verify`);
      await Promise.all([load(), loadMyPurchases()]);
      if (r.data?.status === 'PENDING') {
        showToast('Chapa has not confirmed this payment yet. Try again shortly, or retry once it shows FAILED.', 'info');
      }
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not check payment status', 'error');
    } finally {
      setBusyId('');
    }
  }

  async function download(purchaseId, productId) {
    setBusyId(productId);
    try {
      const r = await api.get(`/digital-products/${purchaseId}/download`);
      window.open(r.data.downloadUrl, '_blank', 'noopener');
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not get download link', 'error');
    } finally {
      setBusyId('');
    }
  }

  function purchaseFor(productId) {
    return myPurchases.find(pu => pu.product?.id === productId);
  }

  function statusBadgeClass(status) {
    if (status === 'PAID' || status === 'COMPLETED') return 'sd-badge sd-good';
    if (status === 'RECONCILIATION_REQUIRED' || status === 'FAILED') return 'sd-badge sd-red';
    return 'sd-badge sd-warn';
  }

  return (
    <main className="section">
      <div className="container-wide">
        <div className="page-header">
          <div>
            <span className="eyebrow">DIGITAL MARKETPLACE</span>
            <h1>Useful products, delivered digitally.</h1>
            <p>Files are stored privately and downloads are available only after verified payment.</p>
          </div>
        </div>
        <div className="search-panel">
          <div>
            <label>Search digital products</label>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by title" />
          </div>
          <button className="btn btn-primary" onClick={load}>Search</button>
        </div>
        {user?.roles?.includes('SELLER') && (
          <div className="card form-card">
            <h2>Publish a digital product</h2>
            <div className="form-grid">
              <div><label>Title</label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
              <div><label>Type</label><select value={form.productType} onChange={e => setForm({ ...form, productType: e.target.value })}>{['ebook', 'template', 'graphic', 'photo', 'software_license', 'course', 'document'].map(x => <option key={x}>{x}</option>)}</select></div>
              <div><label>Price (ETB)</label><input type="number" min="0.01" step="0.01" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} /></div>
              <div><label>Private file</label><input type="file" onChange={e => setForm({ ...form, file: e.target.files?.[0] || null })} /></div>
              <div><label>Preview images (up to 5, shown on the product card)</label><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => setForm({ ...form, previews: Array.from(e.target.files || []).slice(0, 5) })} /></div>
            </div>
            <label>Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            <button className="btn btn-primary" onClick={submit}>Publish securely</button>
          </div>
        )}

        {user && myPurchases.length > 0 && (
          <div className="card" style={{ marginBottom: 20 }}>
            <h2>Your purchases</h2>
            <p className="muted">
              Everything you've bought stays here and stays downloadable — independent of
              whether a listing is still active in the catalog below.
            </p>
            <div className="listing-grid">
              {myPurchases.map((pu) => {
                const productId = pu.product?.id;
                const paymentStatus = pu.payment?.status;
                return (
                  <article className="digital-card card" key={pu.id}>
                    <div className="digital-icon">{pu.product?.productType?.slice(0, 1).toUpperCase() || '?'}</div>
                    <span className="tag">{pu.product?.productType?.replaceAll('_', ' ') || 'digital product'}</span>
                    <h3>{pu.product?.title || 'Digital product'}</h3>
                    <p className="muted">
                      Purchased {new Date(pu.createdAt).toLocaleDateString()}
                      {pu.downloadCount > 0 && ` · Downloaded ${pu.downloadCount} time${pu.downloadCount === 1 ? '' : 's'}`}
                    </p>
                    <div className="row-between">
                      <strong>{Number(pu.product?.price || 0).toLocaleString()} ETB</strong>
                      <span className={statusBadgeClass(paymentStatus)}>{paymentStatus?.replaceAll('_', ' ')}</span>
                    </div>
                    {paymentStatus === 'PAID' && (
                      <button className="btn btn-primary" disabled={busyId === productId} onClick={() => download(pu.id, productId)}>
                        {busyId === productId ? 'Getting link…' : 'Download again'}
                      </button>
                    )}
                    {paymentStatus === 'PENDING' && (
                      <button className="btn btn-primary" disabled={busyId === productId} onClick={() => resumePurchase(pu.payment.id, productId)}>
                        {busyId === productId ? 'Redirecting…' : 'Resume payment'}
                      </button>
                    )}
                    {paymentStatus === 'PROCESSING' && (
                      <button className="btn btn-primary" disabled={busyId === productId} onClick={() => checkPurchaseStatus(pu.payment.id, productId)}>
                        {busyId === productId ? 'Checking…' : 'Check payment status'}
                      </button>
                    )}
                    {paymentStatus === 'RECONCILIATION_REQUIRED' && (
                      <p className="small muted">Payment is being reconciled by our team — check back shortly.</p>
                    )}
                    {(paymentStatus === 'FAILED' || paymentStatus === 'REFUNDED') && (
                      <p className="small muted">{paymentStatus === 'FAILED' ? 'This payment was not completed.' : 'This purchase was refunded.'}</p>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {(user && myPurchases.length > 0) && <h2 style={{ marginTop: 8 }}>Browse the marketplace</h2>}

        {user && (
          <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor="digital-pay-method" style={{ marginBottom: 0 }}>Payment method</label>
            <select id="digital-pay-method" value={payMethod} onChange={(e) => setPayMethod(e.target.value)} style={{ maxWidth: 220 }}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <span className="muted small">Applies to purchases below.</span>
          </div>
        )}

        <div className="listing-grid">
          {products.map(p => {
            const existingPurchase = purchaseFor(p.id);
            const paymentStatus = existingPurchase?.payment?.status;
            return (
              <article className="digital-card card" key={p.id}>
                {p.previewImages?.length
                  ? <ImageCarousel images={p.previewImages} alt={p.title} className="img-carousel--compact" />
                  : <div className="digital-icon">{p.productType?.slice(0, 1).toUpperCase()}</div>}
                <span className="tag">{p.productType?.replaceAll('_', ' ')}</span>
                <h3>{p.title}</h3>
                <p className="muted">{p.description || 'Digital product from an independent seller.'}</p>
                <div className="row-between"><strong>{Number(p.price).toLocaleString()} ETB</strong><span className="small">By {p.seller?.name || 'Seller'}</span></div>
                {user && paymentStatus === 'PAID' && (
                  <button className="btn btn-primary" disabled={busyId === p.id} onClick={() => download(existingPurchase.id, p.id)}>{busyId === p.id ? 'Getting link…' : 'Download'}</button>
                )}
                {user && paymentStatus === 'PENDING' && (
                  <button className="btn btn-primary" disabled={busyId === p.id} onClick={() => resumePurchase(existingPurchase.payment.id, p.id)}>{busyId === p.id ? 'Redirecting…' : 'Resume payment'}</button>
                )}
                {user && paymentStatus === 'PROCESSING' && (
                  <button className="btn btn-primary" disabled={busyId === p.id} onClick={() => checkPurchaseStatus(existingPurchase.payment.id, p.id)}>{busyId === p.id ? 'Checking…' : 'Check payment status'}</button>
                )}
                {!user && (
                  <Link className="btn btn-primary" to="/login">Sign in to buy · {Number(p.price).toLocaleString()} ETB</Link>
                )}
                {user && (!paymentStatus || ['FAILED', 'REFUNDED', 'CANCELLED'].includes(paymentStatus)) && (
                  <button className="btn btn-primary" disabled={busyId === p.id} onClick={() => purchase(p)}>
                    {busyId === p.id ? 'Starting…' : (paymentStatus ? 'Try again' : `Buy · ${Number(p.price).toLocaleString()} ETB`)}
                  </button>
                )}
              </article>
            );
          })}
        </div>
        {!products.length && <div className="empty card">No digital products found.</div>}
      </div>
    </main>
  );
}
