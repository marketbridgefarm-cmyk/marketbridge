import React, { useState } from 'react';

import { Button, useNowUntil } from './OrderDetailPrimitives.jsx';
import { formatDateTime } from './orderDetailUtils.js';

// ============================================================================
// ORDER DETAIL — RELEASE AGREEMENT CONTROL
// ============================================================================
//
// Shared UI used by both TransportCard and InspectionCard to release a
// provisional agreement. Extracted from OrderDetail.jsx so both cards can
// import it without duplicating the picker, timestamps, and reason list.
// ============================================================================

const RELEASE_AFTER_ACCEPT_HOURS = (() => {
  const configured = Number(import.meta?.env?.VITE_RELEASE_AFTER_ACCEPT_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

const RELEASE_REASONS = [
  ['PROVIDER_UNAVAILABLE', 'Provider is unavailable'],
  ['NO_RESPONSE', 'Provider is not responding'],
  ['PRICE_CHANGED', 'Provider changed the price'],
  ['SCHEDULE_CONFLICT', 'Schedule conflict'],
  ['OTHER', 'Other (add a note)'],
];

function acceptedReleaseAvailableAt(acceptedQuote) {
  if (!acceptedQuote) return null;
  const since = new Date(acceptedQuote.updatedAt || acceptedQuote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + RELEASE_AFTER_ACCEPT_HOURS * 60 * 60 * 1000);
}

export default function ReleaseAgreementControl({ acceptedQuote, label, busy, disabled, onConfirm }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const availableAt = acceptedReleaseAvailableAt(acceptedQuote);
  const now = useNowUntil(availableAt ? availableAt.getTime() : null);
  const locked = availableAt !== null && availableAt.getTime() > now;
  const needsNote = reason === 'OTHER';
  const canSubmit = Boolean(reason) && (!needsNote || note.trim().length > 0);

  if (locked) {
    return (
      <span className="muted small">
        Release opens {formatDateTime(availableAt)} ({RELEASE_AFTER_ACCEPT_HOURS}h after acceptance).
      </span>
    );
  }

  if (!open) {
    return (
      <Button variant="light" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="od-release-form">
      <label>
        Reason for releasing
        <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}>
          <option value="">Select a reason…</option>
          {RELEASE_REASONS.map(([value, text]) => (
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
      <p className="muted small">
        Each release is recorded against your account and visible to MarketBridge admin.
        After 2 releases on this job, further releases need admin review.
      </p>
      <div className="od-release-actions">
        <Button
          variant="light"
          size="sm"
          disabled={disabled || !canSubmit}
          busy={busy}
          busyText="Releasing…"
          onClick={async () => {
            const ok = await onConfirm(reason, note.trim());
            if (ok) { setOpen(false); setReason(''); setNote(''); }
          }}
        >
          Confirm release
        </Button>
        <Button variant="light" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
