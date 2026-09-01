import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const roleLinks = [
  ['SELLER', '/dashboard/seller', 'Seller'],
  ['BUYER', '/dashboard/buyer', 'Buyer'],
  ['INSPECTOR', '/dashboard/inspector', 'Inspector'],
  ['TRUCK_OWNER', '/dashboard/truck-owner', 'Transport'],
  ['ADMIN', '/dashboard/admin', 'Admin'],
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
          {user && roleLinks.filter(([r]) => user.roles?.includes(r)).map(([r, href, label]) => (
            <Link key={r} className={location.pathname === href ? 'active' : ''} to={href}>{label}</Link>
          ))}
          {user ? (
            <button className="nav-user" onClick={() => navigate(roleLinks.find(([r]) => user.roles?.includes(r))?.[1] || '/')}>
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
