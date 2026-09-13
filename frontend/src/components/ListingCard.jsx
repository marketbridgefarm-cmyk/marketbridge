import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

export default function ListingCard({ listing }) {
  const isProduct = listing.category === 'PRODUCT';
  const title = listing.title || listing.cropType || 'Listing';
  const cardRef = useRef(null);
  const recorded = useRef(false);

  const isVerifiedSeller = listing.seller?.verificationStatus === 'VERIFIED';

  const inspectionRequests = listing.inspectionRequests || [];
  const hasInspectionReport = inspectionRequests.some((r) => r.report);
  const hasActiveInspection = inspectionRequests.some(
    (r) => r.status !== 'CANCELLED' && !r.report
  );
  const inspectionLabel = hasInspectionReport
    ? '✓ Inspected'
    : hasActiveInspection
      ? 'Inspection in progress'
      : null;

  useEffect(() => {
    if (!listing.sponsoredAdId || !cardRef.current || recorded.current) return undefined;
    const node = cardRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !recorded.current) {
        recorded.current = true;
        api.post(`/ads/${listing.sponsoredAdId}/events`, { eventType: 'IMPRESSION' }).catch(() => undefined);
        observer.disconnect();
      }
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [listing.sponsoredAdId]);

  return <article ref={cardRef} className={`listing-card${listing.sponsored ? ' listing-card--sponsored' : ''}`}>
    <div className="listing-photo">
      {listing.sponsored && <span className="tag tag--sponsored">Sponsored</span>}
      {listing.photos?.[0]
        ? <img src={listing.photos[0]} alt={title}/>
        : listing.videos?.[0]
          ? <video src={listing.videos[0]} muted />
          : <span>{title.slice(0,2).toUpperCase()}</span>}
    </div>
    <div className="listing-body">
      <div className="listing-meta">
        <span className="tag">{isProduct ? 'PRODUCT' : 'AGRICULTURE'}</span>
        {!isProduct && inspectionLabel && (
          <span className={`tag ${hasInspectionReport ? 'tag--good' : ''}`}>{inspectionLabel}</span>
        )}
        <span>{listing.status}</span>
      </div>
      <h3>{title}</h3>
      <p className="listing-location">⌖ {listing.location}</p>
      <div className="listing-stats"><div><span>Quantity</span><strong>{Number(listing.quantity).toLocaleString()} {listing.unit}</strong></div><div><span>Asking</span><strong>{Number(listing.askingPrice).toLocaleString()} ETB</strong></div></div>
      <div className="listing-footer">
        <span>
          Seller: {listing.seller?.name || 'Seller'}
          {isVerifiedSeller && <span className="verified-mark" title="Verified seller"> ✓ Verified</span>}
          {listing.seller?.rating ? ` · ★ ${listing.seller.rating.toFixed(1)}` : ''}
        </span>
        <Link className="text-link" to={`/listings/${listing.id}`}>View listing →</Link>
      </div>
    </div>
  </article>;
}
