import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

// Derive an ECX-style grade label from the most-recent inspection report.
function gradeFromListing(listing) {
  const reports = (listing.inspectionRequests || [])
    .filter((r) => r.report)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reports[0]?.report?.grade || null;
}

export default function ListingCard({ listing }) {
  const isProduct = listing.category === 'PRODUCT';
  const title = listing.title || listing.cropType || 'Listing';
  const cardRef = useRef(null);
  const recorded = useRef(false);
  const grade = gradeFromListing(listing);
  const isVerifiedSeller = listing.seller?.verificationStatus === 'VERIFIED';

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
    <article ref={cardRef} className={`lc${listing.sponsored ? ' lc--sponsored' : ''}`}>
      {/* Photo / preview area */}
      <Link className="lc-photo" to={`/listings/${listing.id}`} tabIndex={-1} aria-hidden="true">
        {listing.photos?.[0] ? (
          <img src={listing.photos[0]} alt={title} loading="lazy" decoding="async" />
        ) : listing.videos?.[0] ? (
          <video src={listing.videos[0]} muted />
        ) : (
          <span className="lc-photo-initials">{title.slice(0, 2).toUpperCase()}</span>
        )}

        {listing.sponsored && (
          <span className="lc-badge lc-badge--sponsored">Sponsored</span>
        )}
        {/* ECX grade badge — only rendered when an inspection report supplies one */}
        {grade && (
          <span className="lc-badge lc-badge--grade" title="ECX inspection grade">
            {grade}
          </span>
        )}
        {listing.status === 'ACTIVE' && (
          <span className="lc-badge lc-badge--active" aria-label="Active listing" />
        )}
      </Link>

      {/* Card body */}
      <div className="lc-body">
        <div className="lc-tags">
          <span className="lc-tag">{isProduct ? 'Product' : listing.cropType || 'Produce'}</span>
          {!isProduct && <span className="lc-tag lc-tag--neg">Negotiable</span>}
          {isVerifiedSeller && <span className="lc-tag lc-tag--verified">✓ Verified</span>}
        </div>

        <h3 className="lc-title">
          <Link to={`/listings/${listing.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
            {title}
          </Link>
        </h3>

        <p className="lc-location">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          {listing.location}
        </p>

        {!isProduct && listing.status === 'ACTIVE' && Number(listing.offerCount || listing._count?.offers || 0) > 0 && (
          <p className="lc-offer-count" aria-label="Buyer offers">
            {Number(listing.offerCount || listing._count?.offers || 0).toLocaleString()} buyer offer{Number(listing.offerCount || listing._count?.offers || 0) === 1 ? '' : 's'} · still open to competing buyers
          </p>
        )}

        <div className="lc-stats">
          <div>
            <span>Quantity</span>
            <strong>{Number(listing.quantity).toLocaleString()} {listing.unit}</strong>
          </div>
          <div>
            <span>Asking price</span>
            <strong>{Number(listing.askingPrice).toLocaleString()} ETB</strong>
          </div>
        </div>

        <div className="lc-footer">
          <span className="lc-seller">
            {listing.seller?.name || 'Seller'}
            {listing.seller?.rating ? ` · ★ ${listing.seller.rating.toFixed(1)}` : ''}
          </span>

          <div className="lc-ctas">
            {/* "Make offer" only for agricultural listings that are still active */}
            {!isProduct && listing.status === 'ACTIVE' && (
              <Link
                className="lc-cta lc-cta--offer"
                to={`/listings/${listing.id}#negotiation`}
              >
                Make offer
              </Link>
            )}
            <Link className="lc-cta lc-cta--view" to={`/listings/${listing.id}`}>
              View →
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
