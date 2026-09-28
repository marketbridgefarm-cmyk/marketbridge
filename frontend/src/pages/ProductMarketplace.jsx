import React from 'react';
import { Link } from 'react-router-dom';
import Listings from './Listings.jsx';
import './product-marketplace/ProductMarketplace.css';

export default function ProductMarketplace() {
  function browseProducts() {
    document.getElementById('product-marketplace-listings')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  return (
    <>
      <section className="product-marketplace-actions" aria-label="Product marketplace actions">
        <div className="container-wide">
          <div className="product-marketplace-actions__card">
          <div className="product-marketplace-actions__grid">
            <button
              type="button"
              className="product-marketplace-action product-marketplace-action--buy"
              onClick={browseProducts}
            >
              <span className="product-marketplace-action__icon" aria-hidden="true">⌕</span>
              <span className="product-marketplace-action__body">
                <strong>Buy</strong>
                <span>Browse, compare listings, and make an offer.</span>
              </span>
              <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
            </button>

            <Link
              to="/create-listing?category=PRODUCT"
              className="product-marketplace-action product-marketplace-action--sell"
            >
              <span className="product-marketplace-action__icon" aria-hidden="true">＋</span>
              <span className="product-marketplace-action__body">
                <strong>Sell</strong>
                <span>List a product and receive competing offers.</span>
              </span>
              <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
            </Link>
          </div>
          </div>
        </div>
      </section>

      <div id="product-marketplace-listings">
        <Listings category="PRODUCT" />
      </div>
    </>
  );
}
