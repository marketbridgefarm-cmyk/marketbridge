import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

const fmt = (value) => {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

// Shows a truck owner / inspector their bidding standing and the way back:
// warning -> suspension (appeal) -> acknowledge & rejoin -> probation -> good.
export default function ProviderStandingBanner() {
  const [standing, setStanding] = useState(null);
  const [ack, setAck] = useState(false);
  const [appealText, setAppealText] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/provider-standing/me');
      setStanding(res.data?.standing || null);
    } catch {
      setStanding(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!standing) return null;
  const { status, strikes, threshold, ratingPenalty } = standing;
  const nothingToShow = status === 'GOOD' && strikes === 0 && !ratingPenalty;
  if (nothingToShow) return null;

  const act = async (key, fn) => {
    setBusy(key); setErr(''); setMsg('');
    try {
      const res = await fn();
      setMsg(res.data?.message || '');
      await load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setBusy('');
    }
  };

  const tone = status === 'SUSPENDED' || status === 'REJOIN_PENDING' ? 'danger' : 'warn';

  return (
    <section
      className="sd-card"
      role="status"
      style={{ borderLeft: `4px solid ${tone === 'danger' ? '#b3261e' : '#b26a00'}`, display: 'grid', gap: 8, marginBottom: 16 }}
    >
      {status === 'GOOD' && (
        <>
          <strong>Cancellation warning</strong>
          <p className="sd-muted" style={{ margin: 0 }}>
            You cancelled {strikes} accepted {strikes === 1 ? 'agreement' : 'agreements'} recently
            ({strikes} of {threshold} before a bidding suspension).
            {ratingPenalty > 0 ? ` Your rating is currently reduced by ${ratingPenalty.toFixed(1)}.` : ''}
          </p>
        </>
      )}

      {status === 'PROBATION' && (
        <>
          <strong>On probation until {fmt(standing.probationUntil)}</strong>
          <p className="sd-muted" style={{ margin: 0 }}>
            Cancelling an accepted agreement while on probation suspends your bidding again, for longer.
            Finish probation cleanly to return to good standing and recover half of your rating penalty.
          </p>
        </>
      )}

      {status === 'SUSPENDED' && (
        <>
          <strong>
            Bidding suspended{standing.suspendedUntil ? ` until ${fmt(standing.suspendedUntil)}` : ' until admin review'}
          </strong>
          <p className="sd-muted" style={{ margin: 0 }}>
            This happened because of repeated cancellations of accepted agreements. Your account, buying and selling are not affected.
            {standing.suspendedUntil
              ? ' When the period ends you can rejoin on probation.'
              : ' Admin must reinstate you before you can bid again.'}
          </p>
          {standing.appealMessage ? (
            <p className="sd-muted" style={{ margin: 0 }}>Appeal submitted — waiting for admin review.</p>
          ) : standing.canAppeal ? (
            <div style={{ display: 'grid', gap: 6 }}>
              <textarea
                rows={3}
                maxLength={1000}
                placeholder="Explain what happened (min. 10 characters)"
                value={appealText}
                onChange={(e) => setAppealText(e.target.value)}
              />
              <button
                type="button"
                className="sd-btn"
                disabled={busy === 'appeal' || appealText.trim().length < 10}
                onClick={() => act('appeal', () => api.post('/provider-standing/me/appeal', { message: appealText.trim() }))}
              >
                {busy === 'appeal' ? 'Sending…' : 'Appeal suspension'}
              </button>
            </div>
          ) : null}
        </>
      )}

      {status === 'REJOIN_PENDING' && (
        <>
          <strong>Your suspension has ended</strong>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span className="sd-muted">
              I will only accept agreements I can complete. I understand I will be on probation for {standing.probationDays} days,
              and that cancelling an accepted agreement during that time suspends me again for longer.
            </span>
          </label>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={!ack || busy === 'rejoin'}
            onClick={() => act('rejoin', () => api.post('/provider-standing/me/rejoin', { acknowledged: true }))}
          >
            {busy === 'rejoin' ? 'Rejoining…' : 'Rejoin on probation'}
          </button>
        </>
      )}

      {msg && <p style={{ margin: 0 }}>{msg}</p>}
      {err && <p style={{ margin: 0, color: '#b3261e' }}>{err}</p>}
    </section>
  );
}
