import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ListingCard from '../components/ListingCard.jsx';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import MarketplaceActions from './listings/MarketplaceActions.jsx';
import { REGIONS as FALLBACK_REGIONS } from '../utils/ethiopianRegions';
import './listings/Listings.css';

export default function Listings({ category = 'AGRICULTURAL' }) {
  const agriculture = category === 'AGRICULTURAL';

  const [listings, setListings] = useState([]);
  const [filters, setFilters] = useState({
    cropType: '',
    title: '',
    location: '',
    region: '',
    minQuantity: '',
    minPrice: '',
    maxPrice: '',
    readyAfter: '',
    readyBy: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [regions, setRegions] = useState(FALLBACK_REGIONS);
  const [nearMode, setNearMode] = useState(false);
  const [nearStatus, setNearStatus] = useState('');
  const [showMore, setShowMore] = useState(false);

  const debounceRef = useRef(null);

  useEffect(() => {
    api.get('/listings/meta/regions')
      .then((r) => { if (r.data.regions?.length) setRegions(r.data.regions); })
      .catch((err) => console.warn('Could not sync region list from server, using built-in list.', err));
  }, []);

  async function fetchListings(overrideFilters) {
    setLoading(true);
    setError('');
    setNearMode(false);
    try {
      const active = overrideFilters || filters;
      const { readyAfter, readyBy, ...rest } = active;
      const params = { ...rest, category };
      if (agriculture) {
        if (readyAfter) params.readyAfter = readyAfter;
        if (readyBy) params.readyBy = readyBy;
      }
      if (agriculture) {
        const [activeResponse, negotiatingResponse] = await Promise.all([
          api.get('/listings', { params: { ...params, status: 'ACTIVE' } }),
          api.get('/listings', { params: { ...params, status: 'UNDER_NEGOTIATION' } }),
        ]);
        const merged = [
          ...(activeResponse.data.listings || []),
          ...(negotiatingResponse.data.listings || []),
        ];
        const unique = Array.from(new Map(merged.map((item) => [item.id, item])).values());
        setListings(unique);
      } else {
        const r = await api.get('/listings', { params });
        setListings(r.data.listings || []);
      }
    } catch {
      setError('Could not load marketplace listings.');
    } finally {
      setLoading(false);
    }
  }

  function findNearMe() {
    if (!navigator.geolocation) {
      setNearStatus('Geolocation is not available in this browser.');
      return;
    }
    setNearStatus('Locating…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setLoading(true);
        setError('');
        try {
          if (agriculture) {
            const base = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              radiusKm: 100,
              category,
              cropType: filters.cropType || undefined,
            };
            const [activeResponse, negotiatingResponse] = await Promise.all([
              api.get('/listings/nearby', { params: { ...base, status: 'ACTIVE' } }),
              api.get('/listings/nearby', { params: { ...base, status: 'UNDER_NEGOTIATION' } }),
            ]);
            const merged = [
              ...(activeResponse.data.listings || []),
              ...(negotiatingResponse.data.listings || []),
            ];
            const unique = Array.from(new Map(merged.map((item) => [item.id, item])).values());
            unique.sort((a, b) => Number(a.distanceKm || Infinity) - Number(b.distanceKm || Infinity));
            setListings(unique);
          } else {
            const r = await api.get('/listings/nearby', {
              params: {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                radiusKm: 100,
                category,
              },
            });
            setListings(r.data.listings || []);
          }
          setNearMode(true);
          setNearStatus('');
        } catch {
          setNearStatus('Could not load nearby listings.');
        } finally {
          setLoading(false);
        }
      },
      () => setNearStatus('Could not get your location.'),
      { timeout: 10000 },
    );
  }

  function handleQueryChange(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchListings(next), 400);
  }

  function handleFilterChange(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  useEffect(() => {
    fetchListings();
    return () => clearTimeout(debounceRef.current);
  }, [category]);

  const hasActiveFilters =
    filters.location || filters.region || filters.minQuantity ||
    filters.minPrice || filters.maxPrice || filters.readyAfter || filters.readyBy;

  function clearFilters() {
    const cleared = {
      cropType: filters.cropType,
      title: filters.title,
      location: '', region: '', minQuantity: '',
      minPrice: '', maxPrice: '', readyAfter: '', readyBy: '',
    };
    setFilters(cleared);
    fetchListings(cleared);
    setShowMore(false);
  }

  return (
    <main className="section listings-page">
      <div className="container-wide">
        {/* Page header - Matching the new design system */}
        <div className="ls-page-header">
          <div className="ls-toolbar-eyebrow">
            <span className="ls-eyebrow-line" />
            <span>{agriculture ? 'AGRICULTURAL MARKETPLACE' : 'PRODUCT MARKETPLACE'}</span>
          </div>
          <h1>{agriculture ? 'Find produce at the source.' : 'Buy and sell physical products.'}</h1>
          <p className="ls-subtitle">
            {agriculture
              ? 'Compare bulk farm listings and prices.'
              : 'Any member can buy and sell.'}
          </p>
        </div>

        <MarketplaceActions category={category} />

        {/* Filter bar - Clean and floating */}
        <div id="listings-results" className="ls-filter-bar">
          <div className="ls-filter-search">
            <input
              type="search"
              value={agriculture ? filters.cropType : filters.title}
              onChange={(e) =>
                handleQueryChange(agriculture ? 'cropType' : 'title', e.target.value)
              }
              placeholder={agriculture ? 'Search produce — potatoes, wheat, barley…' : 'Search products…'}
              aria-label={agriculture ? 'Search produce' : 'Search products'}
            />
            <button className="ls-btn ls-btn-primary" onClick={() => fetchListings()}>
              Search
            </button>
          </div>

          <div className="ls-filter-scroll" role="group" aria-label="Filters">
            <label className={`ls-filter-chip${filters.location ? ' active' : ''}`} title="Filter by location">
              <svg className="ls-filter-chip-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></svg>
              <input
                type="text"
                value={filters.location}
                onChange={(e) => handleFilterChange('location', e.target.value)}
                placeholder="Location"
                aria-label="Location filter"
                style={{ minWidth: 80, border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '13px' }}
              />
            </label>

            <label className={`ls-filter-chip${filters.region ? ' active' : ''}`} title="Filter by region">
              <select
                value={filters.region}
                onChange={(e) => handleFilterChange('region', e.target.value)}
                aria-label="Region filter"
              >
                <option value="">Any region</option>
                {regions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <span className="ls-filter-chip-caret">▾</span>
            </label>

            <button
              type="button"
              className={`ls-filter-chip${showMore || hasActiveFilters ? ' active' : ''}`}
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
            >
              {showMore ? 'Fewer filters ✕' : 'More filters ⋯'}
            </button>

            <button
              type="button"
              className={`ls-filter-chip${nearMode ? ' active' : ''}`}
              onClick={findNearMe}
            >
              Near me
            </button>

            {hasActiveFilters && (
              <button type="button" className="ls-filter-chip" onClick={clearFilters}>
                Clear ×
              </button>
            )}
          </div>

          {showMore && (
            <div className="ls-filter-more-panel">
              <div className="ls-filter-field">
                <label>Min quantity</label>
                <input
                  type="number"
                  value={filters.minQuantity}
                  onChange={(e) => handleFilterChange('minQuantity', e.target.value)}
                  placeholder="Any"
                />
              </div>
              <div className="ls-filter-field">
                <label>Min price (ETB)</label>
                <input
                  type="number" min="0"
                  value={filters.minPrice}
                  onChange={(e) => handleFilterChange('minPrice', e.target.value)}
                  placeholder="Any"
                />
              </div>
              <div className="ls-filter-field">
                <label>Max price (ETB)</label>
                <input
                  type="number" min="0"
                  value={filters.maxPrice}
                  onChange={(e) => handleFilterChange('maxPrice', e.target.value)}
                  placeholder="Any"
                />
              </div>
              {agriculture && (
                <>
                  <div className="ls-filter-field">
                    <label>Ready after</label>
                    <input
                      type="date"
                      value={filters.readyAfter}
                      onChange={(e) => handleFilterChange('readyAfter', e.target.value)}
                    />
                  </div>
                  <div className="ls-filter-field">
                    <label>Ready by</label>
                    <input
                      type="date"
                      value={filters.readyBy}
                      onChange={(e) => handleFilterChange('readyBy', e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="ls-filter-actions">
                <button className="ls-btn ls-btn-primary" onClick={() => { fetchListings(); setShowMore(false); }}>
                  Apply filters
                </button>
                {hasActiveFilters && (
                  <button className="ls-btn ls-btn-light" onClick={clearFilters}>
                    Clear all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {nearStatus && <p className="ls-muted">{nearStatus}</p>}
        {error && <div className="ls-alert error">{error}</div>}

        <AdvertisementBanner />

        {/* Toolbar - Matching the new design system */}
        <div className="ls-toolbar">
          <div>
            <strong>
              {loading ? 'Loading…' : `${listings.length} listing${listings.length === 1 ? '' : 's'}`}
            </strong>
            <span className="ls-muted">
              {nearMode
                ? 'Sorted by distance'
                : agriculture
                  ? 'Independent inspection supported'
                  : 'Direct buyer and seller deals'}
            </span>
          </div>
        </div>

        {/* Grid - Matching the new design system */}
        {loading ? (
          <div className="ls-loading">Loading marketplace…</div>
        ) : (
          <div className="ls-grid">
            {listings.map((l) => (
              <div key={l.id} className="ls-card-wrapper">
                <ListingCard listing={l} />
                {nearMode && typeof l.distanceKm === 'number' && (
                  <p className="ls-muted ls-distance">{l.distanceKm} km away</p>
                )}
              </div>
            ))}
            {!listings.length && (
              <div className="ls-empty">
                <h3>No matching listings</h3>
                <p>Try a broader search{nearMode ? ' or a larger radius' : ''}.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
