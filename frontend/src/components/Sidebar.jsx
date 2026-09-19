import React, { useEffect, useRef, useState } from 'react';
import './Sidebar.css';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../context/I18nContext.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import NotificationCenter from './NotificationCenter.jsx';

// Order of preference when resolving a single "Dashboard" destination for a
// user with multiple roles. Per-role prompts to switch between capabilities
// live on the dashboards themselves (see RoleSwitchCTA), not here.
const DASHBOARD_BY_ROLE = [
  ['ADMIN', '/dashboard/admin'],
  ['INSPECTOR', '/dashboard/inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner'],
  ['SELLER', '/dashboard'],
  ['BUYER', '/dashboard'],
];

function resolveDashboard(user) {
  return DASHBOARD_BY_ROLE.find(([r]) => user?.roles?.includes(r))?.[1] || '/';
}

const ROLE_DASHBOARD_LINKS = [
  ['INSPECTOR', '/dashboard/inspector', '🔍 Inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner', '🚛 Transporter'],
];

const MARKET_LINKS = [
  { to: '/agricultural', labelKey: 'nav.farmProduces', label: 'Farm Produces', match: (p) => p === '/agricultural' || p === '/listings' },
  { to: '/products', labelKey: 'nav.products', label: 'Products', match: (p) => p.startsWith('/products') },
  { to: '/digital', labelKey: 'nav.digital', label: 'Digital', match: (p) => p.startsWith('/digital') },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dashboardHref = resolveDashboard(user);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);

  // Close both menus whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
  }, [location.pathname]);

  // Close the account dropdown on outside click or Escape.
  useEffect(() => {
    if (!accountOpen) return;
    function onDocClick(e) {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setAccountOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  // Close the mobile drawer on outside click (backdrop) or Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') setMobileOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  function handleLogout() {
    logout();
    navigate('/');
  }

  const sidebarContent = (
    <>
      <div className="sidebar-brand-row">
        <Link to="/" className="brand">
          <span className="brand-mark">MB</span>
          <span>Market<span>Bridge</span></span>
        </Link>
        <button
          className="sidebar-close"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        >
          ✕
        </button>
      </div>

      {user && (
        <div className="sidebar-notif-row">
          <NotificationCenter />
        </div>
      )}

      <div className="sidebar-section">
        <span className="sidebar-section-label">Want to buy/sell</span>
        <div className="sidebar-links">
          {MARKET_LINKS.map((l) => (
            <Link
              key={l.to}
              className={`sidebar-link${l.match(location.pathname) ? ' active' : ''}`}
              to={l.to}
            >
              {t(l.labelKey)}
            </Link>
          ))}
        </div>
      </div>

      <div className="sidebar-divider" />

      {user ? (
        <>
          <div className="sidebar-section">
            <span className="sidebar-section-label">Menu</span>
            <div className="sidebar-links">
              <Link className={`sidebar-link${location.pathname === dashboardHref ? ' active' : ''}`} to={dashboardHref}>{t('nav.dashboard')}</Link>
              <Link className={`sidebar-link${location.pathname === '/services' ? ' active' : ''}`} to="/services">🧰 Services</Link>
              {ROLE_DASHBOARD_LINKS.filter(([role]) => user.roles?.includes(role)).map(([role, to, label]) => (
                <Link key={role} className={`sidebar-link${location.pathname === to ? ' active' : ''}`} to={to}>{label}</Link>
              ))}
              <Link className={`sidebar-link${location.pathname === '/dashboard/advertiser' ? ' active' : ''}`} to="/dashboard/advertiser">📣 Advertise</Link>
            </div>
          </div>

          <div className="sidebar-spacer" />

          <div className="sidebar-account" ref={accountRef}>
            <button className="sidebar-user" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((v) => !v)}>
              <span className="avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
              <span className="sidebar-user-name">{user.name}</span>
              <span className="nav-caret">▾</span>
            </button>
            {accountOpen && (
              <div className="sidebar-dropdown" role="menu">
                <Link role="menuitem" to="/account/security">{t('nav.accountSecurity')}</Link>
                <button role="menuitem" onClick={handleLogout}>{t('nav.logout')}</button>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-spacer" />
          <div className="sidebar-links sidebar-auth-links">
            <Link className="sidebar-link" to="/login">{t('nav.login')}</Link>
            <Link className="sidebar-link nav-cta" to="/register">Join MarketBridge</Link>
          </div>
        </>
      )}

      <div className="sidebar-lang-row">
        <LanguageSwitcher />
      </div>
    </>
  );

  return (
    <>
      {/* Slim top bar shown only on small screens; the sidebar itself is
          off-canvas there and opened via this bar's hamburger button. */}
      <header className="mobile-topbar">
        <button
          className={`nav-burger${mobileOpen ? ' nav-burger-open' : ''}`}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link to="/" className="brand mobile-topbar-brand">
          <span className="brand-mark">MB</span>
          <span>Market<span>Bridge</span></span>
        </Link>
        {user && (
          <div className="mobile-topbar-notif">
            <NotificationCenter />
          </div>
        )}
      </header>

      {/* Desktop sidebar: always present, sticky in the flex layout. */}
      <aside className="sidebar sidebar-desktop">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar: off-canvas drawer, backdrop rendered outside so its
          fixed positioning is relative to the viewport. */}
      {mobileOpen && (
        <>
          <div className="mobile-menu-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <aside className="sidebar sidebar-mobile">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
