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
    minQuantity: '',
    minPrice: '',
    maxPrice: '',
    readyAfter: '',
    readyBy: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function fetchListings() {
    setLoading(true);
    setError('');
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

  useEffect(() => {
    fetchListings();
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
        </div>
        {error && <div className="alert error">{error}</div>}
        <AdvertisementBanner />
        <div className="market-toolbar">
          <strong>{loading ? 'Loading…' : `${listings.length} listing${listings.length === 1 ? '' : 's'}`}</strong>
          <span className="muted">{agriculture ? 'Independent inspection can support bulk transactions.' : 'Buyers and sellers transact directly through MarketBridge workflows.'}</span>
        </div>
        {loading ? (
          <div className="loading">Loading marketplace…</div>
        ) : (
          <div className="listing-grid">
            {listings.map(l => <ListingCard key={l.id} listing={l} />)}
            {!listings.length && <div className="empty card"><h3>No matching listings</h3><p>Try a broader search.</p></div>}
          </div>
        )}
      </div>
    </main>
  );
}
