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
          <div className="product-marketplace-actions__grid">
            <button
              type="button"
              className="product-marketplace-action product-marketplace-action--buy"
              onClick={browseProducts}
            >
              <span className="product-marketplace-action__icon" aria-hidden="true">⌕</span>
              <span className="product-marketplace-action__body">
                <strong>Buy here</strong>
                <span>Browse products, compare listings and make an offer.</span>
              </span>
              <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
            </button>

            <Link
              to="/create-listing?category=PRODUCT"
              className="product-marketplace-action product-marketplace-action--sell"
            >
              <span className="product-marketplace-action__icon" aria-hidden="true">＋</span>
              <span className="product-marketplace-action__body">
                <strong>Sell here</strong>
                <span>Publish a product listing and receive competing offers.</span>
              </span>
              <span className="product-marketplace-action__arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      <div id="product-marketplace-listings">
        <Listings category="PRODUCT" />
      </div>
    </>
  );
}
