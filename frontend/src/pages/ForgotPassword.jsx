import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [devUrl, setDevUrl] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/auth/forgot-password', { email });
      setSubmitted(true);
      // Only ever present outside production (see backend/src/routes/auth.js)
      // since there's no email/SMS provider wired up yet.
      setDevUrl(res.data.devResetUrl || null);
    } catch (e) {
      const data = e.response?.data;
      setError(data?.error || data?.errors?.[0]?.msg || 'Could not process your request');
    }
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <aside className="auth-side">
          <div className="auth-side-top">
            <span className="brand-mark">MB</span>
            <h2>Forgot your password?</h2>
            <p>We'll send a reset link to the email on your account.</p>
          </div>
        </aside>

        <div className="auth-card">
          <span className="eyebrow">ACCOUNT RECOVERY</span>
          <h1>Reset your password</h1>
          {error && <div className="alert error">{error}</div>}
          {submitted ? (
            <>
              <div className="alert success">
                If that email is registered, a password reset link has been sent. Check your inbox.
              </div>
              {devUrl && (
                <div className="alert" style={{ wordBreak: 'break-all' }}>
                  Dev mode — no email provider configured yet:<br />
                  <Link to={devUrl.replace(/^.*\/reset-password/, '/reset-password')}>{devUrl}</Link>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={submit}>
              <label>Email</label>
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn btn-primary btn-lg full mt" type="submit">Send reset link</button>
            </form>
          )}
          <p className="muted mt"><Link to="/login">← Back to login</Link></p>
        </div>
      </div>
    </main>
  );
}
