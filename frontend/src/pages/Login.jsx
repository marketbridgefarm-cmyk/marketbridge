import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const SESSION_MESSAGES = {
  suspended: 'This account has been suspended. Contact support for assistance.',
  expired: 'Your session has ended. Please log in again.',
};

function dashboardPathFor(u) {
  return u.roles?.includes('ADMIN')
    ? '/dashboard/admin'
    : u.roles?.includes('BUYER') || u.roles?.includes('SELLER')
    ? '/dashboard'
    : u.roles?.includes('INSPECTOR')
    ? '/dashboard/inspector'
    : u.roles?.includes('TRUCK_OWNER')
    ? '/dashboard/truck-owner'
    : u.roles?.includes('ADVERTISER')
    ? '/dashboard/advertiser'
    : '/';
}

export default function Login() {
  const { login, completeMfaLogin } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // Set once the server confirms the password was correct but this account
  // needs a second factor. While this is set, the form below shows the code
  // entry step instead of the email/password fields.
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  const sessionReason = searchParams.get('session');
  const sessionMessage = sessionReason && SESSION_MESSAGES[sessionReason];

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) {
        setMfaChallenge(result.challengeToken);
        return;
      }
      nav(dashboardPathFor(result));
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || data?.errors?.[0]?.msg || 'Login failed';
      setError(msg);
    }
  }

  async function submitMfaCode(e) {
    e.preventDefault();
    setError('');
    try {
      const u = await completeMfaLogin(mfaChallenge, mfaCode);
      nav(dashboardPathFor(u));
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || 'Invalid code';
      if (data?.code === 'MFA_CHALLENGE_EXPIRED') {
        setMfaChallenge(null);
        setMfaCode('');
      }
      setError(msg);
    }
  }

  return (
    <main className="section auth-section">
      <div className="auth-shell">
        <aside className="auth-side">
          <div className="auth-side-top">
            <span className="brand-mark">MB</span>
            <h2>Buy and sell across Ethiopia's farms, faster.</h2>
            <p>One login for listings, orders, transport, and payments — all in one place.</p>
          </div>
          <ul className="auth-points">
            <li><b>✓</b> Track every order from offer to delivery</li>
            <li><b>✓</b> Arrange transport with verified truck owners</li>
            <li><b>✓</b> Pay securely with Telebirr, CBE, or QR</li>
          </ul>
        </aside>

        <div className="auth-card">
          {mfaChallenge ? (
            <>
              <span className="eyebrow">VERIFY IT'S YOU</span>
              <h1>Enter your authentication code</h1>
              <p className="muted">Open your authenticator app, or use one of your backup codes.</p>
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submitMfaCode}>
                <label>Authentication code</label>
                <input
                  required
                  autoFocus
                  type="text"
                  inputMode="text"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                />
                <button className="btn btn-primary btn-lg full mt" type="submit">Verify</button>
              </form>
              <p className="muted mt">
                <button type="button" className="link-button" onClick={() => { setMfaChallenge(null); setMfaCode(''); setError(''); }}>
                  ← Back to login
                </button>
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">WELCOME BACK</span>
              <h1>Log in to MarketBridge</h1>
              {sessionMessage && !error && <div className="alert error">{sessionMessage}</div>}
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submit}>
                <label>Email</label>
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <label>Password</label>
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button className="btn btn-primary btn-lg full mt" type="submit">Log in</button>
              </form>
              <p className="muted mt"><Link to="/forgot-password">Forgot your password?</Link></p>
              <p className="muted mt">New to MarketBridge? <Link to="/register">Create an account</Link></p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
