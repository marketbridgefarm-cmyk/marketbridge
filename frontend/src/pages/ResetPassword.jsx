import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/client';

export default function ResetPassword() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => nav('/login'), 2000);
    } catch (e) {
      const data = e.response?.data;
      setError(data?.error || data?.errors?.[0]?.msg || 'Could not reset password');
    }
  }

  if (!token) {
    return (
      <main className="section auth-section">
        <div className="auth-card" style={{ margin: '0 auto' }}>
          <div className="alert error">This reset link is missing its token. Request a new one.</div>
          <p className="muted mt"><Link to="/forgot-password">Request a new reset link</Link></p>
        </div>
      </main>
    );
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <aside className="auth-side">
          <div className="auth-side-top">
            <span className="brand-mark">MB</span>
            <h2>Choose a new password</h2>
            <p>Make it something you haven't used elsewhere.</p>
          </div>
        </aside>

        <div className="auth-card">
          <span className="eyebrow">ACCOUNT RECOVERY</span>
          <h1>Set a new password</h1>
          {error && <div className="alert error">{error}</div>}
          {done ? (
            <div className="alert success">Your password has been reset. Redirecting to login…</div>
          ) : (
            <form onSubmit={submit}>
              <label>New password</label>
              <input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              <label>Confirm new password</label>
              <input required type="password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              <button className="btn btn-primary btn-lg full mt" type="submit">Reset password</button>
            </form>
          )}
          <p className="muted mt"><Link to="/login">← Back to login</Link></p>
        </div>
      </div>
    </main>
  );
}
