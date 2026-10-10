import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { REGIONS as FALLBACK_REGIONS } from '../utils/ethiopianRegions';
import './create-listing/CreateListing.css';

export default function CreateListing() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedCategory = searchParams.get('category');
  // The market is fixed by the link the user came from. There is no switching
  // inside the form, so a farmer can't end up in the wrong marketplace.
  const category =
    requestedCategory === 'PRODUCT' || requestedCategory === 'AGRICULTURAL'
      ? requestedCategory
      : null;

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

  const [form, setForm] = useState({
    sellerId: user?.id || '',
    title: '',
    cropType: '',
    quantity: '',
    unit: 'quintal',
    askingPrice: '',
    minAcceptablePrice: '',
    location: user?.location || '',
    region: user?.region || '',
    zone: '',
    woreda: '',
    kebele: '',
    latitude: '',
    longitude: '',
    harvestedDate: '',
    readinessDate: '',
    // ── Pickup window (required for AGRICULTURAL) ──────────────────────
    // The pickup window is the only natural deadline for offer negotiation
    // and the inspection lifecycle on agricultural listings. The backend
    // rejects any AGRICULTURAL listing without both fields.
    pickupWindowStart: '',
    pickupWindowEnd: '',
    photos: [], // [{ key, name, previewUrl }]
    videos: [],  // [{ key, name, previewUrl }]
    description: '',
    inspectionRequired: false
  });
  const [error, setError] = useState('');
  const [mediaError, setMediaError] = useState('');
  // Seed with the static list so the dropdown is never empty, then sync
  // with the backend in the background — if that call fails, we keep
  // showing the fallback instead of silently emptying the dropdown.
  const [regions, setRegions] = useState(FALLBACK_REGIONS);
  const [geoStatus, setGeoStatus] = useState('');

  useEffect(() => {
    api.get('/listings/meta/regions')
      .then((r) => {
        if (r.data.regions?.length) setRegions(r.data.regions);
      })
      .catch((err) => {
        console.warn('Could not sync region list from server, using built-in list.', err);
      });
  }, []);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoStatus('Geolocation is not available in this browser.');
      return;
    }
    setGeoStatus('Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          latitude: String(pos.coords.latitude),
          longitude: String(pos.coords.longitude),
        }));
        setGeoStatus('Location captured.');
      },
      () => setGeoStatus('Could not get your location. You can skip this — it just helps buyers find nearby produce.'),
      { timeout: 10000 }
    );
  }
  const [uploading, setUploading] = useState(false);
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

    // Client-side pre-check: the backend will also reject, but this avoids
    // a round-trip and gives a clearer message before submit.
    if (category === 'AGRICULTURAL' && (!form.pickupWindowStart || !form.pickupWindowEnd)) {
      setError('Agricultural listings require both the pickup window start and end.');
      return;
    }

    try {
      const r = await api.post('/listings', {
        category,
        ...(category === 'AGRICULTURAL' ? { sellerId: user.id } : {}),
        title: form.title || form.cropType,
        cropType: category === 'AGRICULTURAL' ? form.cropType : undefined,
        quantity: Number(form.quantity),
        unit: form.unit,
        askingPrice: Number(form.askingPrice),
        minAcceptablePrice: form.minAcceptablePrice ? Number(form.minAcceptablePrice) : undefined,
        location: form.location,
        region: form.region || undefined,
        zone: form.zone || undefined,
        woreda: form.woreda || undefined,
        kebele: form.kebele || undefined,
        latitude: form.latitude !== '' ? Number(form.latitude) : undefined,
        longitude: form.longitude !== '' ? Number(form.longitude) : undefined,
        harvestedDate: category === 'AGRICULTURAL' && form.harvestedDate ? form.harvestedDate : undefined,
        readinessDate: category === 'AGRICULTURAL' && form.readinessDate ? form.readinessDate : undefined,
        // Pickup window is required for AGRICULTURAL and rejected for PRODUCT.
        pickupWindowStart: category === 'AGRICULTURAL' && form.pickupWindowStart ? form.pickupWindowStart : undefined,
        pickupWindowEnd: category === 'AGRICULTURAL' && form.pickupWindowEnd ? form.pickupWindowEnd : undefined,
        description: form.description || undefined,
        photos: form.photos.map(p => p.key),
        videos: form.videos.map(v => v.key),
        ...(category === 'PRODUCT' ? { inspectionRequired: Boolean(form.inspectionRequired) } : {})
      });
      nav(`/listings/${r.data.listing.id}`);
    } catch (e) {
      const data = e.response?.data;
      const detail = data?.errors?.length
        ? data.errors.map(er => er.msg).join(' ')
        : data?.error;
      setError(detail || 'Could not create listing');
    }
  }

  if (!category) {
    return (
      <div className="listing-modal-overlay" onClick={closeModal}>
        <main className="section listing-modal-panel" onClick={e => e.stopPropagation()}>
          <div className="container-narrow">
            <div className="listing-modal-drag-handle" aria-hidden="true" />
            <div className="listing-modal-header">
              <Link to="/" className="back-link">← Home</Link>
              <button type="button" className="listing-modal-close" aria-label="Close" onClick={closeModal}>×</button>
            </div>
            <h1>What do you want to sell?</h1>
            <div className="choice-grid">
              <Link to="/create-listing?category=AGRICULTURAL" className="choice" style={{ textDecoration: 'none' }}>
                <b>Farm produce</b><span>Crops and bulk produce from the farm.</span>
              </Link>
              <Link to="/create-listing?category=PRODUCT" className="choice" style={{ textDecoration: 'none' }}>
                <b>Other products</b><span>Goods such as tools, household items and more.</span>
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
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
        <span className="eyebrow">{category === 'AGRICULTURAL' ? 'AGRICULTURAL MARKETPLACE' : 'PRODUCT MARKETPLACE'}</span>
        <h1>{category === 'AGRICULTURAL' ? 'List agricultural produce' : 'List a physical product'}</h1>
        <p className="muted">
          {category === 'AGRICULTURAL'
            ? 'You set the price. Buyers make offers.'
            : 'Your account can buy and sell.'}
        </p>
        <form className="card form-card" onSubmit={submit}>
          {error && <div className="alert error">{error}</div>}
          <div className="cl-section">
            <p className="cl-section-title">{category === 'AGRICULTURAL' ? 'Produce details' : 'Product details'}</p>
            {category === 'AGRICULTURAL' ? (
              <div className="form-grid">
                <div><label>Produce</label><input required value={form.cropType} onChange={set('cropType')} placeholder="Potatoes, wheat, barley..." /></div>
                <div><label>Quantity</label><input required type="number" min="0.01" value={form.quantity} onChange={set('quantity')} /></div>
                <div><label>Unit</label><select value={form.unit} onChange={set('unit')}><option>quintal</option><option>ton</option><option>kg</option><option>crate</option><option value="bag">bag</option></select></div>
              </div>
            ) : (
              <div className="form-grid">
                <div><label>Product title</label><input required value={form.title} onChange={set('title')} placeholder="Product name" /></div>
                <div><label>Quantity</label><input required type="number" min="0.01" value={form.quantity} onChange={set('quantity')} /></div>
                <div><label>Unit</label><input value={form.unit} onChange={set('unit')} placeholder="piece, box, kg..." /></div>
                <label className="checkbox-row" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={form.inspectionRequired} onChange={(e) => setForm((prev) => ({ ...prev, inspectionRequired: e.target.checked }))} />
                  <span><strong>Require independent inspection</strong><small className="muted" style={{ display: 'block' }}>Buyers must review an inspection report before paying for this product.</small></span>
                </label>
              </div>
            )}
          </div>

          <div className="cl-section">
            <p className="cl-section-title">Pricing &amp; location</p>
            <div className="form-grid">
            <div><label>Asking price (ETB)</label><input required type="number" min="0.01" value={form.askingPrice} onChange={set('askingPrice')} /></div>
            {category === 'AGRICULTURAL' && <div><label>Minimum acceptable price</label><input type="number" min="0" value={form.minAcceptablePrice} onChange={set('minAcceptablePrice')} /></div>}
            <div><label>Location</label><input required value={form.location} onChange={set('location')} placeholder="e.g. Bahir Dar, near the grain market" /></div>
            <div>
              <label>Region</label>
              <select value={form.region} onChange={set('region')}>
                <option value="">Select a region (optional)</option>
                {regions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div><label>Zone</label><input value={form.zone} onChange={set('zone')} placeholder="Optional" /></div>
            <div><label>Woreda</label><input value={form.woreda} onChange={set('woreda')} placeholder="Optional" /></div>
            <div>
              <label>Precise location (optional)</label>
              <button type="button" className="btn btn-light" onClick={useMyLocation}>Use my current location</button>
              {geoStatus && <p className="small muted">{geoStatus}</p>}
              {form.latitude && form.longitude && (
                <p className="small muted">Captured: {Number(form.latitude).toFixed(4)}, {Number(form.longitude).toFixed(4)}</p>
              )}
            </div>
            {category === 'AGRICULTURAL' && (
              <>
                <div><label>Harvest date</label><input type="date" value={form.harvestedDate} onChange={set('harvestedDate')} /></div>
                <div><label>Ready / pickup date</label><input type="date" value={form.readinessDate} onChange={set('readinessDate')} /></div>

                {/* ── Pickup window (required) ─────────────────────────────────
                    Offers on this listing stay open only until the pickup
                    window closes. The end must be a future date-time; the
                    backend enforces both fields and this order. */}
                <div>
                  <label>Pickup window starts</label>
                  <input
                    required
                    type="datetime-local"
                    value={form.pickupWindowStart}
                    onChange={set('pickupWindowStart')}
                  />
                </div>
                <div>
                  <label>Pickup window ends</label>
                  <input
                    required
                    type="datetime-local"
                    value={form.pickupWindowEnd}
                    onChange={set('pickupWindowEnd')}
                  />
                  <small className="muted" style={{ display: 'block' }}>
                    Buyers can bid until this moment. Offers expire when it passes.
                  </small>
                </div>
              </>
            )}
          </div>

          </div>{/* /cl-section pricing+location */}

          <div className="cl-section">
            <p className="cl-section-title">Description</p>
            <div>
            <label>Description</label>
            <textarea
              value={form.description}
              onChange={set('description')}
              placeholder={category === 'AGRICULTURAL' ? 'Describe the produce, quality and selling conditions...' : 'Describe the product, condition, specifications and what is included...'}
              rows={4}
            />
          </div>

          </div>{/* /cl-section description */}
          {mediaError && <div className="alert error">{mediaError}</div>}

          <div className="cl-section">
            <p className="cl-section-title">Photos &amp; videos</p>
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
          </div>{/* /cl-section media */}

          <button className="btn btn-primary btn-lg full" type="submit" disabled={uploading}>Publish {category === 'AGRICULTURAL' ? 'produce' : 'product'}</button>
        </form>
        </div>
      </main>
    </div>
  );
}
