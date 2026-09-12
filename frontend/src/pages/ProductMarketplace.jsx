import React from 'react';
import { Link } from 'react-router-dom';
import Listings from './Listings.jsx';

export default function ProductMarketplace() {
  return (
    <>
      <div className="container-wide" style={{ paddingTop: 16 }}>
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <strong>Sell your own products</strong>
            <p className="muted" style={{ margin: '4px 0 0' }}>Every registered MarketBridge member can buy and sell physical products.</p>
          </div>
          <Link to="/create-listing?category=PRODUCT" className="btn btn-primary">+ List product</Link>
        </div>
      </div>
      <Listings category="PRODUCT" />
    </>
  );
}
