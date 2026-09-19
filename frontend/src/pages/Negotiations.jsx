import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

export default function Negotiations() {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('active');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await api.get('/offers/mine');
        if (alive) setOffers(response.data?.offers || []);
      } catch (err) {
        if (alive) setError(err?.response?.data?.error || 'Could not load negotiations');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => filter === 'all'
    ? offers
    : offers.filter((offer) => ['PENDING', 'COUNTERED'].includes(offer.status)), [offers, filter]);

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>
        <h1>Your negotiations</h1>
        <p className="lead">Discuss price and terms before creating an order.</p>
        <div className="sd-tabs" style={{ margin: '20px 0' }}>
          <button type="button" className={`sd-tab ${filter === 'active' ? 'sd-active' : ''}`} onClick={() => setFilter('active')}>Active</button>
          <button type="button" className={`sd-tab ${filter === 'all' ? 'sd-active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {loading ? <p>Loading negotiations…</p> : visible.length === 0 ? (
          <div className="card notice">No negotiations here yet. Open a listing to make an offer.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {visible.map((offer) => (
              <article className="card" key={offer.id}>
                <div className="row-between">
                  <div>
                    <span className="role-chip">{offer.status || 'PENDING'}</span>
                    <h3>{offer.listing?.title || offer.listing?.cropType || 'Agricultural listing'}</h3>
                    <p>{offer.counterAmount ?? offer.amount} ETB{offer.quantity ? ` · ${offer.quantity} quantity` : ''}</p>
                  </div>
                  {offer.listingId && <Link className="btn btn-primary" to={`/listings/${offer.listingId}`}>Open listing</Link>}
                </div>
                {offer.message && <p>{offer.message}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
