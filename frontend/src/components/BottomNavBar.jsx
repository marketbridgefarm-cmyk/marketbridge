import React from 'react';
import { Link } from 'react-router-dom';
import './MobileNav.css';
import NavIcon from './NavIcon.jsx';

// Mobile-only (<768px) bottom navigation — design freeze §2.2.
// Destinations map onto existing routes only; no new routes are introduced.
const ITEMS = [
  { label: 'Market', to: '/agricultural', icon: 'marketplace', match: ['/agricultural', '/listings', '/products', '/digital', '/create-listing'] },
  { label: 'Deals', to: '/negotiations', icon: 'negotiation', match: ['/negotiations'] },
  { label: 'Orders', to: '/orders', icon: 'orders', match: ['/orders', '/payments'] },
  { label: 'Services', to: '/services', icon: 'transport', match: ['/services'] },
  { label: 'Account', to: '/account/security', icon: 'account', match: ['/account'] },
];

export default function BottomNavBar({ pathname }) {
  return (
    <nav className="mb-bottomnav" aria-label="Primary">
      {ITEMS.map((item) => {
        const active = item.match.some((prefix) => pathname.startsWith(prefix));
        return (
          <Link
            key={item.label}
            to={item.to}
            className={`mb-bottomnav-item${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="mb-bottomnav-icon"><NavIcon name={item.icon} size={22} /></span>
            <span className="mb-bottomnav-label">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
