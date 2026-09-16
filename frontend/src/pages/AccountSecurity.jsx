import React, { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { LANGUAGES, useTranslation } from '../context/I18nContext.jsx';

// Self-service MFA (TOTP) enrollment/disable. Linked from AdminDashboard
// (admin-only backend routes now require MFA — see requireMfa() in
// middleware/roleCheck.js) but usable by any logged-in account.
export default function AccountSecurity() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Setup flow state
  const [setupData, setSetupData] = useState(null); // { secret, qrCodeDataUrl }
  const [setupCode, setSetupCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);

  // Disable flow state
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisableForm, setShowDisableForm] = useState(false);

  // Notification/localization preferences
  const [phone, setPhone] = useState(user?.phone || '');
  const [smsEnabled, setSmsEnabled] = useState(Boolean(user?.smsNotificationsEnabled));
  const [preferredLanguage, setPreferredLanguage] = useState(user?.preferredLanguage || 'en');
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await api.get('/auth/mfa/status');
      setStatus(res.data);
    } catch (e) {
      setError('Could not load your security settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function savePreferences(e) {
    e.preventDefault();
    setError('');
    setPrefsSaved(false);
    setPrefsSaving(true);
    try {
      await api.patch('/auth/me/preferences', {
        phone: phone || null,
        smsNotificationsEnabled: smsEnabled,
        preferredLanguage,
      });
      setPrefsSaved(true);
      await refreshUser();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save preferences');
    } finally {
      setPrefsSaving(false);
    }
  }

  async function startSetup() {
    setError('');
    try {
      const res = await api.post('/auth/mfa/setup');
      setSetupData(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not start setup');
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/auth/mfa/verify-setup', { code: setupCode, password: setupPassword });
      setBackupCodes(res.data.backupCodes);
      setSetupData(null);
      setSetupCode('');
      setSetupPassword('');
      await loadStatus();
      await refreshUser();
    } catch (e) {
      setError(e.response?.data?.error || 'That code did not work');
    }
  }

  async function disableMfa(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/mfa/disable', { password: disablePassword, code: disableCode });
      setShowDisableForm(false);
      setDisablePassword('');
      setDisableCode('');
      await loadStatus();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not disable MFA');
    }
  }

  if (loading) return <main className="section"><p>Loading…</p></main>;

  return (
    <main className="section">
      <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
        <h1>Account security</h1>
        {error && <div className="alert error">{error}</div>}

        {backupCodes ? (
          <>
            <div className="alert success">MFA is now enabled. Save these backup codes somewhere safe — each works once, and this is the only time they'll be shown.</div>
            <ul className="small" style={{ fontFamily: 'monospace', lineHeight: 1.8 }}>
              {backupCodes.map((code) => <li key={code}>{code}</li>)}
            </ul>
            <p className="muted small">Lost your phone and out of backup codes? Contact an administrator to have MFA reset on your account.</p>
          </>
        ) : status?.mfaEnabled ? (
          <>
            <p>Two-factor authentication is <b>enabled</b> on your account. {status.remainingBackupCodes} backup code{status.remainingBackupCodes === 1 ? '' : 's'} remaining.</p>
            {!showDisableForm ? (
              <button className="btn btn-light" onClick={() => setShowDisableForm(true)}>Disable MFA</button>
            ) : (
              <form onSubmit={disableMfa}>
                <label>Password</label>
                <input required type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
                <label>Authentication code</label>
                <input required type="text" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="123456 or backup code" />
                <button className="btn btn-danger mt" type="submit">Confirm disable</button>
                <button className="btn btn-light mt" type="button" onClick={() => setShowDisableForm(false)}>Cancel</button>
              </form>
            )}
          </>
        ) : setupData ? (
          <>
            <p>Scan this code with an authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code it shows.</p>
            <img src={setupData.qrCodeDataUrl} alt="MFA QR code" style={{ maxWidth: 220 }} />
            <p className="small muted">Can't scan? Enter this key manually: <code>{setupData.secret}</code></p>
            <form onSubmit={confirmSetup}>
              <label>Code from your app</label>
              <input required type="text" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="123456" />
              <label>Your password</label>
              <input required type="password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} />
              <button className="btn btn-primary mt" type="submit">Enable MFA</button>
              <button className="btn btn-light mt" type="button" onClick={() => setSetupData(null)}>Cancel</button>
            </form>
          </>
        ) : (
          <>
            <p>Two-factor authentication is <b>not enabled</b> on your account. Admin actions now require it.</p>
            <button className="btn btn-primary" onClick={startSetup}>Set up MFA</button>
          </>
        )}
      </div>

      <div className="card mt" style={{ maxWidth: 560, margin: '20px auto 0' }}>
        <h2>Notifications &amp; language</h2>
        <p className="muted small">SMS costs real money to send, so it's off until you turn it on — and requires a valid phone number on file.</p>
        <form onSubmit={savePreferences}>
          <label>Phone number</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09XXXXXXXX"
          />

          <label className="checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input
              type="checkbox"
              checked={smsEnabled}
              onChange={(e) => setSmsEnabled(e.target.checked)}
            />
            Send me SMS notifications for order updates
          </label>

          <label className="mt">Preferred language</label>
          <select value={preferredLanguage} onChange={(e) => setPreferredLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          {preferredLanguage !== 'en' && (
            <p className="small muted">
              Used for SMS text language. In-app screens are only fully translated in English right now — see the app's language switcher for what's available.
            </p>
          )}

          <button className="btn btn-primary mt" type="submit" disabled={prefsSaving}>
            {prefsSaving ? t('common.loading') : t('common.save')}
          </button>
          {prefsSaved && <span className="muted small" style={{ marginLeft: 10 }}>Saved.</span>}
        </form>
      </div>
    </main>
  );
}
