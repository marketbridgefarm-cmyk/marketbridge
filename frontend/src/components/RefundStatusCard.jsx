import React from 'react';

// ============================================================================
// REFUND STATUS CARD
// ============================================================================
// Follows the payout card. A payout that is HELD gets frozen when a dispute
// is raised (ON_HOLD_DISPUTE); if the dispute is resolved against the payee
// the payout is cancelled and the buyer's payment is refunded. This card
// shows that journey:
//
//   Payout held -> Refund requested -> Processing -> Refunded
//
// It only renders when there is something to show: an open refund, or a
// payout frozen by a dispute. Normal orders never see it.
//
// Refunds are full-payment refunds (one per payment: goods, transport,
// inspection), so each row lines up with a party in the payout card.
// The backend gives no refund ETA, so none is shown — only real dates.
// ============================================================================

const ROLE_ORDER = { SELLER: 0, INSPECTOR: 1, TRANSPORTER: 2 };
const ROLE_LABEL = { SELLER: 'Seller', INSPECTOR: 'Inspector', TRANSPORTER: 'Transporter' };

const statusBadge = (status) => {
  switch (status) {
    case 'REQUESTED':
      return { label: 'Requested', tone: 'tone-wait' };
    case 'PROCESSING':
      return { label: 'Processing', tone: 'tone-wait' };
    case 'COMPLETED':
      return { label: 'Refunded', tone: 'tone-good' };
    case 'FAILED':
      return { label: 'Failed', tone: 'tone-bad' };
    default:
      return { label: String(status || '').replace(/_/g, ' '), tone: 'tone-neutral' };
  }
};

const shortDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const shortDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

export default function RefundStatusCard({
  refunds,
  payouts,
  people,
  isAdmin,
  busy,
  onProcess,
  onVerify,
  onFail,
}) {
  const rows = (Array.isArray(refunds) ? refunds : [])
    .filter((refund) => refund.status !== 'CANCELLED')
    .sort(
      (a, b) =>
        (ROLE_ORDER[a.payeeRole] ?? 9) - (ROLE_ORDER[b.payeeRole] ?? 9) ||
        new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime()
    );

  const payoutFrozen = (Array.isArray(payouts) ? payouts : []).some(
    (payout) => payout.status === 'ON_HOLD_DISPUTE'
  );

  if (rows.length === 0 && !payoutFrozen) return null;

  // A payout that already left the platform can't be undone from here.
  const anyPaidOut = (Array.isArray(payouts) ? payouts : []).some(
    (payout) => payout.status === 'PAID_OUT'
  );

  // ---- Where are we in the journey? ---------------------------------------
  const anyFailed = rows.some((r) => r.status === 'FAILED');
  const allDone = rows.length > 0 && rows.every((r) => r.status === 'COMPLETED');

  let current;
  if (rows.length === 0) current = 0; // payout still held (frozen by dispute)
  else if (allDone) current = 4; // every step finished
  else if (anyFailed) current = 2; // stuck at the processing step
  else if (rows.some((r) => r.status === 'REQUESTED')) current = 1;
  else current = 2;

  const requestedAt = rows.length
    ? rows.map((r) => new Date(r.requestedAt).getTime()).filter((t) => !Number.isNaN(t))
    : [];
  const completedAt = allDone
    ? rows.map((r) => new Date(r.completedAt).getTime()).filter((t) => !Number.isNaN(t))
    : [];

  const steps = [
    {
      label: 'Payout held',
      note: current === 0 ? 'Dispute review' : anyPaidOut ? 'Some paid out' : 'Cancelled',
    },
    {
      label: 'Refund requested',
      note: requestedAt.length ? shortDate(Math.min(...requestedAt)) : null,
    },
    {
      label: anyFailed ? 'Refund failed' : 'Processing',
      note: null,
    },
    {
      label: 'Refunded',
      note: completedAt.length ? shortDate(Math.max(...completedAt)) : null,
    },
  ].map((step, index) => {
    let state = 'is-pending';
    if (index < current) state = 'is-complete';
    else if (index === current) state = index === 2 && anyFailed ? 'is-failed' : 'is-current';
    return { ...step, state };
  });

  // ---- Copy ---------------------------------------------------------------
  let intro;
  if (rows.length === 0) {
    intro =
      'A dispute is open, so every payout is frozen. If it is resolved in the buyer’s favour, the payout is cancelled and the buyer’s payment is refunded.';
  } else if (allDone) {
    intro = 'The buyer’s payment has been refunded in full.';
  } else if (anyFailed) {
    intro = 'A refund could not be completed and needs review by MarketBridge support.';
  } else if (anyPaidOut) {
    intro =
      'The buyer’s payment is being refunded in full. A payout that was already sent to a payee cannot be reversed here and needs follow-up by MarketBridge support.';
  } else {
    intro =
      'The payout was cancelled and the buyer’s payment is being refunded in full. The refund is complete once it has been processed.';
  }

  // ---- Table numbers ------------------------------------------------------
  const anyFraction = rows.some((r) => r.amount != null && Number(r.amount) % 1 !== 0);
  const amountText = (value) =>
    Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: anyFraction ? 2 : 0,
      maximumFractionDigits: 2,
    });

  const singleCurrency = rows.every((r) => (r.currency || 'ETB') === 'ETB');
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const reason = rows.find((r) => r.reason)?.reason || null;

  return (
    <div className="card refund-summary-card" id="order-refund-status">
      <h2>Refund Status</h2>

      <p className="payout-intro">{intro}</p>

      <ol className="refund-track" aria-label="Refund progress">
        {steps.map((step) => (
          <li
            key={step.label}
            className={`refund-track-step ${step.state}`}
            aria-current={step.state === 'is-current' || step.state === 'is-failed' ? 'step' : undefined}
          >
            <span className="refund-track-dot" aria-hidden="true" />
            <span className="refund-track-label">{step.label}</span>
            {step.note && <span className="refund-track-note">{step.note}</span>}
          </li>
        ))}
      </ol>

      {rows.length > 0 && (
        <table className="payout-table refund-table">
          <thead>
            <tr>
              <th scope="col">Parties</th>
              <th scope="col" className="payout-amount-col">Refund (ETB)</th>
              <th scope="col" className="payout-status-col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((refund) => {
              const person = people?.[refund.payeeRole] || {};
              const badge = statusBadge(refund.status);
              const currency = refund.currency && refund.currency !== 'ETB' ? refund.currency : null;
              const open = refund.status === 'REQUESTED' || refund.status === 'PROCESSING';
              const working = busy === `refund-${refund.id}`;

              return (
                <tr key={refund.id}>
                  <th scope="row" className="payout-party">
                    <div className="payout-party-body">
                      <span className="payout-party-line">
                        <span className="payout-party-role">
                          {ROLE_LABEL[refund.payeeRole] || 'Payment'}
                        </span>
                        {person.name && <span className="payout-party-name">({person.name})</span>}
                        {person.you && <span className="party-you">You</span>}
                      </span>

                      {refund.status === 'COMPLETED' && refund.completedAt ? (
                        <span className="payout-party-note">
                          Refunded {shortDateTime(refund.completedAt)}
                        </span>
                      ) : (
                        <span className="payout-party-note">
                          Requested {shortDateTime(refund.requestedAt)}
                        </span>
                      )}

                      {isAdmin && refund.status === 'FAILED' && refund.failureReason && (
                        <span className="payout-party-note refund-failure">
                          Failed: {refund.failureReason}
                        </span>
                      )}

                      {isAdmin && open && (
                        <span className="refund-actions">
                          {refund.status === 'REQUESTED' ? (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={Boolean(busy)}
                              onClick={() => onProcess(refund)}
                            >
                              {working ? 'Submitting…' : 'Process with Chapa'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={Boolean(busy)}
                              onClick={() => onVerify(refund)}
                            >
                              {working ? 'Checking…' : 'Check Chapa status'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-light btn-sm"
                            disabled={Boolean(busy)}
                            onClick={() => onFail(refund)}
                          >
                            Mark failed
                          </button>
                        </span>
                      )}
                    </div>
                  </th>
                  <td className="payout-amount">
                    {amountText(refund.amount)}
                    {currency && <span className="payout-currency">{currency}</span>}
                  </td>
                  <td className="payout-status">
                    <span className={`status-pill ${badge.tone}`}>{badge.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 1 && singleCurrency && (
            <tfoot>
              <tr>
                <th scope="row" className="refund-total-label">Total refund</th>
                <td className="payout-amount refund-total-amount">{amountText(total)}</td>
                <td className="payout-status" />
              </tr>
            </tfoot>
          )}
        </table>
      )}

      {reason && <p className="refund-reason">Reason: {reason}</p>}
    </div>
  );
}
