import React from 'react';
import { Link } from 'react-router-dom';

export default function ListingCard({ listing }) {
  const isProduct = listing.category === 'PRODUCT';
  const title = listing.title || listing.cropType || 'Listing';
  return <article className={`listing-card${listing.sponsored ? ' listing-card--sponsored' : ''}`}>
    <div className="listing-photo">
      {listing.sponsored && <span className="tag tag--sponsored">Sponsored</span>}
      {listing.photos?.[0]
        ? <img src={listing.photos[0]} alt={title}/>
        : listing.videos?.[0]
          ? <video src={listing.videos[0]} muted />
          : <span>{title.slice(0,2).toUpperCase()}</span>}
    </div>
    <div className="listing-body">
      <div className="listing-meta"><span className="tag">{isProduct ? 'PRODUCT' : 'AGRICULTURE'}</span><span>{listing.status}</span></div>
      <h3>{title}</h3>
      <p className="listing-location">⌖ {listing.location}</p>
      <div className="listing-stats"><div><span>Quantity</span><strong>{Number(listing.quantity).toLocaleString()} {listing.unit}</strong></div><div><span>Asking</span><strong>{Number(listing.askingPrice).toLocaleString()} ETB</strong></div></div>
      <div className="listing-footer"><span>Seller: {listing.seller?.name || 'Seller'} {listing.seller?.rating ? `· ★ ${listing.seller.rating.toFixed(1)}` : ''}</span><Link className="text-link" to={`/listings/${listing.id}`}>View listing →</Link></div>
    </div>
  </article>;
}
