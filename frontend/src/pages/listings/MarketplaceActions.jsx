import React from 'react';
import { Link } from 'react-router-dom';
import './MarketplaceActions.css';

export default function MarketplaceActions({ category = 'PRODUCT' }) {
  const agriculture = category === 'AGRICULTURAL';

  function browse() {
    document.getElementById('listings-results')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  return (
    <section className="product-marketplace-actions" aria-label="Marketplace actions">
      <div className="product-marketplace-actions__card">
        <div className="product-marketplace-actions__grid">
          <button
            type="button"
            className="product-marketplace-action product-marketplace-action--buy"
            onClick={browse}
          >
            <span className="product-marketplace-action__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg></span>
            <span className="product-marketplace-action__body">
              <strong>Buy</strong>
              <span>
                {agriculture
                  ? 'Browse produce, compare listings, and make an offer.'
                  : 'Browse, compare listings, and make an offer.'}
              </span>
            </span>
          </button>

          <Link
            to={`/create-listing?category=${category}`}
            className="product-marketplace-action product-marketplace-action--sell"
          >
            <span className="product-marketplace-action__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>
            <span className="product-marketplace-action__body">
              <strong>Sell</strong>
              <span>
                {agriculture
                  ? 'List produce and receive competing offers.'
                  : 'List a product and receive competing offers.'}
              </span>
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
