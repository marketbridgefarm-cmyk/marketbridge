import React from 'react';

/**
 * Shimmering placeholder. variant="cards" renders `count` listing-card-sized
 * blocks in a grid (for the marketplace); variant="lines" renders stacked
 * text-line bars (for lists/detail panels). Respects prefers-reduced-motion
 * via the .mb-skeleton-shimmer CSS rule.
 */
export default function LoadingSkeleton({ variant = 'cards', count = 6 }) {
  if (variant === 'lines') {
    return (
      <div className="mb-skeleton-lines" aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
          <div className="mb-skeleton-line mb-skeleton-shimmer" key={i} />
        ))}
      </div>
    );
  }
  return (
    <div className="listing-grid mb-listing-grid-3col" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="mb-skeleton-card" key={i}>
          <div className="mb-skeleton-photo mb-skeleton-shimmer" />
          <div className="mb-skeleton-body">
            <div className="mb-skeleton-line mb-skeleton-shimmer" style={{ width: '40%' }} />
            <div className="mb-skeleton-line mb-skeleton-shimmer" style={{ width: '70%', height: 18 }} />
            <div className="mb-skeleton-line mb-skeleton-shimmer" style={{ width: '50%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
