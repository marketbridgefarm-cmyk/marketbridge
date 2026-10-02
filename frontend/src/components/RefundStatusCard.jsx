import React from 'react';

// ============================================================================
// REFUND STATUS CARD
// ============================================================================
// Follows the payout card. A payout that is HELD gets frozen when a dispute
// is raised (ON_HOLD_DISPUTE). If the admin chooses CANCEL, the entire order
// is cancelled, all unpaid payouts are cancelled, and already-paid buyer
// payments enter the real refund workflow. This card shows that journey:
//
//   Payout held -> Refund requested -> Processing -> Refunded
//
// It only renders when there is something to show: an open refund, or a
// payout frozen by a dispute. Normal orders never see it.
//
// Refunds are full-payment refunds (one per payment: goods, transport,
// inspection), so each row lines up with a party in the payout card.
// The backend gives no refund ETA, so none is shown — only real dates.
//
// Visual note: the card head, the 4-step track, and the reason footnote are
// inline-styled so the card renders flat and correctly even when only the
// page-level stylesheet is loaded.
// ============================================================================

const ROLE_ORDER = { SELLER: 0, INSPECTOR: 1, TRANSPORTER: 2 };
const ROLE_LABEL = { SELLER: 'Seller', INSPECTOR: 'Inspector', TRANSPORTER: 'Transporter' };

const statusBadge = (status) => {
  switch (status) {
    case 'REQUESTED':  return { label: 'Requested',  tone: 'wait'    };
    case 'PROCESSING': return { label: 'Processing', tone: 'wait'    };
    case 'COMPLETED':  return { label: 'Refunded',   tone: 'good'    };
    case 'FAILED':     return { label: 'Failed',     tone: 'bad'     };
    default:           return { label: String(status || '').replace(/_/g, ' '), tone: 'neutral' };
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

/* ── Inline style objects ─────────────────────────────────── */

const styles = {
  cardHead: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: 16,
    paddingBottom: 16,
    marginBottom: 20,
    borderBottom: '1px solid #e5e9ef',
  },
  headMain: { minWidth: 0 },
  eyebrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: '#12734a',
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.16em',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  eyebrowLine: {
    display: 'inline-block',
    width: 18,
    height: 2,
    borderRadius: 2,
    background: 'currentColor',
  },
  title: {
    margin: 0,
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 19,
    fontWeight: 800,
    letterSpacing: '-.4px',
    lineHeight: 1.22,
    color: '#0d1b2a',
  },
  intro: {
    margin: '0 0 4px',
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 13.5,
    lineHeight: 1.6,
    color: '#64748b',
  },
  trackWrap: {
    listStyle: 'none',
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 0,
    padding: '16px 4px 0',
    margin: '18px 0 0',
    borderTop: '1px solid #e5e9ef',
  },
  trackStep: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    textAlign: 'center',
    minWidth: 0,
  },
  trackLabel: {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 10.5,
    fontWeight: 600,
    lineHeight: 1.3,
    color: '#94a3b8',
    maxWidth: 90,
  },
  trackLabelCurrent: { color: '#0f7a44', fontWeight: 700 },
  trackLabelComplete: { color: '#2c3a4a' },
  trackLabelFailed: { color: '#b42318', fontWeight: 700 },
  trackNote: {
    display: 'block',
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 10,
    lineHeight: 1.3,
    color: '#94a3b8',
    fontVariantNumeric: 'tabular-nums',
    marginTop: -4,
  },
  reason: {
    margin: '16px 0 0',
    paddingTop: 14,
    borderTop: '1px solid #eef1f5',
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 12.5,
    lineHeight: 1.55,
    color: '#64748b',
  },
  failureNote: {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 11.5,
    lineHeight: 1.4,
    color: '#b42318',
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  totalLabel: {
    padding: '14px 0',
    textAlign: 'left',
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: '-.1px',
    color: '#0d1b2a',
    borderTop: '1px solid #e5e9ef',
  },
  totalAmount: {
    padding: '14px 0',
    textAlign: 'right',
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 15,
    fontWeight: 800,
    letterSpacing: '-.2px',
    color: '#0d1b2a',
    fontVariantNumeric: 'tabular-nums',
    borderTop: '1px solid #e5e9ef',
  },
  totalEmpty: {
    padding: '14px 0',
    borderTop: '1px solid #e5e9ef',
  },
};

const dotStyle = (state) => {
  const base = {
    width: 16,
    height: 16,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    zIndex: 1,
    flex: '0 0 auto',
    background: '#fff',
    border: '2px solid #e5e9ef',
    boxSizing: 'border-box',
  };
  if (state === 'is-complete') {
    return { ...base, background: '#1e9e5a', borderColor: '#1e9e5a', color: '#fff' };
  }
  if (state === 'is-current') {
    return { ...base, background: '#fff', borderColor: '#1e9e5a', boxShadow: '0 0 0 4px rgba(30,158,90,.16)' };
  }
  if (state === 'is-failed') {
    return { ...base, background: '#fff', borderColor: '#b42318', boxShadow: '0 0 0 4px rgba(180,35,24,.16)' };
  }
  return base;
};

const connectorStyle = (prevState) => ({
  position: 'absolute',
  top: 7,
  right: '50%',
  left: '-50%',
  height: 2,
  background: prevState === 'is-complete' ? '#1e9e5a' : '#e5e9ef',
  zIndex: 0,
});

const labelStyleFor = (state) => {
  if (state === 'is-current') return { ...styles.trackLabel, ...styles.trackLabelCurrent };
  if (state === 'is-complete') return { ...styles.trackLabel, ...styles.trackLabelComplete };
  if (state === 'is-failed') return { ...styles.trackLabel, ...styles.trackLabelFailed };
  return styles.trackLabel;
};

export default function RefundStatusCard({
  refunds,
  payouts,
  people,
  isAdmin,
  busy,
  onComplete,
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

  const anyPaidOut = (Array.isArray(payouts) ? payouts : []).some(
    (payout) => payout.status === 'PAID_OUT'
  );

  /* ---- Where are we in the journey? ------------------------------------- */
  const anyFailed = rows.some((r) => r.status === 'FAILED');
  const allDone = rows.length > 0 && rows.every((r) => r.status === 'COMPLETED');

  let current;
  if (rows.length === 0) current = 0;
  else if (allDone) current = 4;
  else if (anyFailed) current = 2;
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

  /* ---- Copy ------------------------------------------------------------- */
  let intro;
  if (rows.length === 0) {
    intro =
      'A dispute is open, so the order is frozen: payments, transport, inspection and payouts cannot proceed until an admin resolves it.';
  } else if (allDone) {
    intro = 'The buyer’s payment has been refunded in full.';
  } else if (anyFailed) {
    intro = 'A refund could not be completed and needs review by MarketBridge support.';
  } else if (anyPaidOut) {
    intro =
      'The buyer’s payment is being refunded in full. A payout that was already sent to a payee cannot be reversed here and needs follow-up by MarketBridge support.';
  } else {
    intro =
      'The disputed order was cancelled. Already-paid buyer payments are being refunded; the refund is complete once Chapa confirms each refund.';
  }

  /* ---- Table numbers ---------------------------------------------------- */
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
      {/* ── Card head ──────────────────────────────────── */}
      <header style={styles.cardHead}>
        <div style={styles.headMain}>
          <span style={styles.eyebrow}>
            <span style={styles.eyebrowLine} aria-hidden="true" />
            Refunds
          </span>
          <h2 style={styles.title}>Refund Status</h2>
        </div>
      </header>

      {/* ── Intro ─────────────────────────────────────── */}
      <p style={styles.intro}>{intro}</p>

      {/* ── 4-step track ──────────────────────────────── */}
      <ol style={styles.trackWrap} aria-label="Refund progress">
        {steps.map((step, i) => (
          <li
            key={step.label}
            style={styles.trackStep}
            aria-current={step.state === 'is-current' || step.state === 'is-failed' ? 'step' : undefined}
          >
            {i > 0 && (
              <span
                style={connectorStyle(steps[i - 1]?.state)}
                aria-hidden="true"
              />
            )}
            <span style={dotStyle(step.state)} aria-hidden="true">
              {step.state === 'is-complete' && (
                <span style={{ fontSize: 10, fontWeight: 800, lineHeight: 1, color: '#fff' }}>✓</span>
              )}
              {step.state === 'is-current' && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#1e9e5a',
                    display: 'block',
                  }}
                />
              )}
              {step.state === 'is-failed' && (
                <span style={{ fontSize: 10, fontWeight: 800, lineHeight: 1, color: '#b42318' }}>!</span>
              )}
            </span>
            <span style={labelStyleFor(step.state)}>{step.label}</span>
            {step.note && <span style={styles.trackNote}>{step.note}</span>}
          </li>
        ))}
      </ol>

      {/* ── Table ─────────────────────────────────────── */}
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
              const open = ['REQUESTED', 'PROCESSING', 'FAILED'].includes(refund.status);
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
                        <span className="payout-party-note" style={styles.failureNote}>
                          Failed: {refund.failureReason}
                        </span>
                      )}

                      {isAdmin && open && (
                        <span style={styles.actionsRow}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={Boolean(busy)}
                            onClick={() => onComplete(refund)}
                          >
                            {working
                              ? 'Working…'
                              : refund.status === 'PROCESSING'
                              ? 'Check Chapa status'
                              : refund.status === 'FAILED'
                              ? 'Retry with Chapa'
                              : 'Process with Chapa'}
                          </button>
                          {refund.status !== 'PROCESSING' && (
                            <button
                              type="button"
                              className="btn btn-light btn-sm"
                              disabled={Boolean(busy)}
                              onClick={() => onFail(refund)}
                            >
                              Mark failed
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                  <td className="payout-amount">
                    {amountText(refund.amount)}
                    {currency && <span className="payout-currency">{currency}</span>}
                  </td>
                  <td className="payout-status">
                    <span className={`od-status-pill od-tone-${badge.tone}`}>{badge.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 1 && singleCurrency && (
            <tfoot>
              <tr>
                <th scope="row" style={styles.totalLabel}>Total refund</th>
                <td style={styles.totalAmount}>{amountText(total)} ETB</td>
                <td style={styles.totalEmpty} />
              </tr>
            </tfoot>
          )}
        </table>
      )}

      {/* ── Reason ────────────────────────────────────── */}
      {reason && <p style={styles.reason}>Reason: {reason}</p>}
    </div>
  );
}
