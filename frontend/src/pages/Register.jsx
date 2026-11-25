import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import AvatarPicker from '../components/AvatarPicker.jsx';
import './auth/auth.css';

const optional = [
  ['INSPECTOR', 'Independent Inspector'],
  ['TRUCK_OWNER', 'Truck Owner / Driver'],
];

export default function Register() {
  const { register, refreshUser } = useAuth();
  const { showToast } = useToast();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', location: '' });
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState(null);        // prepared (square, small) File, optional
  const [stage, setStage] = useState('');          // '', 'creating', 'photo'

  const toggle = (r) => setSelected((x) => (x.includes(r) ? x.filter((a) => a !== r) : [...x, r]));

  function dashboardPathFor(u) {
    const roles = Array.isArray(u?.roles) ? u.roles : [];
    if (roles.includes('ADMIN')) return '/dashboard/admin';
    if (roles.includes('INSPECTOR')) return '/dashboard/inspector';
    if (roles.includes('TRUCK_OWNER')) return '/dashboard/truck-owner';
    if (roles.includes('BUYER') || roles.includes('SELLER')) return '/dashboard';
    return '/dashboard';
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setStage('creating');
    let user;
    try {
      user = await register({ ...form, roles: ['BUYER', 'SELLER', ...selected] });
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || data?.errors?.[0]?.msg || 'Registration failed';
      setError(msg);
      setStage('');
      return;
    }

    // The account exists now, so the photo can be uploaded with the new session. A failed upload must never
    // block sign-up: the person can add the photo later from Account.
    if (photo) {
      setStage('photo');
      try {
        const body = new FormData();
        body.append('avatar', photo, photo.name || 'avatar.webp');
        await api.post('/auth/me/avatar', body);
        await refreshUser();
      } catch (e) {
        showToast(e.response?.data?.error || 'Your account is ready, but the photo could not be uploaded. You can add it from Account settings.', 'info', 7000);
      }
    }
    nav(dashboardPathFor(user), { replace: true });
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
            <li><b>🔍</b> Add specialist inspector or transport capabilities anytime; advertising is available to every signed-in user</li>
          </ul>
        </aside>
        <div className="auth-card">
          <span className="eyebrow">JOIN THE NETWORK</span>
          <h1>Create your account</h1>
          {error && <div className="alert error">{error}</div>}
          <form onSubmit={submit}>
            <AvatarPicker name={form.name} onSelect={setPhoto} onRemove={() => setPhoto(null)} busy={stage !== ''} />
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
                <button type="button" key={r} className={`role-option ${selected.includes(r) ? 'selected' : ''}`} onClick={() => toggle(r)}>
                  {selected.includes(r) ? '✓ ' : ''}{l}
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-lg full mt" type="submit" disabled={stage !== ''}>
              {stage === 'creating' ? 'Creating your account…' : stage === 'photo' ? 'Uploading your photo…' : 'Create account'}
            </button>
          </form>
          <p className="muted mt">Already registered? <Link to="/login">Log in</Link></p>
        </div>
      </div>
    </main>
  );
}
