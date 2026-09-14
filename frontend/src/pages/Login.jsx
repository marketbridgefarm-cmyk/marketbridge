import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const SESSION_MESSAGES = {
  suspended: 'This account has been suspended. Contact support for assistance.',
  expired: 'Your session has ended. Please log in again.',
};

function destinationFor(u) {
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
  const { login, requestMfaEmailCode, verifyMfa } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // Once /auth/login reports mfaRequired, we stop showing the password
  // form and show a code-entry form scoped to this challenge instead.
  const [challenge, setChallenge] = useState(null); // { challengeId, methods }
  const [mfaMethod, setMfaMethod] = useState('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [emailCodeSent, setEmailCodeSent] = useState(false);

  const sessionReason = searchParams.get('session');
  const sessionMessage = sessionReason && SESSION_MESSAGES[sessionReason];

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) {
        setChallenge({ challengeId: result.challengeId, methods: result.methods || ['totp', 'email', 'backup'] });
        return;
      }
      nav(destinationFor(result));
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || data?.errors?.[0]?.msg || 'Login failed';
      setError(msg);
    }
  }

  async function sendEmailCode() {
    setError('');
    try {
      await requestMfaEmailCode(challenge.challengeId);
      setEmailCodeSent(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not send the verification code');
    }
  }

  async function submitMfa(e) {
    e.preventDefault();
    setError('');
    try {
      const u = await verifyMfa(challenge.challengeId, mfaCode, mfaMethod);
      nav(destinationFor(u));
    } catch (e) {
      setError(e.response?.data?.error || 'Verification failed');
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
          {!challenge ? (
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
              <p className="muted mt">
                <Link to="/forgot-password">Forgot your password?</Link>
              </p>
              <p className="muted mt">New to MarketBridge? <Link to="/register">Create an account</Link></p>
            </>
          ) : (
            <>
              <span className="eyebrow">VERIFY IT'S YOU</span>
              <h1>Enter your verification code</h1>
              <p className="muted">
                This account has two-factor authentication enabled. Enter a code from your
                authenticator app, or use a backup code.
              </p>
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submitMfa}>
                <label>Method</label>
                <select value={mfaMethod} onChange={(e) => { setMfaMethod(e.target.value); setMfaCode(''); }}>
                  {challenge.methods.includes('totp') && <option value="totp">Authenticator app code</option>}
                  {challenge.methods.includes('email') && <option value="email">Email code</option>}
                  {challenge.methods.includes('backup') && <option value="backup">Backup code</option>}
                </select>

                {mfaMethod === 'email' && (
                  <p className="muted mt">
                    {emailCodeSent ? 'Code sent — check your inbox.' : 'We can email you a one-time code.'}{' '}
                    <button type="button" className="btn-link" onClick={sendEmailCode}>
                      {emailCodeSent ? 'Resend code' : 'Send code'}
                    </button>
                  </p>
                )}

                <label>Code</label>
                <input
                  required
                  autoFocus
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={mfaMethod === 'backup' ? 'XXXXX-XXXXX' : '6-digit code'}
                />
                <button className="btn btn-primary btn-lg full mt" type="submit">Verify</button>
              </form>
              <p className="muted mt">
                <button type="button" className="btn-link" onClick={() => { setChallenge(null); setMfaCode(''); setError(''); }}>
                  Back to login
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
