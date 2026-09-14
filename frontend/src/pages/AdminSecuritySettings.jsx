import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// Admin-only MFA management: enable/confirm TOTP, view/regenerate backup
// codes, disable. Kept as its own page (rather than another tab bolted onto
// AdminDashboard.jsx, which is already large — see roadmap item 10) so it
// stays easy to find and easy to maintain independently.
export default function AdminSecuritySettings() {
  const { user, refreshUser } = useAuth();

  const [setupData, setSetupData] = useState(null); // { secret, otpauthUrl, qrDataUrl }
  const [confirmCode, setConfirmCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const mfaEnabled = !!user?.mfaEnabled;

  async function startSetup() {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const res = await api.post('/auth/mfa/setup/start');
      setSetupData(res.data);
      setBackupCodes(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to start MFA setup');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/auth/mfa/setup/confirm', { code: confirmCode });
      setBackupCodes(res.data.backupCodes);
      setSetupData(null);
      setConfirmCode('');
      await refreshUser();
    } catch (e) {
      setError(e.response?.data?.error || 'Incorrect code');
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/mfa/disable', { password });
      setPassword('');
      setMessage('MFA disabled.');
      setBackupCodes(null);
      await refreshUser();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to disable MFA');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateBackupCodes(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/auth/mfa/backup-codes/regenerate', { password });
      setBackupCodes(res.data.backupCodes);
      setPassword('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to regenerate backup codes');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="section">
      <div className="sd-panel" style={{ maxWidth: 560, margin: '0 auto' }}>
        <p className="muted"><Link to="/dashboard/admin">← Back to Admin Control Center</Link></p>
        <h1>Security</h1>
        <p className="muted">Two-factor authentication for your admin account.</p>

        {error && <div className="alert error">{error}</div>}
        {message && <div className="alert">{message}</div>}

        {backupCodes && (
          <div className="alert">
            <p><b>Save these backup codes now.</b> Each one works once, and this is the only time they'll be shown.</p>
            <ul>
              {backupCodes.map((code) => (
                <li key={code}><code>{code}</code></li>
              ))}
            </ul>
          </div>
        )}

        {mfaEnabled && !setupData && (
          <section className="mt">
            <p>✅ Two-factor authentication is <b>enabled</b> on your account.</p>

            <form onSubmit={regenerateBackupCodes} className="mt">
              <label>Password (to regenerate backup codes)</label>
              <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn mt" type="submit" disabled={busy}>Regenerate backup codes</button>
            </form>

            <form onSubmit={disableMfa} className="mt">
              <label>Password (to disable MFA)</label>
              <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn btn-danger mt" type="submit" disabled={busy}>Disable MFA</button>
            </form>
          </section>
        )}

        {!mfaEnabled && !setupData && (
          <section className="mt">
            <p>Two-factor authentication is <b>not enabled</b>. Admin accounts are a high-value target — turning this on is strongly recommended.</p>
            <button className="btn btn-primary" onClick={startSetup} disabled={busy}>Set up two-factor authentication</button>
          </section>
        )}

        {setupData && (
          <section className="mt">
            <p>Scan this in Google Authenticator, Microsoft Authenticator, or Authy:</p>
            <img src={setupData.qrDataUrl} alt="MFA setup QR code" style={{ maxWidth: 220 }} />
            <p className="muted">Or enter this code manually: <code>{setupData.secret}</code></p>

            <form onSubmit={confirmSetup} className="mt">
              <label>Enter the 6-digit code from your app</label>
              <input
                required
                autoFocus
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="123456"
              />
              <button className="btn btn-primary mt" type="submit" disabled={busy}>Confirm and enable</button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
