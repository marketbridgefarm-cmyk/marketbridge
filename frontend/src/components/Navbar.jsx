import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import { getLanguage, setLanguage, supportedLanguages, t } from '../utils/i18n.js';

// Order of preference when resolving a single "Dashboard" destination for a
// user with multiple roles. Per-role prompts to switch between capabilities
// live on the dashboards themselves (see RoleSwitchCTA), not here.
const DASHBOARD_BY_ROLE = [
  ['ADMIN', '/dashboard/admin'],
  ['SELLER', '/dashboard'],
  ['BUYER', '/dashboard'],
  ['INSPECTOR', '/dashboard/inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner'],
  ['ADVERTISER', '/dashboard/advertiser'],
];

function resolveDashboard(user) {
  return DASHBOARD_BY_ROLE.find(([r]) => user?.roles?.includes(r))?.[1] || '/';
}

const MARKET_LINKS = [
  { to: '/agricultural', labelKey: 'farmProduce', match: (p) => p === '/agricultural' || p === '/listings' },
  { to: '/products', labelKey: 'products', match: (p) => p.startsWith('/products') },
  { to: '/digital', labelKey: 'digital', match: (p) => p.startsWith('/digital') },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dashboardHref = resolveDashboard(user);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [language, setLanguageState] = useState(getLanguage());
  function changeLanguage(e) { const value = e.target.value; setLanguage(value); setLanguageState(value); window.dispatchEvent(new Event('mb-language-change')); }
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

  return (
    <>
      <header className="site-header">
        <nav className="navbar container-wide">
          <div className="navbar-start">
            <Link to="/" className="brand">
              <span className="brand-mark">MB</span>
              <span>Market<span>Bridge</span></span>
            </Link>

            {/* Marketplace switcher: always visible, right after the brand */}
            <div className="market-switcher">
              <span className="market-switcher-label">Want to buy/sell:</span>
              <div className="market-pills">
                {MARKET_LINKS.map((l) => (
                  <Link
                    key={l.to}
                    className={`market-pill${l.match(location.pathname) ? ' active' : ''}`}
                    to={l.to}
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* Desktop links */}
          <div className="nav-links">
            <label className="language-select" title={t('language', language)}><span className="sr-only">{t('language', language)}</span><select value={language} onChange={changeLanguage}>{supportedLanguages.map(([code,name]) => <option key={code} value={code}>{name}</option>)}</select></label>
            {user ? (
              <>
                <NotificationCenter />
                <div className="nav-account" ref={accountRef}>
                <button className="nav-user" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((v) => !v)}>
                  <span className="avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
                  {user.name}
                  <span className="nav-caret">▾</span>
                </button>
                {accountOpen && (
                  <div className="nav-dropdown" role="menu">
                    <Link role="menuitem" to={dashboardHref}>Dashboard</Link>
                    <Link role="menuitem" to="/dashboard/advertiser">Promote / Advertise</Link>
                    <button role="menuitem" onClick={handleLogout}>Log out</button>
                  </div>
                )}
                </div>
              </>
            ) : (
              <>
                <Link to="/login">Log in</Link>
                <Link className="nav-cta" to="/register">Join MarketBridge</Link>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
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
        </nav>
      </header>

      {/* Mobile menu: dimmed backdrop + slide-in panel anchored to the right,
          rendered outside <header> so its fixed positioning is relative to
          the viewport rather than the header's own (small) box. */}
      {mobileOpen && (
        <>
          <div className="mobile-menu-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <div className="mobile-menu" role="dialog" aria-modal="true">
            <span className="mobile-menu-label">Want to buy/sell:</span>
            {MARKET_LINKS.map((l) => (
              <Link key={l.to} className={l.match(location.pathname) ? 'active' : ''} to={l.to}>{t(l.labelKey, language)}</Link>
            ))}
            <div className="mobile-menu-divider" />
            <label className="language-select language-select--mobile"><span>{t('language', language)}</span><select value={language} onChange={changeLanguage}>{supportedLanguages.map(([code,name]) => <option key={code} value={code}>{name}</option>)}</select></label>
            {user ? (
              <>
                <div className="mobile-notification-link">
                  <NotificationCenter />
                </div>
                <Link to={dashboardHref}>Dashboard</Link>
                <Link to="/dashboard/advertiser">Promote / Advertise</Link>
                <button className="mobile-logout" onClick={handleLogout}>Log out</button>
              </>
            ) : (
              <>
                <Link to="/login">Log in</Link>
                <Link className="nav-cta" to="/register">Join MarketBridge</Link>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}