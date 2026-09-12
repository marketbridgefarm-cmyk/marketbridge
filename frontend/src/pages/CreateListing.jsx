import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

export default function CreateListing() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [category, setCategory] = useState('AGRICULTURAL');
  const [form, setForm] = useState({
    sellerId: user?.id || '',
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
  const set = k => e => setForm({ ...form, [k]: e.target.value });

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
    try {
      const r = await api.post('/listings', {
        ...form,
        category,
        sellerId: user.id,
        cropType: category === 'AGRICULTURAL' ? form.cropType : undefined,
        title: form.title || form.cropType,
        quantity: Number(form.quantity),
        askingPrice: Number(form.askingPrice),
        minAcceptablePrice: form.minAcceptablePrice ? Number(form.minAcceptablePrice) : undefined,
        photos: form.photos.map(p => p.key),
        videos: form.videos.map(v => v.key)
      });
      nav(`/listings/${r.data.listing.id}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not create listing');
    }
  }

  return (
    <main className="section">
      <div className="container-narrow">
        <Link to="/" className="back-link">← Home</Link>
        <span className="eyebrow">SELL ON MARKETBRIDGE</span>
        <h1>{category === 'AGRICULTURAL' ? 'List agricultural produce' : 'List a physical product'}</h1>
        <p className="muted">Your account can buy and sell. Agricultural listings keep the farmer as the price authority.</p>
        <form className="card form-card" onSubmit={submit}>
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

          <button className="btn btn-primary btn-lg full" type="submit" disabled={uploading}>Publish {category === 'AGRICULTURAL' ? 'produce' : 'product'}</button>
        </form>
      </div>
    </main>
  );
}
