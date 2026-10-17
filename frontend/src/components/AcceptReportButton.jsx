import React, { useState } from 'react';
import api from '../api/client';

// Buyer taps once to accept the inspection report. That releases the
// inspector's fee from escrow immediately; otherwise it is released
// automatically when the review window ends.
export default function AcceptReportButton({ requestId, accepted, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (accepted || done) {
    return <p className="iap-state iap-state--ok">✓ Report accepted. The inspector&apos;s fee has been released.</p>;
  }

  async function accept() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/inspections/${requestId}/report/accept`);
      setDone(true);
      if (onChanged) onChanged();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not accept the report. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="muted small">
        The inspector&apos;s fee is held in escrow until you accept the report or the review period ends (then it is released automatically).
        If something looks wrong, raise a dispute <em>before</em> accepting.
      </p>
      <button type="button" className="btn btn-primary" onClick={accept} disabled={busy}>
        {busy ? 'Accepting…' : 'Accept report and release fee'}
      </button>
      {error && <p className="iap-error">{error}</p>}
    </div>
  );
}
