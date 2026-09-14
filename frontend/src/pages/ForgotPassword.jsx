import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // The backend always returns the same generic message here, whether
      // or not the email is registered — this page reflects that as-is
      // rather than trying to infer anything from the response.
      await api.post('/auth/password/forgot', { email });
      setSent(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <div className="auth-card">
          <span className="eyebrow">ACCOUNT RECOVERY</span>
          <h1>Reset your password</h1>
          {sent ? (
            <>
              <p className="muted mt">
                If an account exists for <b>{email}</b>, we've sent a password reset link. It expires
                in 30 minutes.
              </p>
              <p className="muted mt"><Link to="/login">Back to login</Link></p>
            </>
          ) : (
            <>
              <p className="muted">Enter the email on your account and we'll send you a reset link.</p>
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submit}>
                <label>Email</label>
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="btn btn-primary btn-lg full mt" type="submit" disabled={submitting}>
                  {submitting ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
              <p className="muted mt"><Link to="/login">Back to login</Link></p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
