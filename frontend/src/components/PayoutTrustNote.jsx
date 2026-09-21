import React from 'react';

// ============================================================================
// PAYOUT TRUST NOTE
// ============================================================================
// The seller/transporter/inspector payout cards used to tell a payee only
// "your payout is being held for 3 days" with no explanation of what that
// actually means for their money. That reads as evasive to someone waiting
// to get paid — it invites the question "held by whom, and why should I
// believe it's coming?" This renders the same honest, specific explanation
// for whichever role is looking at it: the payment has already been
// collected in full, the hold is a fixed rule applied identically to every
// payee on the platform (not a case-by-case decision about this person),
// it runs on a schedule with no action required, and the one thing that
// can change it — an order dispute — is spelled out rather than implied.
// ============================================================================

const ROLE_LABEL = {
  SELLER: 'seller',
  TRANSPORTER: 'transporter',
  INSPECTOR: 'inspector',
};

const PAYER_CONTEXT = {
  SELLER: "the buyer's marketplace payment",
  TRANSPORTER: "the buyer's transport payment",
  INSPECTOR: 'the inspection payment',
};

export default function PayoutTrustNote({ role, isPayee, status, timeRemainingText, releaseDateText }) {
  const roleLabel = ROLE_LABEL[role] || 'payee';
  const paymentLabel = PAYER_CONTEXT[role] || 'the relevant payment';

  if (!status) {
    return (
      <div className="notice" style={{ marginTop: 14 }}>
        <strong>{isPayee ? "You haven't been marked for payout on this order yet." : `The ${roleLabel} payout hold starts after ${paymentLabel} settles.`}</strong>
        <p className="muted" style={{ marginBottom: 0, marginTop: 4 }}>
          Once {paymentLabel} is confirmed, this payout enters a fixed 3-day hold — the same window applied to every {roleLabel} on MarketBridge, not a decision made about this order specifically — before it becomes eligible for payout processing.
        </p>
      </div>
    );
  }

  if (status === 'HELD') {
    return (
      <div className="notice" style={{ marginTop: 14 }}>
        <strong>
          {isPayee
            ? 'This money has already been collected — the hold is a fixed clock, not a decision.'
            : `The ${roleLabel} payout is currently held.`}
        </strong>
        <p className="muted" style={{ marginBottom: 0, marginTop: 4 }}>
          {isPayee ? (
            <>
              MarketBridge already collected {paymentLabel} in full. This 3-day hold runs
              automatically on every {roleLabel} payout on the platform — nobody reviews or
              approves it case by case. It will flip to released
              {timeRemainingText ? <> {timeRemainingText}</> : null}
              {releaseDateText ? <> ({releaseDateText})</> : null}, with no action needed from you,
              unless a dispute is opened on this order before then. You can check back here any time —
              this status is always current.
            </>
          ) : (
            <>
              {paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1)} has settled, but the
              {` ${roleLabel} `}payout remains in the standard post-payment hold
              {timeRemainingText ? <> for {timeRemainingText}</> : null} before it can be released.
            </>
          )}
        </p>
      </div>
    );
  }

  if (status === 'ON_HOLD_DISPUTE') {
    return (
      <div className="alert" style={{ marginTop: 14 }}>
        <strong>
          {isPayee ? 'A dispute on this order has paused your payout.' : `The ${roleLabel} payout is frozen while this dispute is open.`}
        </strong>
        <p className="muted" style={{ marginBottom: 0, marginTop: 4 }}>
          {isPayee ? (
            <>
              This isn't a judgment against you — every payout tied to a disputed order is
              automatically paused the moment a dispute is raised, so nothing can be paid out while
              an admin is still reviewing what happened. If the dispute resolves in your favor, a
              fresh 3-day hold starts from the resolution time (not from today) — the same restart
              every payee gets, so the process stays consistent regardless of who was affected.
            </>
          ) : (
            <>If the dispute is resolved in the {roleLabel}'s favor, a fresh 3-day hold period starts from the resolution time.</>
          )}
        </p>
      </div>
    );
  }

  if (status === 'RELEASED') {
    return (
      <div className="notice" style={{ marginTop: 14 }}>
        <strong>{isPayee ? 'Your payout has cleared the hold.' : `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} payout released for payout processing.`}</strong>
        <p className="muted" style={{ marginBottom: 0, marginTop: 4 }}>
          {isPayee ? (
            <>
              The 3-day window is over and no dispute was raised. The one remaining step is the
              actual transfer to your bank or mobile-money account, which MarketBridge's operations
              team sends manually — this page will show "Paid out" with a reference number once
              that transfer is confirmed.
            </>
          ) : (
            <>The hold period has ended. The payout still requires the operational payout step before it's marked paid out.</>
          )}
        </p>
      </div>
    );
  }

  if (status === 'CANCELLED') {
    return (
      <div className="alert" style={{ marginTop: 14 }}>
        <strong>{isPayee ? 'This payout was cancelled after the dispute was resolved.' : `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} payout was cancelled after dispute resolution.`}</strong>
        <p className="muted" style={{ marginBottom: 0, marginTop: 4 }}>
          {isPayee ? (
            <>
              An admin resolved the dispute on this order against you, so this specific payout will
              not be released. This is a final decision tied to that dispute's record, not an
              automatic or reversible step — if you believe the resolution was wrong, that dispute
              record is where to raise it.
            </>
          ) : (
            <>The payout will not be released. Any refund or replacement financial action follows the dispute resolution record.</>
          )}
        </p>
      </div>
    );
  }

  if (status === 'PAID_OUT') {
    return (
      <div className="notice" style={{ marginTop: 14 }}>
        <strong>{isPayee ? 'Paid — this payout has been sent to you.' : `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} payout has been paid out.`}</strong>
      </div>
    );
  }

  return null;
}
