import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Order of preference when resolving a single "Dashboard" destination for a
// user with multiple roles. Per-role prompts to switch between capabilities
// now live on the dashboards themselves (see RoleSwitchCTA), not here.
const DASHBOARD_BY_ROLE = [
  ['ADMIN', '/dashboard/admin'],
  ['SELLER', '/dashboard/seller'],
  ['BUYER', '/dashboard/buyer'],
  ['INSPECTOR', '/dashboard/inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner'],
  ['ADVERTISER', '/dashboard/advertiser'],
];

function resolveDashboard(user) {
  return DASHBOARD_BY_ROLE.find(([r]) => user?.roles?.includes(r))?.[1] || '/';
}

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dashboardHref = resolveDashboard(user);

  return (
    <header className="site-header">
      <nav className="navbar container-wide">
        <Link to="/" className="brand">
          <span className="brand-mark">MB</span>
          <span>Market<span>Bridge</span></span>
        </Link>
        <div className="nav-links">
          <Link className={location.pathname === '/agricultural' || location.pathname === '/listings' ? 'active' : ''} to="/agricultural">Agricultural</Link>
          <Link className={location.pathname.startsWith('/products') ? 'active' : ''} to="/products">Product</Link>
          <Link className={location.pathname.startsWith('/digital') ? 'active' : ''} to="/digital">Digital</Link>
          {user && <Link className={location.pathname.startsWith('/dashboard') ? 'active' : ''} to={dashboardHref}>Dashboard</Link>}
          {user && <Link className={location.pathname.startsWith('/orders') ? 'active' : ''} to="/orders">Orders</Link>}
          {user ? (
            <button className="nav-user" onClick={() => navigate(dashboardHref)}>
              <span className="avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
              {user.name}
            </button>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link className="nav-cta" to="/register">Join MarketBridge</Link>
            </>
          )}
          {user && <button className="nav-logout" onClick={() => { logout(); navigate('/'); }}>Log out</button>}
        </div>
      </nav>
    </header>
  );
}
