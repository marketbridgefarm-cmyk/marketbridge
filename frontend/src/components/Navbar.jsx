import React, { useEffect, useRef, useState } from 'react';
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

export default function Navbar() {
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
                    {t(l.labelKey)}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* Desktop links */}
          <div className="nav-links">
            {user ? (
              <>
                <NotificationCenter />
                <Link className={location.pathname === '/services' ? 'active' : ''} to="/services">Services</Link>
                <div className="nav-role-links" aria-label="Specialist dashboards">
                  {ROLE_DASHBOARD_LINKS.filter(([role]) => user.roles?.includes(role)).map(([role, to, label]) => (
                    <Link key={role} className={location.pathname === to ? 'active' : ''} to={to}>{label}</Link>
                  ))}
                  <Link className={location.pathname === '/dashboard/advertiser' ? 'active' : ''} to="/dashboard/advertiser">📣 Advertise</Link>
                </div>
                <div className="nav-account" ref={accountRef}>
                <button className="nav-user" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((v) => !v)}>
                  <span className="avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
                  {user.name}
                  <span className="nav-caret">▾</span>
                </button>
                {accountOpen && (
                  <div className="nav-dropdown" role="menu">
                    <Link role="menuitem" to={dashboardHref}>{t('nav.dashboard')}</Link>
                    <Link role="menuitem" to="/services">🧰 Services</Link>
                    {ROLE_DASHBOARD_LINKS.filter(([role]) => user.roles?.includes(role)).map(([role, to, label]) => (
                      <Link key={role} role="menuitem" to={to}>{label} Dashboard</Link>
                    ))}
                    <Link role="menuitem" to="/dashboard/advertiser">📣 Advertise Dashboard</Link>
                    <Link role="menuitem" to="/account/security">{t('nav.accountSecurity')}</Link>
                    <button role="menuitem" onClick={handleLogout}>{t('nav.logout')}</button>
                  </div>
                )}
                </div>
              </>
            ) : (
              <>
                <Link to="/login">{t('nav.login')}</Link>
                <Link className="nav-cta" to="/register">Join MarketBridge</Link>
              </>
            )}
            <LanguageSwitcher />
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
            {user && (
              <div className="mobile-menu-user">
                <span className="avatar mobile-menu-avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
                <div className="mobile-menu-user-info">
                  <h3>{user.name}</h3>
                  <p>{(user.roles || []).map((r) => r.charAt(0) + r.slice(1).toLowerCase()).join(' · ') || 'Member'}</p>
                </div>
              </div>
            )}

            <span className="mobile-menu-label">Want to buy/sell</span>
            <div className="mobile-menu-list">
              {MARKET_LINKS.map((l) => (
                <Link key={l.to} className={`mobile-menu-item${l.match(location.pathname) ? ' active' : ''}`} to={l.to}>{t(l.labelKey)}</Link>
              ))}
            </div>

            {user ? (
              <>
                <span className="mobile-menu-label">Menu</span>
                <div className="mobile-menu-list">
                  <div className="mobile-menu-item mobile-notification-link">
                    <NotificationCenter />
                  </div>
                  <Link className="mobile-menu-item" to={dashboardHref}>🏠 {t('nav.dashboard')}</Link>
                  <Link className={`mobile-menu-item${location.pathname === '/services' ? ' active' : ''}`} to="/services">🧰 Services</Link>
                  {ROLE_DASHBOARD_LINKS.filter(([role]) => user.roles?.includes(role)).map(([role, to, label]) => (
                    <Link key={role} className="mobile-menu-item" to={to}>{label} Dashboard</Link>
                  ))}
                  <Link className="mobile-menu-item" to="/dashboard/advertiser">📣 Advertise Dashboard</Link>
                </div>

                <span className="mobile-menu-label">Account</span>
                <div className="mobile-menu-list">
                  <Link className="mobile-menu-item" to="/account/security">🔒 {t('nav.accountSecurity')}</Link>
                  <button className="mobile-menu-item mobile-logout" onClick={handleLogout}>🚪 {t('nav.logout')}</button>
                </div>
              </>
            ) : (
              <div className="mobile-menu-list">
                <Link className="mobile-menu-item" to="/login">{t('nav.login')}</Link>
                <Link className="mobile-menu-item nav-cta" to="/register">Join MarketBridge</Link>
              </div>
            )}

            <div className="mobile-menu-footer">
              <LanguageSwitcher className="mobile-lang-switcher" />
            </div>
          </div>
        </>
      )}
    </>
  );
}
