import React from 'react';

// Shared across SellerDashboard and BuyerDashboard so both role views feel
// like one connected "home base" rather than two disconnected pages —
// same greeting, same avatar treatment, same trust badges. This is the
// personal, attractive header meant to make people want to stay on the
// dashboard rather than bounce off it.

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const VERIFICATION_COPY = {
  VERIFIED: { label: 'Verified account', className: 'dash-badge-verified' },
  PENDING: { label: 'Verification pending', className: 'dash-badge-pending' },
  REJECTED: { label: 'Verification needs attention', className: 'dash-badge-pending' },
  UNVERIFIED: null,
};

export default function DashboardWelcome({ user, subtitle, children }) {
  if (!user) return null;

  const firstName = (user.name || '').split(' ')[0] || 'there';
  const initial = (user.name || 'U').charAt(0).toUpperCase();
  const verification = VERIFICATION_COPY[user.verificationStatus];
  const hasRating = Number(user.rating) > 0;

  return (
    <div className="dash-welcome">
      <div className="dash-welcome-avatar" aria-hidden="true">{initial}</div>
      <div className="dash-welcome-body">
        <h1 className="dash-welcome-heading">{greeting()}, {firstName}!</h1>
        {subtitle && <p className="dash-welcome-subtitle">{subtitle}</p>}
        <div className="dash-welcome-badges">
          {verification && <span className={`dash-badge ${verification.className}`}>{verification.label}</span>}
          {hasRating && <span className="dash-badge dash-badge-rating">★ {Number(user.rating).toFixed(1)} rating</span>}
        </div>
      </div>
      {children}
    </div>
  );
}
