import React from 'react';
import './MobileNav.css';
import NavIcon from './NavIcon.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';

// Contextual screen titles for the mobile top app bar (first match wins).
const TITLES = [
  ['/listings/', 'Listing'],
  ['/agricultural', 'Marketplace'],
  ['/listings', 'Marketplace'],
  ['/products', 'Products'],
  ['/digital', 'Digital'],
  ['/create-listing', 'New listing'],
  ['/negotiations', 'Negotiations'],
  ['/orders/', 'Order'],
  ['/orders', 'Orders'],
  ['/services', 'Services'],
  ['/payments', 'Payment'],
  ['/account', 'Account'],
  ['/dashboard/admin', 'Admin'],
  ['/dashboard/inspector', 'Inspector'],
  ['/dashboard/truck-owner', 'Transporter'],
  ['/dashboard/advertiser', 'Advertising'],
  ['/dashboard', 'Dashboard'],
];

function titleFor(pathname) {
  return TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] || 'MarketBridge';
}

// Mobile-only (<768px) top app bar. `children` is the notification bell slot.
export default function MobileTopBar({ pathname, menuOpen, onMenu, children }) {
  return (
    <header className="mb-topbar">
      <button type="button" className="mb-topbar-menu" aria-label="Open menu" aria-expanded={menuOpen} onClick={onMenu}>
        <NavIcon name="menu" />
      </button>
      <span className="mb-topbar-mark" aria-hidden="true"><NavIcon name="leaf" size={20} /></span>
      <span className="mb-topbar-title">{titleFor(pathname)}</span>
      <LanguageSwitcher variant="segmented" className="mb-topbar-lang" />
      <div className="mb-topbar-bell">{children}</div>
    </header>
  );
}
