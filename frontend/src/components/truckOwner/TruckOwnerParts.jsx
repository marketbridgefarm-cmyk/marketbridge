import React from 'react';

// Small presentational pieces shared by the transport-owner dashboard cards.
// Extracted verbatim from pages/TruckOwnerDashboard.jsx.

export function ArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function RouteStrip({ pickup, destination, compact = false }) {
  const w = compact ? 20 : 24;
  const h = compact ? 10 : 12;
  return (
    <div className={`sd-job-route${compact ? ' sd-job-route--compact' : ''}`}>
      <div className="sd-job-endpoint">
        <span className="sd-job-endpoint-label">Pickup</span>
        <strong>{pickup || 'Not set'}</strong>
      </div>
      <div className="sd-job-route-arrow" aria-hidden="true">
        <svg
          width={w}
          height={h}
          viewBox="0 0 24 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 6h18" />
          <path d="M15 2l5 4-5 4" />
        </svg>
      </div>
      <div className="sd-job-endpoint">
        <span className="sd-job-endpoint-label">Destination</span>
        <strong>{destination || 'Not set'}</strong>
      </div>
    </div>
  );
}

// Big number + small unit, as on the Orders "Amount" block.
export function AmountRow({ value, unit = 'ETB' }) {
  return (
    <div className="sd-amount">
      <b>{value}</b>
      <span>{unit}</span>
    </div>
  );
}
