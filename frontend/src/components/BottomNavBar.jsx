import React from 'react';
import { Link } from 'react-router-dom';
import './MobileNav.css';
import NavIcon from './NavIcon.jsx';

// Mobile-only (<768px) floating navigation. A glass pill holds the four working areas; the active one
// expands to show its label. Account sits in its own round button beside the pill.
// Destinations map onto existing routes only; no new routes are introduced.
const ITEMS = [
  { label: 'Market', to: '/agricultural', icon: 'marketplace', match: ['/agricultural', '/listings', '/products', '/digital', '/create-listing'] },
  { label: 'Deals', to: '/negotiations', icon: 'negotiation', match: ['/negotiations'] },
  { label: 'Orders', to: '/orders', icon: 'orders', match: ['/orders', '/payments'] },
  { label: 'Services', to: '/services', icon: 'transport', match: ['/services'] },
];
const ACCOUNT = { label: 'Account', to: '/account/security', icon: 'account', match: ['/account'] };

const isActive = (item, pathname) => item.match.some((prefix) => pathname.startsWith(prefix));

export default function BottomNavBar({ pathname }) {
  const accountActive = isActive(ACCOUNT, pathname);
  return (
    <nav className="mb-bottomnav" aria-label="Primary">
      <div className="mb-bottomnav-pill">
        {ITEMS.map((item) => {
          const active = isActive(item, pathname);
          return (
            <Link
              key={item.label}
              to={item.to}
              className={`mb-bottomnav-item${active ? ' active' : ''}`}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
            >
              <span className="mb-bottomnav-icon"><NavIcon name={item.icon} size={22} /></span>
              <span className="mb-bottomnav-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
      <Link
        to={ACCOUNT.to}
        className={`mb-bottomnav-orb${accountActive ? ' active' : ''}`}
        aria-label={ACCOUNT.label}
        aria-current={accountActive ? 'page' : undefined}
      >
        <NavIcon name={ACCOUNT.icon} size={24} />
      </Link>
    </nav>
  );
}
