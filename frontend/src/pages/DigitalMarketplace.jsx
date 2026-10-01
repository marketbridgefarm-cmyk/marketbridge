import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ImageCarousel from '../components/ImageCarousel.jsx';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext.jsx';
import api from '../api/client';
import { chapaInitializeAndRedirect } from '../utils/chapaCheckout';

import './digitalmarketplace/DigitalMarketplace.css';   // ← add this line

// …rest of the file unchanged
// Only TELEBIRR and QR route to a configured payment adapter (both go
// through Chapa's hosted checkout — see
// backend/src/services/paymentProviders/index.js). CBE and OTHER are
// deliberately left unconfigured there, so they're not offered as choices
// here; picking either would always fail at chapa/initialize.
const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

const PRODUCT_TYPES = [
  'ebook',
  'template',
  'graphic',
  'photo',
  'software_license',
  'course',
  'document',
];

const humanize = (value) => String(value || '').replaceAll('_', ' ');

export default function DigitalMarketplace() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [myPurchases, setMyPurchases] = useState([]);
  const [form, setForm] = useState({ title: '', productType: 'ebook', price: '', description: '', file: null, previews: [] });
  const [busyId, setBusyId] = useState('');
  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/digital-products', {
        params: { search },
      });
      setProducts(r.data.products || []);
    } catch (e) {
      showToast(
        e.response?.data?.error || 'Could not load products',
        'error'
      );
    }
  }, [search, showToast]);

  const loadMyPurchases = useCallback(async () => {
    if (!user) {
      setMyPurchases([]);
      return;
    }

    try {
      const r = await api.get('/digital-products/purchases/mine');
      setMyPurchases(r.data.purchases || []);
    } catch (e) {
      // Non-fatal: the marketplace remains usable if purchase history fails.
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadMyPurchases();
  }, [loadMyPurchases]);

  async function submit(e) {
    e.preventDefault();
    if (!(form.file instanceof File) || form.file.size <= 0) {
      showToast('Choose a valid private product file', 'error');
      return;
    }
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
    if (status === 'PAID' || status === 'COMPLETED') return 'dm-badge dm-badge--good';
    if (status === 'RECONCILIATION_REQUIRED' || status === 'FAILED') return 'dm-badge dm-badge--danger';
    return 'dm-badge dm-badge--warn';
  }

  const isSeller = user?.roles?.includes('SELLER');
  const hasPurchases = user && myPurchases.length > 0;

  return (
    <main className="section digital-marketplace-page">
      <div className="container-wide">

        {/* ── Page header ─────────────────────────────────────── */}
        <header className="page-header">
          <div className="page-header-text">
            <span className="eyebrow">Digital marketplace</span>
            <h1>Useful products, delivered digitally.</h1>
            <p className="page-header-subtitle">
              Files are stored privately and downloads are available only after verified payment.
            </p>
          </div>
        </header>

        {/* ── Search bar ──────────────────────────────────────── */}
        <div className="search-bar" role="search">
          <span className="search-bar-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search digital products by title…"
            aria-label="Search digital products"
          />
          <button type="button" className="btn btn-primary" onClick={load}>
            Search
          </button>
        </div>

        {/* ── Publish form (sellers) ──────────────────────────── */}
        {isSeller && (
          <section className="dm-card" id="publish">
            <header className="dm-card-head">
              <div className="dm-card-head-main">
                <span className="eyebrow">For sellers</span>
                <h2 className="dm-card-title">Publish a digital product</h2>
                <p className="dm-card-subtitle">
                  Upload the private file and, optionally, a few preview images so buyers can see what they're getting.
                </p>
              </div>
              <div className="dm-card-head-side">
                <span className="dm-card-side-label">Visibility</span>
                <span className="dm-card-side-value">Private</span>
              </div>
            </header>

            <form className="publish-form" onSubmit={submit}>
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Title</span>
                  <input
                    type="text"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="e.g. Farm budget template for 2026"
                    required
                  />
                </label>

                <label className="field">
                  <span className="field-label">Type</span>
                  <select
                    value={form.productType}
                    onChange={(e) => setForm({ ...form, productType: e.target.value })}
                  >
                    {PRODUCT_TYPES.map((x) => (
                      <option key={x} value={x}>{humanize(x)}</option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">Price</span>
                  <div className="field-with-suffix">
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                      placeholder="0.00"
                      required
                    />
                    <span className="field-suffix">ETB</span>
                  </div>
                </label>

                <label className="field">
                  <span className="field-label">Private file</span>
                  <input
                    type="file"
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;
                      setForm((current) => ({ ...current, file }));
                    }}
                    required
                  />
                  <span className="field-hint">Stored securely — buyers only see it after payment.</span>
                </label>

                <label className="field field-span">
                  <span className="field-label">
                    Preview images <span className="optional">(up to 5)</span>
                  </span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={(e) => {
                      const previews = Array.from(e.target.files || []).slice(0, 5);
                      setForm((current) => ({ ...current, previews }));
                    }}
                  />
                  <span className="field-hint">Shown on the product card so buyers can preview the work.</span>
                </label>
              </div>

              <label className="field field-block">
                <span className="field-label">Description</span>
                <textarea
                  rows={4}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Describe what the buyer gets, who it's for, and what makes it useful."
                />
              </label>

              <div className="form-actions">
                <button type="submit" className="btn btn-primary">Publish securely</button>
              </div>
            </form>
          </section>
        )}

        {/* ── Your purchases ──────────────────────────────────── */}
        {hasPurchases && (
          <section className="dm-card">
            <header className="dm-card-head">
              <div className="dm-card-head-main">
                <span className="eyebrow">Your library</span>
                <h2 className="dm-card-title">Your purchases</h2>
                <p className="dm-card-subtitle">
                  Everything you've bought stays here and stays downloadable — independent of whether a listing is still active in the catalog below.
                </p>
              </div>
              <div className="dm-card-head-side">
                <span className="dm-card-side-label">Total</span>
                <span className="dm-card-side-value">
                  {myPurchases.length} item{myPurchases.length === 1 ? '' : 's'}
                </span>
              </div>
            </header>

            <ul className="purchase-list">
              {myPurchases.map((pu) => {
                const productId = pu.product?.id;
                const paymentStatus = pu.payment?.status;
                const initial = pu.product?.productType?.slice(0, 1).toUpperCase() || '?';
                const canAct =
                  paymentStatus === 'PAID' ||
                  paymentStatus === 'PENDING' ||
                  paymentStatus === 'PROCESSING';

                return (
                  <li className="purchase-row" key={pu.id}>
                    <span className="purchase-icon" aria-hidden="true">{initial}</span>

                    <div className="purchase-body">
                      <div className="purchase-title-row">
                        <h3 className="purchase-title">
                          {pu.product?.title || 'Digital product'}
                        </h3>
                        <span className={statusBadgeClass(paymentStatus)}>
                          {humanize(paymentStatus) || 'Unknown'}
                        </span>
                      </div>
                      <p className="purchase-meta">
                        {humanize(pu.product?.productType) || 'digital product'}
                        {' · Purchased '}
                        {new Date(pu.createdAt).toLocaleDateString()}
                        {pu.downloadCount > 0 && ` · Downloaded ${pu.downloadCount}×`}
                      </p>
                      {paymentStatus === 'RECONCILIATION_REQUIRED' && (
                        <p className="purchase-note">
                          Payment is being reconciled by our team — check back shortly.
                        </p>
                      )}
                      {(paymentStatus === 'FAILED' || paymentStatus === 'REFUNDED') && (
                        <p className="purchase-note">
                          {paymentStatus === 'FAILED'
                            ? 'This payment was not completed.'
                            : 'This purchase was refunded.'}
                        </p>
                      )}
                    </div>

                    <div className="purchase-actions">
                      <span className="purchase-price">
                        {Number(pu.product?.price || 0).toLocaleString()} <small>ETB</small>
                      </span>

                      {paymentStatus === 'PAID' && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId === productId}
                          onClick={() => download(pu.id, productId)}
                        >
                          {busyId === productId ? 'Getting link…' : 'Download again'}
                        </button>
                      )}
                      {paymentStatus === 'PENDING' && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId === productId}
                          onClick={() => resumePurchase(pu.payment.id, productId)}
                        >
                          {busyId === productId ? 'Redirecting…' : 'Resume payment'}
                        </button>
                      )}
                      {paymentStatus === 'PROCESSING' && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId === productId}
                          onClick={() => checkPurchaseStatus(pu.payment.id, productId)}
                        >
                          {busyId === productId ? 'Checking…' : 'Check status'}
                        </button>
                      )}
                      {!canAct && (
                        <span className="purchase-actions-note">No action needed</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ── Browse the marketplace ──────────────────────────── */}
        <section className="browse-section" aria-labelledby="browse-title">
          <header className="browse-header">
            <div className="browse-header-text">
              <span className="eyebrow">Catalog</span>
              <h2 id="browse-title" className="browse-title">Browse the marketplace</h2>
              <p className="browse-subtitle">
                {products.length} product{products.length === 1 ? '' : 's'} available
                {search ? ` for “${search}”` : ''}
              </p>
            </div>

            {user && (
              <label className="pay-method" htmlFor="digital-pay-method">
                <span className="pay-method-label">Payment method</span>
                <select
                  id="digital-pay-method"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
            )}
          </header>

          {products.length > 0 ? (
            <div className="product-grid">
              {products.map((p) => {
                const existingPurchase = purchaseFor(p.id);
                const paymentStatus = existingPurchase?.payment?.status;

                return (
                  <article className="product-card" key={p.id}>
                    {p.previewImages?.length ? (
                      <ImageCarousel
                        images={p.previewImages}
                        alt={p.title}
                        className="img-carousel--compact"
                      />
                    ) : (
                      <div className="product-icon" aria-hidden="true">
                        {p.productType?.slice(0, 1).toUpperCase()}
                      </div>
                    )}

                    <span className="product-type">{humanize(p.productType)}</span>
                    <h3 className="product-title">{p.title}</h3>
                    <p className="product-description">
                      {p.description || 'Digital product from an independent seller.'}
                    </p>

                    <div className="product-footer">
                      <span className="product-price">
                        {Number(p.price).toLocaleString()} <small>ETB</small>
                      </span>
                      <span className="product-seller">
                        By {p.seller?.name || 'Seller'}
                      </span>
                    </div>

                    {user && paymentStatus === 'PAID' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        disabled={busyId === p.id}
                        onClick={() => download(existingPurchase.id, p.id)}
                      >
                        {busyId === p.id ? 'Getting link…' : 'Download'}
                      </button>
                    )}
                    {user && paymentStatus === 'PENDING' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        disabled={busyId === p.id}
                        onClick={() => resumePurchase(existingPurchase.payment.id, p.id)}
                      >
                        {busyId === p.id ? 'Redirecting…' : 'Resume payment'}
                      </button>
                    )}
                    {user && paymentStatus === 'PROCESSING' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        disabled={busyId === p.id}
                        onClick={() => checkPurchaseStatus(existingPurchase.payment.id, p.id)}
                      >
                        {busyId === p.id ? 'Checking…' : 'Check payment status'}
                      </button>
                    )}
                    {!user && (
                      <Link className="btn btn-primary btn-block" to="/login">
                        Sign in to buy · {Number(p.price).toLocaleString()} ETB
                      </Link>
                    )}
                    {user && (!paymentStatus || ['FAILED', 'REFUNDED', 'CANCELLED'].includes(paymentStatus)) && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        disabled={busyId === p.id}
                        onClick={() => purchase(p)}
                      >
                        {busyId === p.id
                          ? 'Starting…'
                          : (paymentStatus
                              ? 'Try again'
                              : `Buy · ${Number(p.price).toLocaleString()} ETB`)}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7l9-4 9 4-9 4-9-4z" />
                  <path d="M3 7v10l9 4 9-4V7" />
                  <path d="M12 11v10" />
                </svg>
              </div>
              <h3>No digital products found</h3>
              <p>Try a different search term or check back later.</p>
            </div>
          )}
        </section>

      </div>
    </main>
  );
}
