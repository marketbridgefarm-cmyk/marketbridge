import React, { useEffect, useRef, useState } from 'react';
import './Sidebar.css';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../context/I18nContext.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import NotificationCenter from './NotificationCenter.jsx';

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

function Icon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
  };

  const paths = {
    menu: <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>,
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></>,
    marketplace: <><path d="M4 9h16l-1-5H5L4 9Z"/><path d="M5 9v11h14V9"/><path d="M9 20v-7h6v7"/><path d="M4 9c0 1.7 1.1 3 2.5 3S9 10.7 9 9c0 1.7 1.1 3 2.5 3S14 10.7 14 9c0 1.7 1.1 3 2.5 3S19 10.7 19 9"/></>,
    negotiation: <><path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/></>,
    orders: <><path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h4"/></>,
    transport: <><path d="M3 6h11v11H3z"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></>,
    inspection: <><path d="m9 11 2 2 4-4"/><path d="M20 12a8 8 0 1 1-4.7-7.3"/><path d="M20 4v5h-5"/></>,
    advertising: <><path d="m4 10 11-5v14L4 14z"/><path d="M15 9h3a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-3"/><path d="M7 15v5"/></>,
    payments: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    notification: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    messages: <><path d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4l3 3 3-3h4a2 2 0 0 0 2-2V6Z"/><path d="M7 9h10M7 13h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.65 1.65 0 0 0-1.8-.3 1.65 1.65 0 0 0-1 1.5v.2h-4v-.2a1.65 1.65 0 0 0-1-1.5 1.65 1.65 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.65 1.65 0 0 0 .3-1.8 1.65 1.65 0 0 0-1.5-1H3v-4h.2a1.65 1.65 0 0 0 1.5-1 1.65 1.65 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.65 1.65 0 0 0 1.8.3 1.65 1.65 0 0 0 1-1.5V3h4v.2a1.65 1.65 0 0 0 1 1.5 1.65 1.65 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.65 1.65 0 0 0-.3 1.8 1.65 1.65 0 0 0 1.5 1h.2v4h-.2a1.65 1.65 0 0 0-1.5 1Z"/></>,
    account: <><circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
    chevron: <path d="m7 9 5 5 5-5"/>,
    login: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 5h5v14h-5"/></>,
    register: <><circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/></>,
  };

  return <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function NavItem({ to, icon, label, active, onClick }) {
  return (
    <Link
      to={to}
      className={`glass-nav-item${active ? ' active' : ''}`}
      data-tooltip={label}
      onClick={onClick}
    >
      <span className="glass-nav-icon"><Icon name={icon} /></span>
      <span className="glass-nav-label">{label}</span>
    </Link>
  );
}

function MarketplaceNav({ active, onNavigate }) {
  return (
    <div className={`glass-marketplace-group${active ? ' active' : ''}`}>
      <NavItem
        to="/agricultural"
        icon="marketplace"
        label="Marketplace"
        active={active}
        onClick={onNavigate}
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

  const dashboardHref = resolveDashboard(user);

  useEffect(() => {
    document.body.classList.toggle('has-sidebar', Boolean(user));
    document.body.classList.toggle('sidebar-open', Boolean(user) && expanded);

    return () => {
      document.body.classList.remove('has-sidebar');
      document.body.classList.remove('sidebar-open');
    };
  }, [user, expanded]);

  useEffect(() => {
    setAccountOpen(false);
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

  const collapseAfterNavigation = () => {
    if (expanded) setExpanded(false);
  };

  const is = (path, exact = false) => exact ? location.pathname === path : location.pathname.startsWith(path);
  const marketActive = is('/agricultural') || is('/listings') || is('/products') || is('/digital');
  const advertisingActive = is('/dashboard/advertiser');
  const notificationsOpen = () => document.querySelector('.notification-trigger')?.click();

  function handleLogout() {
    logout();
    setExpanded(false);
    navigate('/');
  }

  // The nav rail (and its mobile toggle) only makes sense once someone is
  // logged in — an anonymous visitor has no dashboard, orders, payments,
  // etc. to navigate to. Hooks above still run unconditionally so their
  // order never changes across renders; only the output is skipped.
  if (!user) return null;

  return (
    <>
      <aside className={`glass-sidebar${expanded ? ' expanded' : ''}`} aria-label="MarketBridge navigation">
        <div className="glass-brand-row">
          <button className="glass-toggle" type="button" aria-label="Toggle sidebar" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            <Icon name="menu" />
          </button>
          <span className="glass-brand-text">MarketBridge</span>
        </div>

        <div className="glass-nav-scroll">
          <NavItem to={dashboardHref} icon="home" label="Dashboard" active={is(dashboardHref, true)} onClick={collapseAfterNavigation} />
          <MarketplaceNav active={marketActive} onNavigate={collapseAfterNavigation} />
          <NavItem to="/negotiations" icon="negotiation" label="Negotiations" active={is('/negotiations')} onClick={collapseAfterNavigation} />
          <NavItem to="/orders" icon="orders" label="Orders" active={is('/orders')} onClick={collapseAfterNavigation} />
          <NavItem to="/services" icon="transport" label="Transport" active={is('/services')} onClick={collapseAfterNavigation} />
          <NavItem to="/services" icon="inspection" label="Inspections" active={is('/services')} onClick={collapseAfterNavigation} />
          <NavItem to="/dashboard/advertiser" icon="advertising" label="Advertising" active={advertisingActive} onClick={collapseAfterNavigation} />
          <NavItem to="/orders" icon="payments" label="Payments" active={is('/payments')} onClick={collapseAfterNavigation} />

          <button type="button" className="glass-nav-item glass-nav-button" data-tooltip="Notifications" onClick={notificationsOpen}>
            <span className="glass-nav-icon"><Icon name="notification" /></span>
            <span className="glass-nav-label">Notifications</span>
          </button>

          <NavItem to="/dashboard" icon="messages" label="Messages" active={false} onClick={collapseAfterNavigation} />

          <div className="glass-divider" />

          <NavItem to="/account/security" icon="settings" label="Settings" active={is('/account/security')} onClick={collapseAfterNavigation} />
        </div>

        <div className="glass-account-footer">
          {user && (
            <>
              <div className="glass-profile-wrap" ref={accountRef}>
                <button
                  type="button"
                  className="glass-profile"
                  data-tooltip={user.name || 'Account'}
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
                data-tooltip={t('nav.logout')}
                aria-label={t('nav.logout')}
                onClick={handleLogout}
              >
                <span className="glass-nav-icon"><Icon name="login" /></span>
                <span className="glass-nav-label">{t('nav.logout')}</span>
              </button>
            </>
          )}

          <div className="glass-language"><LanguageSwitcher /></div>
        </div>

        <div className="glass-notification-host" aria-hidden="true">
          <NotificationCenter />
        </div>
      </aside>

      {expanded && (
        <button
          type="button"
          className="glass-sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setExpanded(false)}
        />
      )}

      <div className="glass-mobile-trigger">
        <button type="button" aria-label={expanded ? 'Close sidebar' : 'Open sidebar'} onClick={() => setExpanded((v) => !v)}>
          <Icon name="menu" />
        </button>
      </div>
    </>
  );
}
