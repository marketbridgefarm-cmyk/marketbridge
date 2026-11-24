import React from 'react';
import { Link } from 'react-router-dom';
import Avatar, { VerifiedTick } from './Avatar.jsx';
import RatingStars from './RatingStars.jsx';
import './DashboardWelcome.css';

// Glass profile card that tops every dashboard: big avatar, greeting, role line, rating and (optionally) three headline numbers.
// `stats` is optional: [{ value, label }, …] (up to 3 read well). Dashboards that pass none get the compact layout.
// (Children are intentionally not rendered; RecentActivity lives outside the greeting.)

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const PILL_COPY = {
  VERIFIED: 'Verified member',
  PENDING: 'Verification pending',
  REJECTED: 'Verification needs attention',
};

const SparkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 6.3L20.5 10.5l-6.3 2.2L12 19l-2.2-6.3L3.5 10.5l6.3-2.2L12 2z" fill="currentColor" /></svg>
);
const GearIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
  </svg>
);

export default function DashboardWelcome({ user, subtitle, stats }) {
  if (!user) return null;

  const firstName = (user.name || '').split(' ')[0] || 'there';
  const verified = user.verificationStatus === 'VERIFIED';
  const pill = PILL_COPY[user.verificationStatus] || 'MarketBridge member';
  const rating = Number(user.rating) > 0 ? Number(user.rating) : null;
  const hasStats = Array.isArray(stats) && stats.length > 0;

  return (
    <section className={`pc${hasStats ? ' pc--stats' : ''}`} aria-label="Your profile">
      <div className="pc-top">
        <span className={`pc-pill${verified ? ' is-ok' : ''}`}>
          <SparkIcon />
          {pill}
        </span>
        <Link className="pc-orb" to="/account/security" aria-label="Account settings">
          <GearIcon />
        </Link>
      </div>

      <div className="pc-hero">
        <Avatar name={user.name} src={user.avatarUrl} size="xl" />
        <div className="pc-id">
          <h1 className="pc-name">
            <span>{greeting()}, {firstName}!</span>
            {verified && <VerifiedTick size={22} />}
          </h1>
          {subtitle && <p className="pc-sub">{subtitle}</p>}
          {rating && (
            <p className="pc-rating">
              <RatingStars value={rating} size={16} />
              <b>{rating.toFixed(1)}</b>
              <span>rating</span>
            </p>
          )}
        </div>
      </div>

      {hasStats && (
        <dl className="pc-stats">
          {stats.map((s) => (
            <div key={s.label} className="pc-stat">
              <dd>{s.value}</dd>
              <dt>{s.label}</dt>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
