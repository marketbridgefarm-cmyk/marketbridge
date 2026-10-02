import React, { useState } from 'react';
import './PaymentCenter.css';   // ← add this line
// ============================================================================
// PAYMENT CENTER
// ============================================================================
// Single source of truth for "what does this order still owe, and how do I
// pay it" — replaces three previously-separate renderings on OrderDetail.jsx
// (the workflow-driven summary card, the buyer's interactive payment
// actions, and a flat "payment records" ledger at the bottom of the page)
// with one card: a status/action row per obligation (goods, each fee-bearing
// inspection, hired transport), plus an optional expandable ledger of the
// underlying payment attempts.
//
// This component is presentational only. Every gating decision (who can pay,
// when, how much) is still computed in OrderDetail.jsx from the same order/
// workflow data the backend uses to enforce the equivalent rule server-side
// — this file just renders the result and wires up the provided handlers.
// ============================================================================

const money = (value) =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

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
  const safeMethods = Array.isArray(methods) ? methods : [];
  return (
    <select
      className="pc-field"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {safeMethods.map((method) => (
        <option key={method.value} value={method.value}>
          {method.label}
        </option>
      ))}
    </select>
  );
}

export default function PaymentCenter({
  // Workflow-derived summary (GET /orders/:id/workflow) — used only for the
  // "N outstanding" header count so it always matches the backend's own
  // accounting of what's required.
  workflowPayments,

  // Raw payment attempts (order.payments) — used for the expandable history
  // ledger only.
  rawPayments = [],

  isBuyer,
  buyerIdentityMismatch,
  marketplaceBlockedReason,

  payMethod,
  setPayMethod,
  paymentMethods,
  busy,

  marketplace, // { amount, paid, pending, canPay, canResume, canCheck, onPay, onResume, onCheck }
  inspections, // [{ id, label, amount, paid, pending, processing, note, canPay, canResume, canCheck, onPay, onResume, onCheck }]
  transport, // null, or { required, amount, paid, pending, processing, note, canStart, canResume, canCheck, onStart, onResume, onCheck }
}) {
  const [showHistory, setShowHistory] = useState(false);

  const methods = Array.isArray(paymentMethods) ? paymentMethods : [];
  const installmentRows = Array.isArray(marketplace?.installments)
    ? marketplace.installments.filter((row) => row && typeof row === 'object')
    : [];
  const inspectionRows = Array.isArray(inspections)
    ? inspections.filter((row) => row && typeof row === 'object')
    : [];
  const historyRows = Array.isArray(rawPayments)
    ? rawPayments.filter((payment) => payment && typeof payment === 'object')
    : [];
  const maxOnlineAmount = Number(workflowPayments?.marketplace?.maxOnlineAmount) || 0;
  const marketplaceOverLimit =
    maxOnlineAmount > 0 && Number(marketplace?.amount) > maxOnlineAmount;

  const plan = marketplace?.installmentPlan || null;
  const paidInstallments = installmentRows.filter((row) => row.status === 'PAID').length;
  const installmentCountNeeded =
    maxOnlineAmount > 0 ? Math.ceil(Number(marketplace?.amount) / maxOnlineAmount) : 0;

  const outstanding =
    (marketplace?.paid ? 0 : 1) +
    inspectionRows.filter((row) => !row.paid).length +
    (transport?.required && !transport.paid ? 1 : 0);

  return (
    <section
      className="card payment-center payment-action-center mb-payment-center"
      id="payment-center"
    >
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

        {inspectionRows.map((row) => (
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
          <p className="pc-row-sub pc-own-truck">
            Own-truck transport — no separate transport payment required.
          </p>
        )}

        {!isBuyer && (
          <p className="pc-row-sub pc-not-buyer">
            Only the buyer can make these payments. The statuses above stay up to date for
            everyone on the order.
          </p>
        )}
      </div>

      {/* ── Payment history ────────────────────────────────── */}
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
              {historyRows.map((payment) => (
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

      {/* ── Notice ─────────────────────────────────────────── */}
      <div className="pc-notice">
        <strong className="pc-notice-prefix">Notice:</strong>{' '}
        Payments are separate. The buyer pays the seller, any required inspector, and a
        hired transporter, each from its own row above.
      </div>
    </section>
  );
}
