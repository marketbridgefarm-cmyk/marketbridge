import React, { useState } from 'react';

// ============================================================================
// PAYMENT CENTER
// ============================================================================
// Single source of truth for "what does this order still owe, and how do I
// pay it". Presentational only — every gating decision is computed in
// OrderDetail.jsx; this file renders the result and wires up the handlers.
//
// Styles are inlined below as a <style> block so this component is
// self-contained and doesn't depend on PaymentCenter.css.
// ============================================================================

const money = (value) =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const PAYMENT_CENTER_CSS = `
  .payment-center {
    --pc-accent:      #1e9e5a;
    --pc-accent-2:    #0f7a44;
    --pc-accent-ink:  #12734a;
    --pc-accent-soft: #ecfdf3;
    --pc-accent-line: #c6eccf;

    --pc-ink:         #0d1b2a;
    --pc-ink-soft:    #2c3a4a;
    --pc-muted:       #64748b;
    --pc-muted-2:     #94a3b8;

    --pc-line:        #e5e9ef;
    --pc-line-soft:   #eef1f5;

    --pc-gold:        #a86f10;
    --pc-gold-soft:   #fdf6e7;
    --pc-gold-line:   #f4e0b6;

    --pc-danger:      #b42318;
    --pc-danger-soft: #fef2f2;
    --pc-danger-line: #fecaca;

    --pc-info:        #1e5fa8;
    --pc-info-soft:   #eff5fd;
    --pc-info-line:   #cddff5;

    --pc-ring:        0 0 0 3px rgba(30, 158, 90, .18);
    --pc-ease:        cubic-bezier(.2, .7, .3, 1);
  }

  .payment-center .pc-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 16px;
    padding: 0 0 16px;
    margin: 0 0 18px;
    border-bottom: 1px solid var(--pc-line);
  }

  .payment-center .pc-head-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
  }

  .payment-center .pc-head-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    min-width: 0;
    max-width: 180px;
    text-align: right;
  }

  .payment-center .pc-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--pc-accent-ink);
    font: 700 11px/1 var(--mb-font-body, 'DM Sans', system-ui, sans-serif);
    letter-spacing: .16em;
    text-transform: uppercase;
  }

  .payment-center .pc-eyebrow::before {
    content: '';
    flex: 0 0 18px;
    height: 2px;
    border-radius: 2px;
    background: currentColor;
  }

  .payment-center .pc-title {
    margin: 0;
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -.4px;
    line-height: 1.22;
    color: var(--pc-ink);
    overflow-wrap: anywhere;
  }

  .payment-center .pc-side-label {
    font: 700 10.5px/1 var(--mb-font-body, 'DM Sans', system-ui, sans-serif);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--pc-accent-2);
  }

  .payment-center .pc-chip {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--pc-line-soft);
    color: var(--pc-ink-soft);
    font: 700 10.5px/1 var(--mb-font-body, 'DM Sans', system-ui, sans-serif);
    letter-spacing: .06em;
    text-transform: uppercase;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .payment-center .pc-chip--good {
    background: var(--pc-accent-soft);
    border-color: var(--pc-accent-line);
    color: var(--pc-accent-ink);
  }

  .payment-center .pc-chip--wait {
    background: var(--pc-gold-soft);
    border-color: var(--pc-gold-line);
    color: var(--pc-gold);
  }

  .payment-center .pc-chip--bad {
    background: var(--pc-danger-soft);
    border-color: var(--pc-danger-line);
    color: var(--pc-danger);
  }

  .payment-center .pc-chip--neutral {
    background: var(--pc-line-soft);
    border-color: var(--pc-line);
    color: var(--pc-muted);
  }

  .payment-center .pc-rows {
    display: flex;
    flex-direction: column;
    margin: 0;
  }

  .payment-center .pc-row {
    padding: 16px 0;
    margin: 0;
    border-bottom: 1px solid var(--pc-line-soft);
    background: transparent;
  }

  .payment-center .pc-row:last-child { border-bottom: none; }

  .payment-center .pc-row-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .payment-center .pc-row-head-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .payment-center .pc-row-title {
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 14.5px;
    font-weight: 800;
    letter-spacing: -.15px;
    line-height: 1.3;
    color: var(--pc-ink);
    overflow-wrap: anywhere;
  }

  .payment-center .pc-row-sub {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--pc-muted);
  }

  .payment-center .pc-row-note {
    margin: 8px 0 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--pc-muted);
  }

  .payment-center .pc-row-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 12px 0 0;
  }

  .payment-center .pc-installments {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 12px 0 0;
    border-top: 1px solid var(--pc-line-soft);
  }

  .payment-center .pc-installment {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 0;
    border-bottom: 1px solid var(--pc-line-soft);
  }

  .payment-center .pc-installment:last-child { border-bottom: none; }

  .payment-center .pc-installment-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .payment-center .pc-installment-info strong {
    font-family: var(--mb-font-body, 'DM Sans', sans-serif);
    font-size: 13px;
    font-weight: 700;
    color: var(--pc-ink);
    letter-spacing: -.05em;
  }

  .payment-center .pc-installment-amount {
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 13px;
    font-weight: 800;
    color: var(--pc-ink);
    letter-spacing: -.15px;
    font-variant-numeric: tabular-nums;
  }

  .payment-center .pc-alert {
    padding: 12px 0 12px 14px;
    margin: 12px 0;
    border: none;
    border-left: 3px solid var(--pc-accent-line);
    background: transparent;
    color: var(--pc-ink-soft);
    font-size: 13px;
    line-height: 1.6;
  }

  .payment-center .pc-alert p {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--pc-ink-soft);
  }

  .payment-center .pc-alert strong {
    display: block;
    font-weight: 800;
    color: var(--pc-ink);
  }

  .payment-center .pc-alert--info { border-left-color: var(--pc-info); }
  .payment-center .pc-alert--error {
    border-left-color: var(--pc-danger);
    color: var(--pc-danger);
  }
  .payment-center .pc-alert--error strong { color: var(--pc-danger); }

  .payment-center .pc-field {
    display: block;
    min-width: 180px;
    max-width: 240px;
    height: 40px;
    padding: 0 34px 0 14px;
    border: 1px solid var(--pc-line);
    border-radius: 10px;
    background: #fff;
    color: var(--pc-ink);
    font: inherit;
    font-size: 13.5px;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    transition: border-color .18s var(--pc-ease), box-shadow .18s var(--pc-ease);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8' fill='none'><path d='M1 1l5 5 5-5' stroke='%2394a3b8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 10px 7px;
  }

  .payment-center .pc-field:focus {
    outline: none;
    border-color: var(--pc-accent);
    box-shadow: var(--pc-ring);
  }

  .payment-center .pc-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 38px;
    padding: 0 16px;
    border-radius: 10px;
    border: 1px solid var(--pc-line);
    background: #fff;
    color: var(--pc-ink);
    font: 700 13px/1 var(--mb-font-body, 'DM Sans', system-ui, sans-serif);
    letter-spacing: .01em;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color .15s var(--pc-ease),
                background .15s var(--pc-ease),
                color .15s var(--pc-ease),
                box-shadow .15s var(--pc-ease);
  }

  .payment-center .pc-btn:hover:not(:disabled) {
    border-color: var(--pc-accent);
    background: var(--pc-accent-soft);
    color: var(--pc-accent-2);
  }

  .payment-center .pc-btn:focus-visible { outline: none; box-shadow: var(--pc-ring); }
  .payment-center .pc-btn:disabled { opacity: .55; cursor: not-allowed; }

  .payment-center .pc-btn--primary {
    background: #fff;
    color: var(--pc-accent-2);
    border-color: var(--pc-accent-line);
  }

  .payment-center .pc-btn--primary:hover:not(:disabled) {
    background: var(--pc-accent-soft);
    color: var(--pc-accent-ink);
    border-color: var(--pc-accent);
    box-shadow: 0 1px 2px rgba(30, 158, 90, .12);
  }

  .payment-center .pc-btn--outline {
    background: #fff;
    color: var(--pc-accent-2);
    border-color: var(--pc-line);
  }

  .payment-center .pc-btn--outline:hover:not(:disabled) {
    background: var(--pc-accent-soft);
    color: var(--pc-accent-ink);
    border-color: var(--pc-accent);
  }

  .payment-center .pc-own-truck,
  .payment-center .pc-not-buyer {
    margin: 4px 0 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--pc-muted);
  }

  .payment-center .pc-history {
    margin: 18px 0 0;
    padding: 16px 0 0;
    border-top: 1px solid var(--pc-line);
  }

  .payment-center .pc-history-list {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .payment-center .pc-history-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 0;
    border-bottom: 1px solid var(--pc-line-soft);
  }

  .payment-center .pc-history-row:last-child { border-bottom: none; }

  .payment-center .pc-history-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .payment-center .pc-history-type {
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 13.5px;
    font-weight: 800;
    letter-spacing: -.1px;
    color: var(--pc-ink);
    text-transform: capitalize;
  }

  .payment-center .pc-history-meta {
    font-size: 12px;
    line-height: 1.5;
    color: var(--pc-muted);
    font-variant-numeric: tabular-nums;
  }

  .payment-center .pc-history-side {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }

  .payment-center .pc-history-amount {
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 14px;
    font-weight: 800;
    letter-spacing: -.15px;
    color: var(--pc-ink);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .payment-center .pc-notice {
    margin: 18px 0 0;
    padding: 14px 0 0;
    border-top: 1px solid var(--pc-line);
    font-size: 13px;
    line-height: 1.6;
    color: var(--pc-ink-soft);
  }

  .payment-center .pc-notice-prefix {
    font-family: var(--mb-font-head, Manrope, sans-serif);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--pc-accent-2);
    margin-right: 4px;
  }

  @media (max-width: 719px) {
    .payment-center .pc-head { column-gap: 12px; }
    .payment-center .pc-head-side { max-width: 140px; }
    .payment-center .pc-title { font-size: 17px; }
    .payment-center .pc-row { padding: 14px 0; }
    .payment-center .pc-row-actions,
    .payment-center .pc-history { width: 100%; }
    .payment-center .pc-row-actions .pc-btn,
    .payment-center .pc-row-actions .pc-field,
    .payment-center .pc-history .pc-btn { width: 100%; max-width: none; }
    .payment-center .pc-installment {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .payment-center .pc-installment .pc-btn { width: 100%; }
  }

  @media (max-width: 420px) {
    .payment-center .pc-title { font-size: 16px; }
    .payment-center .pc-chip { font-size: 10px; padding: 0 8px; }
    .payment-center .pc-history-row { padding: 10px 0; }
    .payment-center .pc-history-type { font-size: 12.5px; }
    .payment-center .pc-history-amount { font-size: 13px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .payment-center .pc-btn,
    .payment-center .pc-field { transition: none; }
  }
`;

function StatusBadge({ paid, pending, processing }) {
  const label = paid ? 'PAID' : processing ? 'PROCESSING' : pending ? 'PENDING' : 'NOT PAID';
  const tone = paid ? 'good' : (pending || processing) ? 'wait' : 'neutral';
  return <span className={`pc-chip pc-chip--${tone}`}>{label}</span>;
}

function ObligationRow({
  title,
  subtitle,
  amount,
  paid,
  pending,
  processing,
  note,
  children,
}) {
  return (
    <div className="pc-row">
      <div className="pc-row-head">
        <div className="pc-row-head-main">
          <strong className="pc-row-title">{title}</strong>
          <p className="pc-row-sub">
            {subtitle || (paid ? 'Payment confirmed.' : `Amount due: ${money(amount)} ETB`)}
          </p>
        </div>
        <StatusBadge paid={paid} pending={pending} processing={processing} />
      </div>

      {note && <p className="pc-row-note">{note}</p>}

      {children}
    </div>
  );
}

function PaymentMethodPicker({ methods, value, onChange, disabled }) {
  return (
    <select
      className="pc-field"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {methods.map((method) => (
        <option key={method.value} value={method.value}>
          {method.label}
        </option>
      ))}
    </select>
  );
}

export default function PaymentCenter({
  workflowPayments,
  rawPayments = [],
  isBuyer,
  buyerIdentityMismatch,
  marketplaceBlockedReason,
  payMethod,
  setPayMethod,
  paymentMethods,
  busy,
  marketplace,
  inspections,
  transport,
}) {
  const [showHistory, setShowHistory] = useState(false);

  const maxOnlineAmount = Number(workflowPayments?.marketplace?.maxOnlineAmount) || 0;
  const marketplaceOverLimit =
    maxOnlineAmount > 0 && Number(marketplace?.amount) > maxOnlineAmount;

  const plan = marketplace?.installmentPlan || null;
  const installmentRows = marketplace?.installments || [];
  const paidInstallments = installmentRows.filter((row) => row.status === 'PAID').length;
  const installmentCountNeeded =
    maxOnlineAmount > 0 ? Math.ceil(Number(marketplace?.amount) / maxOnlineAmount) : 0;

  const outstanding =
    (marketplace?.paid ? 0 : 1) +
    (inspections || []).filter((row) => !row.paid).length +
    (transport?.required && !transport.paid ? 1 : 0);

  return (
    <section
      className="card payment-center payment-action-center mb-payment-center"
      id="payment-center"
    >
      <style>{PAYMENT_CENTER_CSS}</style>

      <header className="pc-head">
        <div className="pc-head-main">
          <span className="pc-eyebrow">PAYMENT CENTER</span>
          <h2 className="pc-title">Required payments</h2>
        </div>

        {workflowPayments && (
          <div className="pc-head-side">
            <span className="pc-side-label">Status</span>
            {outstanding === 0 ? (
              <span className="pc-chip pc-chip--good">All settled</span>
            ) : (
              <span className="pc-chip pc-chip--wait">{outstanding} outstanding</span>
            )}
          </div>
        )}
      </header>

      {marketplaceBlockedReason && (
        <div className="pc-alert">{marketplaceBlockedReason}</div>
      )}

      {buyerIdentityMismatch && (
        <div className="pc-alert pc-alert--error">
          This order belongs to a different buyer account. Sign in with the buyer account
          to make payments.
        </div>
      )}

      <div className="pc-rows">
        {marketplace && (
          <ObligationRow
            title="Seller / order payment"
            amount={marketplace.amount}
            paid={marketplace.paid}
            pending={marketplace.pending}
            processing={marketplace.processing}
            note={
              plan && !marketplace.paid
                ? `${paidInstallments} of ${installmentRows.length} installments paid. The seller is paid only after every installment is received.`
                : null
            }
          >
            {isBuyer && !marketplace.paid && plan && (
              <div className="pc-installments">
                {installmentRows.map((row) => {
                  const rowBusy = busy === `installment-${row.id}`;
                  return (
                    <div className="pc-installment" key={row.id}>
                      <div className="pc-installment-info">
                        <strong>
                          Installment {row.installmentSequence} of {plan.installmentCount}
                        </strong>
                        <span className="pc-installment-amount">
                          {money(row.amount)} ETB
                        </span>
                      </div>

                      {row.status === 'PAID' ? (
                        <span className="pc-chip pc-chip--good">PAID</span>
                      ) : row.status === 'PROCESSING' ? (
                        <button
                          type="button"
                          className="pc-btn pc-btn--primary"
                          disabled={rowBusy}
                          onClick={() => marketplace.onCheckInstallment(row)}
                        >
                          {rowBusy ? 'Checking…' : 'Check payment'}
                        </button>
                      ) : row.status === 'PENDING' ? (
                        <button
                          type="button"
                          className="pc-btn pc-btn--primary"
                          disabled={rowBusy}
                          onClick={() => marketplace.onPayInstallment(row)}
                        >
                          {rowBusy ? 'Redirecting…' : 'Pay installment'}
                        </button>
                      ) : row.status === 'FAILED' ? (
                        <button
                          type="button"
                          className="pc-btn pc-btn--outline"
                          disabled={rowBusy}
                          onClick={() => marketplace.onRetryInstallment(row)}
                        >
                          {rowBusy ? 'Preparing…' : 'Payment failed — try again'}
                        </button>
                      ) : (
                        <span className="pc-chip pc-chip--neutral">{row.status}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {isBuyer && !marketplace.paid && !plan && marketplaceOverLimit && (
              <div className="pc-alert pc-alert--info">
                <strong>Too large for one online payment.</strong>
                <p>
                  Online payments are limited to {money(maxOnlineAmount)} ETB per transaction,
                  and this order is {money(marketplace.amount)} ETB.
                  {marketplace.canStartInstallments
                    ? ` You can pay it in ${installmentCountNeeded} installments of about ${money(
                        Math.ceil((Number(marketplace.amount) * 100) / installmentCountNeeded) / 100
                      )} ETB each. The seller is paid only after every installment is received.`
                    : ' Please contact MarketBridge support to arrange this payment.'}
                </p>
                {marketplace.canStartInstallments && (
                  <div className="pc-row-actions">
                    <PaymentMethodPicker
                      methods={paymentMethods}
                      value={payMethod}
                      onChange={setPayMethod}
                      disabled={busy === 'start-installments'}
                    />
                    <button
                      type="button"
                      className="pc-btn pc-btn--primary"
                      disabled={busy === 'start-installments'}
                      onClick={marketplace.onStartInstallments}
                    >
                      {busy === 'start-installments'
                        ? 'Setting up…'
                        : `Pay in ${installmentCountNeeded} installments`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {isBuyer && !marketplace.paid && !plan && !marketplaceOverLimit && (
              <div className="pc-row-actions">
                {marketplace.canCheck ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === 'check-marketplace'}
                    onClick={marketplace.onCheck}
                  >
                    {busy === 'check-marketplace' ? 'Checking…' : 'Check seller payment'}
                  </button>
                ) : marketplace.canResume ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === 'resume-marketplace'}
                    onClick={marketplace.onResume}
                  >
                    {busy === 'resume-marketplace' ? 'Redirecting…' : 'Resume seller payment'}
                  </button>
                ) : marketplace.canPay ? (
                  <>
                    <PaymentMethodPicker
                      methods={paymentMethods}
                      value={payMethod}
                      onChange={setPayMethod}
                      disabled={busy === 'pay-marketplace'}
                    />
                    <button
                      type="button"
                      className="pc-btn pc-btn--primary"
                      disabled={busy === 'pay-marketplace'}
                      onClick={marketplace.onPay}
                    >
                      {busy === 'pay-marketplace' ? 'Submitting…' : 'Pay seller / order now'}
                    </button>
                  </>
                ) : marketplace.pending ? (
                  <span className="pc-row-sub">
                    A seller payment is being processed. Check the payment status before
                    starting another checkout.
                  </span>
                ) : null}
              </div>
            )}
          </ObligationRow>
        )}

        {(inspections || []).map((row) => (
          <ObligationRow
            key={row.id}
            title={row.label}
            amount={row.amount}
            paid={row.paid}
            pending={row.pending}
            processing={row.processing}
            note={row.note}
          >
            {isBuyer && !row.paid && (
              <div className="pc-row-actions">
                {row.canCheck ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === row.busyKey}
                    onClick={row.onCheck}
                  >
                    {busy === row.busyKey ? 'Checking…' : 'Check inspector payment'}
                  </button>
                ) : row.canResume ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === row.busyKey}
                    onClick={row.onResume}
                  >
                    {busy === row.busyKey ? 'Redirecting…' : 'Resume inspector payment'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === row.busyKey}
                    onClick={row.onPay}
                  >
                    {busy === row.busyKey ? 'Submitting…' : 'Pay inspector now'}
                  </button>
                )}
              </div>
            )}
          </ObligationRow>
        ))}

        {transport?.required && (
          <ObligationRow
            title="Hired transporter payment"
            subtitle={
              transport.amount != null
                ? `Transport fee: ${money(transport.amount)} ETB`
                : 'Transport fee has not been agreed yet.'
            }
            paid={transport.paid}
            pending={transport.pending}
            processing={transport.processing}
            note={transport.note}
          >
            {isBuyer && !transport.paid && transport.readyToPay && (
              <div className="pc-row-actions">
                {transport.canCheck ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === 'check-transport'}
                    onClick={transport.onCheck}
                  >
                    {busy === 'check-transport' ? 'Checking…' : 'Check transporter payment'}
                  </button>
                ) : transport.canResume ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    disabled={busy === 'resume-transport'}
                    onClick={transport.onResume}
                  >
                    {busy === 'resume-transport' ? 'Redirecting…' : 'Resume transporter payment'}
                  </button>
                ) : transport.canStart ? (
                  <>
                    <PaymentMethodPicker
                      methods={paymentMethods}
                      value={payMethod}
                      onChange={setPayMethod}
                      disabled={busy === 'pay-transport'}
                    />
                    <button
                      type="button"
                      className="pc-btn pc-btn--primary"
                      disabled={busy === 'pay-transport'}
                      onClick={transport.onStart}
                    >
                      {busy === 'pay-transport' ? 'Submitting…' : 'Pay transporter now'}
                    </button>
                  </>
                ) : transport.pending ? (
                  <span className="pc-row-sub">
                    A transport payment is pending. Refresh this page after checkout.
                  </span>
                ) : null}
              </div>
            )}
          </ObligationRow>
        )}

        {transport && !transport.required && (
          <p className="pc-own-truck">
            Own-truck transport — no separate transport payment required.
          </p>
        )}

        {!isBuyer && (
          <p className="pc-not-buyer">
            Only the buyer can make these payments. The statuses above stay up to date for
            everyone on the order.
          </p>
        )}
      </div>

      {rawPayments.length > 0 && (
        <div className="pc-history">
          <button
            type="button"
            className="pc-btn pc-btn--outline"
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory
              ? 'Hide payment history'
              : `Show payment history (${rawPayments.length})`}
          </button>

          {showHistory && (
            <ul className="pc-history-list">
              {rawPayments.map((payment) => (
                <li className="pc-history-row" key={payment.id}>
                  <div className="pc-history-main">
                    <strong className="pc-history-type">
                      {payment.type === 'MARKETPLACE_INSTALLMENT'
                        ? `INSTALLMENT ${payment.installmentSequence || ''}`.trim()
                        : String(payment.type || '').replace(/_/g, ' ')}
                    </strong>
                    <span className="pc-history-meta">
                      {payment.method || '—'}
                      {payment.reference ? ` · Ref ${payment.reference.slice(0, 8)}` : ''}
                    </span>
                  </div>
                  <div className="pc-history-side">
                    <strong className="pc-history-amount">
                      {money(payment.amount)} ETB
                    </strong>
                    <span className="pc-chip pc-chip--neutral">
                      {String(payment.status || '').replace(/_/g, ' ')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="pc-notice">
        <strong className="pc-notice-prefix">Notice:</strong>{' '}
        Payments are separate. The buyer pays the seller, any required inspector, and a
        hired transporter, each from its own row above.
      </div>
    </section>
  );
}
