import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const optional = [
  ['INSPECTOR', 'Independent Inspector'],
  ['TRUCK_OWNER', 'Truck Owner / Driver'],
  ['ADVERTISER', 'Advertiser'],
];

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', location: '' });
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');

  const toggle = (r) => setSelected((x) => (x.includes(r) ? x.filter((a) => a !== r) : [...x, r]));

  async function submit(e) {
    e.preventDefault();
    try {
      await register({ ...form, roles: ['BUYER', 'SELLER', ...selected] });
      nav('/');
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || data?.errors?.[0]?.msg || 'Registration failed';
      setError(msg);
    }
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <aside className="auth-side">
          <div className="auth-side-top">
            <span className="brand-mark">MB</span>
            <h2>One account. Buy and sell.</h2>
            <p>Every MarketBridge member starts with both buyer and seller capability, with optional specialist roles.</p>
          </div>
          <ul className="auth-points">
            <li><b>🌾</b> List crops or products in minutes</li>
            <li><b>🛒</b> Browse and buy from verified sellers</li>
            <li><b>🔍</b> Add inspector, transport, or advertiser roles anytime</li>
          </ul>
        </aside>

        <div className="auth-card">
          <span className="eyebrow">JOIN THE NETWORK</span>
          <h1>Create your account</h1>
          {error && <div className="alert error">{error}</div>}
          <form onSubmit={submit}>
            <label>Full name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label>Email</label>
            <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <label>Phone</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <label>Location</label>
            <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            <label>Password (min. 8 characters)</label>
            <input required minLength={8} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />

            <label>Optional capabilities</label>
            <div className="role-select">
              {optional.map(([r, l]) => (
                <button
                  type="button"
                  key={r}
                  className={`role-option ${selected.includes(r) ? 'selected' : ''}`}
                  onClick={() => toggle(r)}
                >
                  {selected.includes(r) ? '✓ ' : ''}{l}
                </button>
              ))}
            </div>

            <button className="btn btn-primary btn-lg full mt" type="submit">Create account</button>
          </form>
          <p className="muted mt">Already registered? <Link to="/login">Log in</Link></p>
        </div>
      </div>
    </main>
  );
}
