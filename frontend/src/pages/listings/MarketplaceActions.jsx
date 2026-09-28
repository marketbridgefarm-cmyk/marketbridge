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
            <span className="product-marketplace-action__icon" aria-hidden="true">⌕</span>
            <span className="product-marketplace-action__body">
              <strong>Buy</strong>
              <span>
                {agriculture
                  ? 'Browse produce, compare listings, and make an offer.'
                  : 'Browse, compare listings, and make an offer.'}
              </span>
            </span>
            <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
          </button>

          <Link
            to={`/create-listing?category=${category}`}
            className="product-marketplace-action product-marketplace-action--sell"
          >
            <span className="product-marketplace-action__icon" aria-hidden="true">＋</span>
            <span className="product-marketplace-action__body">
              <strong>Sell</strong>
              <span>
                {agriculture
                  ? 'List produce and receive competing offers.'
                  : 'List a product and receive competing offers.'}
              </span>
            </span>
            <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
