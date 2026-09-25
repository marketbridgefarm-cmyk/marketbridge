import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ListingCard from '../components/ListingCard.jsx';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import { Link } from 'react-router-dom';
import { REGIONS as FALLBACK_REGIONS } from '../utils/ethiopianRegions';

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
  // "More filters" panel toggle
  const [showMore, setShowMore] = useState(false);

  // Debounce ref for the main search input
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
      const r = await api.get('/listings', { params });
      setListings(r.data.listings || []);
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
          const r = await api.get('/listings/nearby', {
            params: {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              radiusKm: 100,
              category,
              cropType: agriculture ? filters.cropType || undefined : undefined,
            },
          });
          setListings(r.data.listings || []);
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

  // Debounced search: fires 400 ms after the last main-query keystroke.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <main className="section">
      <div className="container-wide">
        {/* Page header */}
        <div className="page-header">
          <div>
            <span className="eyebrow">
              {agriculture ? 'AGRICULTURAL MARKETPLACE' : 'PRODUCT MARKETPLACE'}
            </span>
            <h1>{agriculture ? 'Find produce at the source.' : 'Buy and sell physical products.'}</h1>
            <p>
              {agriculture
                ? 'Compare bulk farm listings, quantities, locations and asking prices.'
                : 'A general marketplace for physical goods. Any member can buy and sell.'}
            </p>
          </div>
          <Link
            to={agriculture ? '/create-listing?category=AGRICULTURAL' : '/create-listing?category=PRODUCT'}
            className="btn btn-primary"
          >
            + {agriculture ? 'List produce' : 'List product'}
          </Link>
        </div>

        {/* ---- Filter bar ---- */}
        <div className="filter-bar-wrap">
          {/* Main search with debounce */}
          <div className="filter-bar-search">
            <input
              type="search"
              value={agriculture ? filters.cropType : filters.title}
              onChange={(e) =>
                handleQueryChange(agriculture ? 'cropType' : 'title', e.target.value)
              }
              placeholder={agriculture ? 'Search produce — potatoes, wheat, barley…' : 'Search products…'}
              aria-label={agriculture ? 'Search produce' : 'Search products'}
            />
            <button className="btn btn-primary" style={{ height: 44, whiteSpace: 'nowrap' }} onClick={() => fetchListings()}>
              Search
            </button>
          </div>

          {/* Scrollable filter chips */}
          <div className="filter-bar-scroll" role="group" aria-label="Filters">
            {/* Location chip */}
            <label
              className={`filter-chip${filters.location ? ' active' : ''}`}
              title="Filter by location"
            >
              📍
              <input
                type="text"
                value={filters.location}
                onChange={(e) => handleFilterChange('location', e.target.value)}
                placeholder="Location"
                aria-label="Location filter"
                style={{ minWidth: 80 }}
              />
            </label>

            {/* Region chip */}
            <label
              className={`filter-chip${filters.region ? ' active' : ''}`}
              title="Filter by region"
            >
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
              <span className="filter-chip-caret">▾</span>
            </label>

            {/* More filters chip */}
            <button
              type="button"
              className={`filter-chip${showMore || hasActiveFilters ? ' active' : ''}`}
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
            >
              {showMore ? 'Fewer filters ✕' : 'More filters ⋯'}
            </button>

            {/* Near me chip */}
            <button
              type="button"
              className={`filter-chip${nearMode ? ' active' : ''}`}
              onClick={findNearMe}
            >
              Near me
            </button>

            {/* Clear chip (only visible when advanced filters are active) */}
            {hasActiveFilters && (
              <button type="button" className="filter-chip" onClick={clearFilters}>
                Clear ×
              </button>
            )}
          </div>

          {/* Expanded advanced filters */}
          {showMore && (
            <div className="filter-more-panel">
              <div>
                <label>Min quantity</label>
                <input
                  type="number"
                  value={filters.minQuantity}
                  onChange={(e) => handleFilterChange('minQuantity', e.target.value)}
                  placeholder="Any"
                />
              </div>
              <div>
                <label>Min price (ETB)</label>
                <input
                  type="number" min="0"
                  value={filters.minPrice}
                  onChange={(e) => handleFilterChange('minPrice', e.target.value)}
                  placeholder="Any"
                />
              </div>
              <div>
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
                  <div>
                    <label>Ready after</label>
                    <input
                      type="date"
                      value={filters.readyAfter}
                      onChange={(e) => handleFilterChange('readyAfter', e.target.value)}
                    />
                  </div>
                  <div>
                    <label>Ready by</label>
                    <input
                      type="date"
                      value={filters.readyBy}
                      onChange={(e) => handleFilterChange('readyBy', e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="filter-actions" style={{ gridColumn: '1 / -1' }}>
                <button className="btn btn-primary" onClick={() => { fetchListings(); setShowMore(false); }}>
                  Apply filters
                </button>
                {hasActiveFilters && (
                  <button className="btn btn-light" onClick={clearFilters}>
                    Clear all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {/* ---- /Filter bar ---- */}

        {nearStatus && <p className="small muted">{nearStatus}</p>}
        {error && <div className="alert error">{error}</div>}

        <AdvertisementBanner />

        {/* Toolbar: result count + context */}
        <div className="market-toolbar--stitch">
          <strong>
            {loading ? 'Loading…' : `${listings.length} listing${listings.length === 1 ? '' : 's'}`}
          </strong>
          <span className="muted">
            {nearMode
              ? 'Sorted by distance from your current location.'
              : agriculture
                ? 'Independent inspection can support bulk transactions.'
                : 'Buyers and sellers transact directly through MarketBridge workflows.'}
          </span>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="loading">Loading marketplace…</div>
        ) : (
          <div className="listing-grid">
            {listings.map((l) => (
              <div key={l.id}>
                <ListingCard listing={l} />
                {nearMode && typeof l.distanceKm === 'number' && (
                  <p className="small muted" style={{ marginTop: -6 }}>{l.distanceKm} km away</p>
                )}
              </div>
            ))}
            {!listings.length && (
              <div className="empty card">
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
