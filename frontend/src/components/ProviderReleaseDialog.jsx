import React, { useEffect, useState } from 'react';

// Reason picker for a truck owner / inspector cancelling a provisional
// (accepted) agreement before payment. Reason codes mirror
// PROVIDER_RELEASE_REASONS in backend/src/services/releaseLimitsService.js.
export const PROVIDER_RELEASE_REASONS = [
  ['VEHICLE_OR_EQUIPMENT_ISSUE', 'Vehicle or equipment problem'],
  ['SCHEDULE_CONFLICT', 'Schedule conflict'],
  ['PRICE_NOT_VIABLE', 'Agreed price is no longer workable'],
  ['REQUESTER_UNRESPONSIVE', 'Requester is not responding'],
  ['SITE_OR_ROUTE_ISSUE', 'Site or route is not accessible'],
  ['OTHER', 'Other (add a note)'],
];

export default function ProviderReleaseDialog({
  open,
  serviceLabel = 'agreement',
  busy = false,
  onConfirm,
  onClose,
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);

  if (!open) return null;

  const needsNote = reason === 'OTHER';
  const canSubmit = Boolean(reason) && (!needsNote || note.trim().length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Cancel provisional ${serviceLabel}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 1000,
      }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="sd-card"
        style={{ maxWidth: 420, width: '100%', display: 'grid', gap: 12, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0 }}>Cancel provisional {serviceLabel}?</h3>
        <p className="sd-muted" style={{ margin: 0 }}>
          The requester will be notified and can choose someone else. You
          won&apos;t be able to bid on this job again. Cancellations are
          recorded, and frequent cancellations are reviewed by MarketBridge
          admin.
        </p>

        <label style={{ display: 'grid', gap: 4 }}>
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}>
            <option value="">Select a reason…</option>
            {PROVIDER_RELEASE_REASONS.map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        </label>

        {needsNote && (
          <input
            type="text"
            maxLength={200}
            placeholder="Short note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="sd-btn" disabled={busy} onClick={onClose}>
            Keep agreement
          </button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy || !canSubmit}
            onClick={() => onConfirm({ reason, note: note.trim() })}
          >
            {busy ? 'Cancelling…' : 'Cancel agreement'}
          </button>
        </div>
      </div>
    </div>
  );
}
