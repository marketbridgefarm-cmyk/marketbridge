import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

export default function CreateListing() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedCategory = searchParams.get('category')?.toUpperCase();
  const isProductRequest = requestedCategory === 'PRODUCT';

  // Below the tablet breakpoint this page renders as a popup (bottom sheet on
  // phones, centered dialog on tablets) over whatever the user was looking
  // at, rather than a full page — see .listing-modal-* in styles.css. "Close"
  // just means "go back to where I was", so reuse the back navigation.
  const closeModal = useCallback(() => nav('/'), [nav]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeModal]);

  const [category, setCategory] = useState(isProductRequest ? 'PRODUCT' : 'AGRICULTURAL');
  const [form, setForm] = useState({
    sellerId: user?.id || '',
    description: '',
    title: '',
    cropType: '',
    quantity: '',
    unit: 'quintal',
    askingPrice: '',
    minAcceptablePrice: '',
    location: user?.location || '',
    harvestedDate: '',
    readinessDate: '',
    photos: [], // [{ key, name, previewUrl }]
    videos: []  // [{ key, name, previewUrl }]
  });
  const [error, setError] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const set = k => e => setForm(prev => ({ ...prev, [k]: e.target.value }));

  async function handleMediaSelect(kind, e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later
    if (!files.length) return;

    setMediaError('');
    setUploading(true);
    try {
      const body = new FormData();
      files.forEach(f => body.append('files', f));
      const { data } = await api.post('/listings/media', body);
      const keys = kind === 'photo' ? data.photoKeys : data.videoKeys;
      const items = files.map((f, i) => ({
        key: keys[i],
        name: f.name,
        previewUrl: URL.createObjectURL(f)
      })).filter(item => item.key);
      const field = kind === 'photo' ? 'photos' : 'videos';
      setForm(prev => ({ ...prev, [field]: [...prev[field], ...items] }));
    } catch (err) {
      setMediaError(err.response?.data?.error || `Could not upload ${kind === 'photo' ? 'photo' : 'video'}. Try a smaller file.`);
    } finally {
      setUploading(false);
    }
  }

  function removeMedia(kind, index) {
    const field = kind === 'photo' ? 'photos' : 'videos';
    setForm(prev => {
      const removed = prev[field][index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return { ...prev, [field]: prev[field].filter((_, i) => i !== index) };
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');

    if (!user?.id) {
      setError('Your session is not ready. Please log in again.');
      return;
    }

    const title = form.title.trim();
    const location = form.location.trim();
    const quantity = Number(form.quantity);
    const askingPrice = Number(form.askingPrice);

    if (category === 'PRODUCT' && !title) {
      setError('Product title is required.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('Enter a quantity greater than 0.');
      return;
    }
    if (!Number.isFinite(askingPrice) || askingPrice <= 0) {
      setError('Enter an asking price greater than 0 ETB.');
      return;
    }
    if (!location) {
      setError('Location is required.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        category,
        sellerId: user.id,
        title: category === 'PRODUCT' ? title : (title || form.cropType.trim()),
        cropType: category === 'AGRICULTURAL' ? form.cropType.trim() : undefined,
        quantity,
        unit: form.unit.trim() || (category === 'PRODUCT' ? 'piece' : 'quintal'),
        askingPrice,
        minAcceptablePrice: category === 'AGRICULTURAL' && form.minAcceptablePrice ? Number(form.minAcceptablePrice) : undefined,
        location,
        harvestedDate: category === 'AGRICULTURAL' ? form.harvestedDate || undefined : undefined,
        readinessDate: category === 'AGRICULTURAL' ? form.readinessDate || undefined : undefined,
        description: form.description.trim() || undefined,
        photos: form.photos.map(p => p.key),
        videos: form.videos.map(v => v.key)
      };

      const r = await api.post('/listings', payload);
      const listingId = r.data?.listing?.id;
      if (!listingId) throw new Error('The server did not return the new listing ID.');
      nav(`/listings/${listingId}`);
    } catch (e) {
      const data = e.response?.data;
      const validation = Array.isArray(data?.errors)
        ? data.errors.map(x => x.msg || x.message).filter(Boolean).join(' ')
        : '';
      setError(data?.error || validation || e.message || 'Could not create listing.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="listing-modal-overlay" onClick={closeModal}>
      <main className="section listing-modal-panel" onClick={e => e.stopPropagation()}>
        <div className="container-narrow">
          <div className="listing-modal-drag-handle" aria-hidden="true" />
          <div className="listing-modal-header">
            <Link to="/" className="back-link">← Home</Link>
            <button type="button" className="listing-modal-close" aria-label="Close" onClick={closeModal}>×</button>
          </div>
        <span className="eyebrow">SELL ON MARKETBRIDGE</span>
        <h1>{category === 'AGRICULTURAL' ? 'List agricultural produce' : 'List a physical product'}</h1>
        <p className="muted">Your account can buy and sell. Agricultural listings keep the farmer as the price authority.</p>
        <form className="card form-card" onSubmit={submit} noValidate>
          {error && <div className="alert error">{error}</div>}
          <label>Marketplace</label>
          <div className="choice-grid">
            <button type="button" className={`choice ${category === 'AGRICULTURAL' ? 'selected' : ''}`} onClick={() => setCategory('AGRICULTURAL')}>
              <b>Agricultural</b><span>Bulk produce, farm lots, inspection and transport workflows.</span>
            </button>
            <button type="button" className={`choice ${category === 'PRODUCT' ? 'selected' : ''}`} onClick={() => setCategory('PRODUCT')}>
              <b>Product</b><span>General physical goods sold by MarketBridge members.</span>
            </button>
          </div>

          {category === 'AGRICULTURAL' ? (
            <div className="form-grid">
              <div><label>Produce</label><input required value={form.cropType} onChange={set('cropType')} placeholder="Potatoes, wheat, barley..." /></div>
              <div><label>Quantity</label><input required type="number" min="0.01" value={form.quantity} onChange={set('quantity')} /></div>
              <div><label>Unit</label><select value={form.unit} onChange={set('unit')}><option>quintal</option><option>ton</option><option>kg</option><option>crate</option><option>bag</option></select></div>
            </div>
          ) : (
            <div className="form-grid">
              <div><label>Product title</label><input required value={form.title} onChange={set('title')} placeholder="Product name" /></div>
              <div><label>Quantity</label><input required type="number" min="0.01" value={form.quantity} onChange={set('quantity')} /></div>
              <div><label>Unit</label><input value={form.unit} onChange={set('unit')} placeholder="piece, box, kg..." /></div>
            </div>
          )}

          <div className="form-grid">
            <div><label>Asking price (ETB)</label><input required type="number" min="0.01" value={form.askingPrice} onChange={set('askingPrice')} /></div>
            {category === 'AGRICULTURAL' && <div><label>Minimum acceptable price</label><input type="number" min="0" value={form.minAcceptablePrice} onChange={set('minAcceptablePrice')} /></div>}
            <div><label>Location</label><input required value={form.location} onChange={set('location')} /></div>
            {category === 'AGRICULTURAL' && (
              <>
                <div><label>Harvest date</label><input type="date" value={form.harvestedDate} onChange={set('harvestedDate')} /></div>
                <div><label>Ready / pickup date</label><input type="date" value={form.readinessDate} onChange={set('readinessDate')} /></div>
              </>
            )}
          </div>

          <div>
            <label>Description</label>
            <textarea
              value={form.description}
              onChange={set('description')}
              placeholder={category === 'PRODUCT' ? 'Describe the product, condition, features, brand, size, etc.' : 'Describe the produce, quality and other useful details.'}
              rows={4}
            />
          </div>

          {mediaError && <div className="alert error">{mediaError}</div>}

          <label>Photos</label>
          <input type="file" accept="image/*" multiple onChange={e => handleMediaSelect('photo', e)} disabled={uploading} />
          {form.photos.length > 0 && (
            <div className="media-preview-grid">
              {form.photos.map((p, i) => (
                <div className="media-preview-item" key={p.key}>
                  <img src={p.previewUrl} alt={p.name} />
                  <button type="button" className="media-preview-remove" onClick={() => removeMedia('photo', i)} aria-label={`Remove ${p.name}`}>×</button>
                </div>
              ))}
            </div>
          )}

          <label>Short videos</label>
          <input type="file" accept="video/*" multiple onChange={e => handleMediaSelect('video', e)} disabled={uploading} />
          {form.videos.length > 0 && (
            <div className="media-preview-grid">
              {form.videos.map((v, i) => (
                <div className="media-preview-item" key={v.key}>
                  <video src={v.previewUrl} muted />
                  <button type="button" className="media-preview-remove" onClick={() => removeMedia('video', i)} aria-label={`Remove ${v.name}`}>×</button>
                </div>
              ))}
            </div>
          )}

          {uploading && <p className="muted">Uploading media…</p>}
          {submitting && <p className="muted">Creating your product listing…</p>}

          <button className="btn btn-primary btn-lg full" type="submit" disabled={uploading || submitting}>Publish {category === 'AGRICULTURAL' ? 'produce' : 'product'}</button>
        </form>
        </div>
      </main>
    </div>
  );
}
