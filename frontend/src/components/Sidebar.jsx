import React, { useEffect, useRef, useState } from 'react';
import './Sidebar.css';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../context/I18nContext.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import NavIcon from './NavIcon.jsx';
import MobileTopBar from './MobileTopBar.jsx';
import BottomNavBar from './BottomNavBar.jsx';
import useMediaQuery from './useMediaQuery.js';

const DASHBOARD_BY_ROLE = [
  ['ADMIN', '/dashboard/admin'],
  ['INSPECTOR', '/dashboard/inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner'],
  ['SELLER', '/dashboard'],
  ['BUYER', '/dashboard'],
];

function resolveDashboard(user) {
  return DASHBOARD_BY_ROLE.find(([role]) => user?.roles?.includes(role))?.[1] || '/';
}

const ROLE_DASHBOARD_LINKS = [
  ['INSPECTOR', '/dashboard/inspector', 'Inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner', 'Transporter'],
];


function NavItem({ to, icon, label, active, onClick, iconOnly }) {
  return (
    <Link
      to={to}
      className={`glass-nav-item${active ? ' active' : ''}`}
      title={iconOnly ? label : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="glass-nav-icon"><NavIcon name={icon} /></span>
      <span className="glass-nav-label">{label}</span>
    </Link>
  );
}

function MarketplaceNav({ active, onNavigate, iconOnly }) {
  return (
    <div className={`glass-marketplace-group${active ? ' active' : ''}`}>
      <NavItem
        to="/agricultural"
        icon="marketplace"
        label="Marketplace"
        active={active}
        onClick={onNavigate}
        iconOnly={iconOnly}
      />
      <div className="glass-marketplace-links" aria-label="Marketplace categories">
        <Link to="/agricultural" className="glass-marketplace-link" onClick={onNavigate}>
          <span>Farm Produce</span>
        </Link>
        <Link to="/products" className="glass-marketplace-link" onClick={onNavigate}>
          <span>Products</span>
        </Link>
        <Link to="/digital" className="glass-marketplace-link" onClick={onNavigate}>
          <span>Digital</span>
        </Link>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const accountRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Design freeze §5: >=1280 fixed full rail, 768-1279 icon rail (toggle
  // expands it as an overlay), <768 rail becomes a drawer opened from the
  // mobile top bar, with a 5-destination bottom bar.
  const isDesktop = useMediaQuery('(min-width: 1280px)');
  const isMobile = useMediaQuery('(max-width: 767px)');
  const wide = isDesktop || expanded;

  const dashboardHref = resolveDashboard(user);

  useEffect(() => {
    document.body.classList.toggle('has-sidebar', Boolean(user));
    return () => {
      document.body.classList.remove('has-sidebar');
    };
  }, [user]);

  useEffect(() => {
    setAccountOpen(false);
    setExpanded(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!accountOpen) return undefined;
    const onDocumentClick = (event) => {
      if (accountRef.current && !accountRef.current.contains(event.target)) setAccountOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setAccountOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const collapseAfterNavigation = () => {
    if (expanded) setExpanded(false);
  };

  const is = (path, exact = false) => exact ? location.pathname === path : location.pathname.startsWith(path);
  const marketActive = is('/agricultural') || is('/listings') || is('/products') || is('/digital');

  // The shell is an authenticated navigation surface. Never render it for
  // signed-out visitors (rail, top bar and bottom bar included).
  if (!user) return null;
  const advertisingActive = is('/dashboard/advertiser');
  const notificationsOpen = () => document.querySelector('.glass-notification-row .notification-trigger')?.click();
  const iconOnly = !wide;

  function handleLogout() {
    logout();
    setExpanded(false);
    navigate('/');
  }

  return (
    <>
      <MobileTopBar
        pathname={location.pathname}
        menuOpen={expanded}
        onMenu={() => setExpanded((v) => !v)}
      >
        {/* NotificationCenter is mounted exactly once: here on mobile, in the
            rail footer otherwise, so its polling is never duplicated. */}
        {isMobile && <NotificationCenter />}
      </MobileTopBar>

      <aside
        className={`glass-sidebar${wide ? ' expanded' : ''}${isDesktop ? ' is-desktop' : ''}`}
        aria-label="MarketBridge navigation"
        aria-hidden={isMobile && !expanded ? 'true' : undefined}
      >
        <div className="glass-brand-row">
          <button className="glass-toggle" type="button" aria-label={expanded ? 'Close sidebar' : 'Open sidebar'} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            <NavIcon name="menu" />
          </button>
          <span className="glass-brand-mark" aria-hidden="true"><NavIcon name="leaf" size={22} /></span>
          <span className="glass-brand-text">MarketBridge</span>
        </div>

        <div className="glass-nav-scroll">
          <NavItem to={dashboardHref} icon="home" label="Dashboard" active={is(dashboardHref, true)} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <MarketplaceNav active={marketActive} onNavigate={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/negotiations" icon="negotiation" label="Negotiations" active={is('/negotiations')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/orders" icon="orders" label="Orders" active={is('/orders')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/services" icon="transport" label="Transport" active={is('/services')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/services" icon="inspection" label="Inspections" active={is('/services')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/dashboard/advertiser" icon="advertising" label="Advertising" active={advertisingActive} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/orders" icon="payments" label="Payments" active={is('/payments')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
          <NavItem to="/dashboard" icon="messages" label="Messages" active={false} onClick={collapseAfterNavigation} iconOnly={iconOnly} />

          <div className="glass-divider" />

          <NavItem to="/account/security" icon="settings" label="Settings" active={is('/account/security')} onClick={collapseAfterNavigation} iconOnly={iconOnly} />
        </div>

        <div className="glass-account-footer">
          {!isMobile && (
            <div className="glass-notification-row">
              <NotificationCenter />
              <button type="button" className="glass-notification-label glass-nav-label" onClick={notificationsOpen}>Notifications</button>
            </div>
          )}

          <div className="glass-profile-wrap" ref={accountRef}>
            <button
              type="button"
              className="glass-profile"
              title={iconOnly ? (user.name || 'Account') : undefined}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((v) => !v)}
            >
              <span className="glass-avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
              <span className="glass-profile-info">
                <span className="glass-profile-name">{user.name}</span>
                <span className="glass-profile-role">{user.roles?.[0] || 'MarketBridge user'}</span>
              </span>
            </button>

            {accountOpen && (
              <div className="glass-account-menu" role="menu">
                <Link role="menuitem" to="/account/security" onClick={() => setAccountOpen(false)}>{t('nav.accountSecurity')}</Link>
                {ROLE_DASHBOARD_LINKS.filter(([role]) => user.roles?.includes(role)).map(([role, to, label]) => (
                  <Link key={role} role="menuitem" to={to} onClick={() => setAccountOpen(false)}>{label}</Link>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="glass-logout"
            title={iconOnly ? t('nav.logout') : undefined}
            aria-label={t('nav.logout')}
            onClick={handleLogout}
          >
            <span className="glass-nav-icon"><NavIcon name="login" /></span>
            <span className="glass-nav-label">{t('nav.logout')}</span>
          </button>

          <div className="glass-language"><LanguageSwitcher variant="segmented" /></div>
        </div>
      </aside>

      {expanded && !isDesktop && (
        <button
          type="button"
          className="glass-sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setExpanded(false)}
        />
      )}

      <BottomNavBar pathname={location.pathname} />
    </>
  );
}
