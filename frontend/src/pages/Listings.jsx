import React, { useEffect, useState } from 'react';
import api from '../api/client';
import ListingCard from '../components/ListingCard.jsx';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import { Link } from 'react-router-dom';

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
  const [regions, setRegions] = useState([]);

  // "Near me" is a distinct search mode (distance-sorted, via
  // /listings/nearby) rather than another filter field — see the backend
  // route comment for why it's kept separate from the regular search/ad
  // ranking above.
  const [nearMode, setNearMode] = useState(false);
  const [nearStatus, setNearStatus] = useState('');

  useEffect(() => {
    api.get('/listings/meta/regions')
      .then((r) => setRegions(r.data.regions || []))
      .catch(() => {});
  }, []);

  async function fetchListings() {
    setLoading(true);
    setError('');
    setNearMode(false);
    try {
      const { readyAfter, readyBy, ...rest } = filters;
      const params = { ...rest, category };
      // Readiness-window filtering only makes sense for agricultural listings.
      if (agriculture) {
        if (readyAfter) params.readyAfter = readyAfter;
        if (readyBy) params.readyBy = readyBy;
      }
      const r = await api.get('/listings', { params });
      setListings(r.data.listings || []);
    } catch (e) {
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
        } catch (e) {
          setNearStatus('Could not load nearby listings.');
        } finally {
          setLoading(false);
        }
      },
      () => setNearStatus('Could not get your location.'),
      { timeout: 10000 }
    );
  }

  useEffect(() => {
    fetchListings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  return (
    <main className="section">
      <div className="container-wide">
        <div className="page-header">
          <div>
            <span className="eyebrow">{agriculture ? 'AGRICULTURAL MARKETPLACE' : 'PRODUCT MARKETPLACE'}</span>
            <h1>{agriculture ? 'Find produce at the source.' : 'Buy and sell physical products.'}</h1>
            <p>{agriculture ? 'Compare bulk farm listings, quantities, locations and asking prices.' : 'A general marketplace for physical goods. Any member can buy and sell.'}</p>
          </div>
          <Link to={agriculture ? '/create-listing?category=AGRICULTURAL' : '/create-listing?category=PRODUCT'} className="btn btn-primary">+ {agriculture ? 'List produce' : 'List product'}</Link>
        </div>
        <div className="search-panel">
          <div>
            <label>{agriculture ? 'Produce' : 'Product'}</label>
            <input
              value={agriculture ? filters.cropType : filters.title}
              onChange={e => setFilters({ ...filters, [agriculture ? 'cropType' : 'title']: e.target.value })}
              placeholder={agriculture ? 'Potatoes, wheat, barley...' : 'What are you looking for?'}
            />
          </div>
          <div>
            <label>Location</label>
            <input value={filters.location} onChange={e => setFilters({ ...filters, location: e.target.value })} placeholder="Region, town or district" />
          </div>
          <div>
            <label>Region</label>
            <select value={filters.region} onChange={e => setFilters({ ...filters, region: e.target.value })}>
              <option value="">Any region</option>
              {regions.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Minimum quantity</label>
            <input type="number" value={filters.minQuantity} onChange={e => setFilters({ ...filters, minQuantity: e.target.value })} />
          </div>
          <div>
            <label>Min price (ETB)</label>
            <input type="number" min="0" value={filters.minPrice} onChange={e => setFilters({ ...filters, minPrice: e.target.value })} />
          </div>
          <div>
            <label>Max price (ETB)</label>
            <input type="number" min="0" value={filters.maxPrice} onChange={e => setFilters({ ...filters, maxPrice: e.target.value })} />
          </div>
          {agriculture && (
            <>
              <div>
                <label>Ready after</label>
                <input type="date" value={filters.readyAfter} onChange={e => setFilters({ ...filters, readyAfter: e.target.value })} />
              </div>
              <div>
                <label>Ready by</label>
                <input type="date" value={filters.readyBy} onChange={e => setFilters({ ...filters, readyBy: e.target.value })} />
              </div>
            </>
          )}
          <button className="btn btn-primary" onClick={fetchListings}>Search</button>
          <button className="btn btn-light" type="button" onClick={findNearMe}>📍 Near me</button>
        </div>
        {nearStatus && <p className="small muted">{nearStatus}</p>}
        {error && <div className="alert error">{error}</div>}
        <AdvertisementBanner />
        <div className="market-toolbar">
          <strong>{loading ? 'Loading…' : `${listings.length} listing${listings.length === 1 ? '' : 's'}`}</strong>
          <span className="muted">
            {nearMode
              ? 'Sorted by distance from your current location.'
              : agriculture ? 'Independent inspection can support bulk transactions.' : 'Buyers and sellers transact directly through MarketBridge workflows.'}
          </span>
        </div>
        {loading ? (
          <div className="loading">Loading marketplace…</div>
        ) : (
          <div className="listing-grid">
            {listings.map(l => (
              <div key={l.id}>
                <ListingCard listing={l} />
                {nearMode && typeof l.distanceKm === 'number' && (
                  <p className="small muted" style={{ marginTop: -6 }}>{l.distanceKm} km away</p>
                )}
              </div>
            ))}
            {!listings.length && <div className="empty card"><h3>No matching listings</h3><p>Try a broader search{nearMode ? ' or a larger radius' : ''}.</p></div>}
          </div>
        )}
      </div>
    </main>
  );
}
