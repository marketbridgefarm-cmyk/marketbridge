import React from 'react';
import Avatar, { VerifiedTick } from './Avatar.jsx';
import RatingStars from './RatingStars.jsx';
import './SellerProfileCard.css';

// Glass profile card for the seller on a listing: large avatar, name with verified tick, location,
// stars, then up to three headline numbers. Only facts the API actually returned are shown.
const STATUS_LABEL = { VERIFIED: 'Verified seller', PENDING: 'Verification pending', REJECTED: 'Not verified', UNVERIFIED: 'Not verified' };

export default function SellerProfileCard({ seller }) {
  if (!seller) return null;
  const verified = seller.verificationStatus === 'VERIFIED';
  const rating = seller.rating != null && Number(seller.rating) > 0 ? Number(seller.rating) : null;
  const status = seller.verificationStatus
    ? STATUS_LABEL[seller.verificationStatus] || String(seller.verificationStatus).replace(/_/g, ' ').toLowerCase()
    : null;

  const stats = [];
  if (seller.listingCount != null) stats.push({ label: 'Listings', value: Number(seller.listingCount).toLocaleString() });
  if (seller.createdAt) {
    stats.push({ label: 'Member since', value: new Date(seller.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) });
  }

  return (
    <section className="sp" aria-label="Seller profile">
      <div className="sp-top">
        <span className="sp-pill">Seller</span>
        {status && <span className={`sp-status${verified ? ' is-ok' : ''}`}>{status}</span>}
      </div>

      <div className="sp-hero">
        <Avatar name={seller.name || 'Seller'} src={seller.avatarUrl} size="lg" />
        <h3 className="sp-name">
          <span>{seller.name || 'Seller'}</span>
          {verified && <VerifiedTick size={20} />}
        </h3>
        {seller.location && <p className="sp-loc">{seller.location}</p>}
        {rating && (
          <p className="sp-rating"><RatingStars value={rating} size={16} /><b>{rating.toFixed(1)}</b></p>
        )}
      </div>

      {stats.length > 0 && (
        <dl className="sp-stats">
          {stats.map((s) => (
            <div key={s.label} className="sp-stat"><dd>{s.value}</dd><dt>{s.label}</dt></div>
          ))}
        </dl>
      )}

      {seller.phone && (
        <p className="sp-phone"><span>Phone</span><strong>{seller.phone}</strong></p>
      )}
    </section>
  );
}
