import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/client';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/password/reset', { token, password });
      setDone(true);
      // The backend also revokes every existing session on a reset, so
      // there's nothing stale to clear locally — just send them to log in.
      setTimeout(() => nav('/login'), 2000);
    } catch (e) {
      setError(e.response?.data?.error || 'This reset link is invalid or has expired.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <main className="section auth-section">
        <div className="auth-shell">
          <div className="auth-card">
            <h1>Invalid reset link</h1>
            <p className="muted mt">
              This link is missing its reset token. Request a new one from{' '}
              <Link to="/forgot-password">the password reset page</Link>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <div className="auth-card">
          <span className="eyebrow">ACCOUNT RECOVERY</span>
          <h1>Choose a new password</h1>
          {done ? (
            <p className="muted mt">Password updated. Redirecting you to login…</p>
          ) : (
            <>
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submit}>
                <label>New password</label>
                <input
                  required
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <label>Confirm new password</label>
                <input
                  required
                  type="password"
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <button className="btn btn-primary btn-lg full mt" type="submit" disabled={submitting}>
                  {submitting ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
