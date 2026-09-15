import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../i18n/I18nContext.jsx';

const SESSION_MESSAGES = {
  suspended: 'This account has been suspended. Contact support for assistance.',
  expired: 'Your session has ended. Please log in again.',
};

function dashboardPathFor(u) {
  const roles = Array.isArray(u?.roles) ? u.roles : [];

  // Specialist roles must win over the default BUYER/SELLER roles.
  // Otherwise an inspector or transporter who also has marketplace
  // capabilities is silently sent to /dashboard and may never discover
  // their operational dashboard.
  if (roles.includes('ADMIN')) return '/dashboard/admin';
  if (roles.includes('INSPECTOR')) return '/dashboard/inspector';
  if (roles.includes('TRUCK_OWNER')) return '/dashboard/truck-owner';
  if (roles.includes('BUYER') || roles.includes('SELLER')) return '/dashboard';

  // Advertising is an authenticated capability, not a required account role.
  return '/';
}

export default function Login() {
  const { login, completeMfaLogin } = useAuth();
  const { t } = useTranslation();
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
                  ← {t('auth.backToLogin')}
                </button>
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">{t('auth.welcomeBack').toUpperCase()}</span>
              <h1>{t('auth.loginTitle')}</h1>
              {sessionMessage && !error && <div className="alert error">{sessionMessage}</div>}
              {error && <div className="alert error">{error}</div>}
              <form onSubmit={submit}>
                <label>{t('auth.email')}</label>
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <label>{t('auth.password')}</label>
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button className="btn btn-primary btn-lg full mt" type="submit">{t('nav.login')}</button>
              </form>
              <p className="muted mt"><Link to="/forgot-password">{t('auth.forgotPassword')}</Link></p>
              <p className="muted mt">{t('auth.newToMarketBridge')} <Link to="/register">{t('auth.createAccount')}</Link></p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
