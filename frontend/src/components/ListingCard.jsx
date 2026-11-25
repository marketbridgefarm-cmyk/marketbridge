import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Avatar from './Avatar.jsx';
import RatingStars from './RatingStars.jsx';
import './ListingCardGlass.css';

// Derive an ECX-style grade label from the most-recent inspection report.
function gradeFromListing(listing) {
  const reports = (listing.inspectionRequests || [])
    .filter((r) => r.report)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reports[0]?.report?.grade || null;
}

// Harvest date comes from the listing's `harvestedDate` field (see Prisma schema).
function formatHarvestDate(listing) {
  const raw = listing.harvestedDate;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const OPEN = ['ACTIVE', 'UNDER_NEGOTIATION'];

const Icon = {
  pin: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="3" />
    </svg>
  ),
  arrow: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  view: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  ),
  star: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 16.8 6.1 20.1l1.3-6.6L2.5 8.9l6.6-.8L12 2z" /></svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  ),
  crown: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" /></svg>
  ),
  leaf: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19c2-4 5-7 9-9" /></svg>
  ),
  bag: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2" /></svg>
  ),
};

export default function ListingCard({ listing }) {
  const isProduct = listing.category === 'PRODUCT';
  const title = listing.title || listing.cropType || 'Listing';
  const cardRef = useRef(null);
  const recorded = useRef(false);
  const grade = gradeFromListing(listing);
  const harvestDate = isProduct ? null : formatHarvestDate(listing);
  const isVerifiedSeller = listing.seller?.verificationStatus === 'VERIFIED';
  const isOpen = OPEN.includes(listing.status);
  const offers = isProduct || !isOpen ? 0 : Number(listing.offerCount || listing._count?.offers || 0);
  const rating = Number(listing.seller?.rating) > 0 ? Number(listing.seller.rating) : null;
  const categoryLabel = isProduct ? 'Product' : listing.cropType || 'Produce';

  // One badge top-left, in order of how much it tells the buyer.
  let badge;
  if (listing.sponsored) badge = { label: 'Sponsored', tone: 'gold', icon: Icon.crown };
  else if (grade) badge = { label: `Grade ${grade}`, tone: 'green', icon: Icon.star, title: 'ECX inspection grade' };
  else if (isVerifiedSeller) badge = { label: 'Verified seller', tone: 'green', icon: Icon.check };
  else badge = { label: categoryLabel, tone: 'plain', icon: isProduct ? Icon.bag : Icon.leaf };

  // Sponsored impression tracking via IntersectionObserver.
  useEffect(() => {
    if (!listing.sponsoredAdId || !cardRef.current || recorded.current) return undefined;
    const node = cardRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !recorded.current) {
          recorded.current = true;
          api.post(`/ads/${listing.sponsoredAdId}/events`, { eventType: 'IMPRESSION' }).catch(() => undefined);
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [listing.sponsoredAdId]);

  return (
    <article ref={cardRef} className={`gc${listing.sponsored ? ' gc--sponsored' : ''}`}>
      {/* Photo / preview */}
      <Link className="gc-media" to={`/listings/${listing.id}`} tabIndex={-1} aria-hidden="true">
        {listing.photos?.[0] ? (
          <img src={listing.photos[0]} alt={title} loading="lazy" decoding="async" />
        ) : listing.videos?.[0] ? (
          <video src={listing.videos[0]} muted />
        ) : (
          <span className="gc-initials">{title.slice(0, 2).toUpperCase()}</span>
        )}
        <span className={`gc-badge gc-badge--${badge.tone}`} title={badge.title}>
          {badge.icon}
          {badge.label}
        </span>
        {offers > 0 && (
          <span className="gc-orb" title={`${offers} buyer offer${offers === 1 ? '' : 's'} · still open to competing buyers`}>
            <b>{offers.toLocaleString()}</b>
            <i>{offers === 1 ? 'offer' : 'offers'}</i>
          </span>
        )}
      </Link>

      <div className="gc-body">
        <div className="gc-tags">
          {badge.tone !== 'plain' && <span className="gc-tag">{categoryLabel}</span>}
          {!isProduct && <span className="gc-tag gc-tag--neg">Negotiable</span>}
          {isOpen && <span className="gc-tag gc-tag--live"><i aria-hidden="true" />Available</span>}
        </div>

        <h3 className="gc-title">
          <Link to={`/listings/${listing.id}`}>{title}</Link>
        </h3>

        <p className="gc-loc">{Icon.pin}<span>{listing.location}</span></p>

        <div className="gc-seller">
          <Avatar name={listing.seller?.name || 'Seller'} src={listing.seller?.avatarUrl} size="xs" verified={isVerifiedSeller} />
          <span className="gc-seller-name">{listing.seller?.name || 'Seller'}</span>
          {rating && (
            <span className="gc-rating" title={`Seller rating ${rating.toFixed(1)} out of 5`}>
              <RatingStars value={rating} size={13} />
              <b>{rating.toFixed(1)}</b>
            </span>
          )}
        </div>

        <div className="gc-price">
          <span className="gc-amount">{Number(listing.askingPrice).toLocaleString()}</span>
          <span className="gc-cur">ETB</span>
          {listing.unit && <span className="gc-unit">/ {listing.unit}</span>}
        </div>

        <ul className="gc-facts">
          <li><span>Quantity</span><strong>{Number(listing.quantity).toLocaleString()} {listing.unit}</strong></li>
          {!isProduct && <li><span>Harvest date</span><strong>{harvestDate || '—'}</strong></li>}
        </ul>

        <div className="gc-actions">
          {isOpen ? (
            <>
              <Link className="gc-cta" to={`/listings/${listing.id}#make-offer`}>
                <span>Make offer</span>
                {Icon.arrow}
              </Link>
              <Link className="gc-view" to={`/listings/${listing.id}`} aria-label={`View ${title}`}>
                {Icon.view}
              </Link>
            </>
          ) : (
            <Link className="gc-cta" to={`/listings/${listing.id}`}>
              <span>View listing</span>
              {Icon.arrow}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
