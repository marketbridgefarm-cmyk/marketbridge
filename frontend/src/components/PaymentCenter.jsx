import React, { useState } from 'react';

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
  const tone = paid ? 'badge-success' : pending || processing ? 'badge-pending' : '';
  return <span className={`badge ${tone}`}>{label}</span>;
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
    <div className="notice payment-center-row">
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{title}</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            {subtitle || (paid ? 'Payment confirmed.' : `Amount due: ${money(amount)} ETB`)}
          </p>
        </div>
        <StatusBadge paid={paid} pending={pending} processing={processing} />
      </div>

      {note && (
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          {note}
        </p>
      )}

      {children}
    </div>
  );
}

function PaymentMethodPicker({ methods, value, onChange, disabled }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      {methods.map((method) => (
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

  const outstanding =
    (marketplace?.paid ? 0 : 1) +
    (inspections || []).filter((row) => !row.paid).length +
    (transport?.required && !transport.paid ? 1 : 0);

  return (
    <div className="card payment-action-center mb-payment-center" id="payment-center">
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="eyebrow">PAYMENT CENTER</span>
          <h2>Complete required payments</h2>
          <p className="muted">
            Payments are separate. The buyer pays the seller, any required inspector, and a
            hired transporter, each from its own row below.
          </p>
        </div>

        {workflowPayments &&
          (outstanding === 0 ? (
            <span className="badge badge-success">All settled</span>
          ) : (
            <span className="badge badge-pending">{outstanding} outstanding</span>
          ))}
      </div>

      {marketplaceBlockedReason && (
        <div className="alert" style={{ marginTop: 10 }}>
          {marketplaceBlockedReason}
        </div>
      )}

      {buyerIdentityMismatch && (
        <div className="alert error" style={{ marginTop: 10 }}>
          This order belongs to a different buyer account. Sign in with the buyer account to make
          payments.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {marketplace && (
          <ObligationRow
            title="Seller / order payment"
            amount={marketplace.amount}
            paid={marketplace.paid}
            pending={marketplace.pending}
            processing={marketplace.processing}
          >
            {isBuyer && !marketplace.paid && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                {marketplace.canCheck ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'check-marketplace'}
                    onClick={marketplace.onCheck}
                  >
                    {busy === 'check-marketplace' ? 'Checking…' : 'Check seller payment'}
                  </button>
                ) : marketplace.canResume ? (
                  <button
                    type="button"
                    className="btn btn-primary"
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
                      className="btn btn-primary"
                      disabled={busy === 'pay-marketplace'}
                      onClick={marketplace.onPay}
                    >
                      {busy === 'pay-marketplace' ? 'Submitting…' : 'Pay seller / order now'}
                    </button>
                  </>
                ) : marketplace.pending ? (
                  <span className="muted">
                    A seller payment is being processed. Check the payment status before starting
                    another checkout.
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
              <div style={{ marginTop: 8 }}>
                {row.canCheck ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy === row.busyKey}
                    onClick={row.onCheck}
                  >
                    {busy === row.busyKey ? 'Checking…' : 'Check inspector payment'}
                  </button>
                ) : row.canResume ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy === row.busyKey}
                    onClick={row.onResume}
                  >
                    {busy === row.busyKey ? 'Redirecting…' : 'Resume inspector payment'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                {transport.canCheck ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy === 'check-transport'}
                    onClick={transport.onCheck}
                  >
                    {busy === 'check-transport' ? 'Checking…' : 'Check transporter payment'}
                  </button>
                ) : transport.canResume ? (
                  <button
                    type="button"
                    className="btn btn-primary"
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
                      className="btn btn-primary"
                      disabled={busy === 'pay-transport'}
                      onClick={transport.onStart}
                    >
                      {busy === 'pay-transport' ? 'Submitting…' : 'Pay transporter now'}
                    </button>
                  </>
                ) : transport.pending ? (
                  <span className="muted">A transport payment is pending. Refresh this page after checkout.</span>
                ) : null}
              </div>
            )}
          </ObligationRow>
        )}

        {transport && !transport.required && (
          <div className="muted" style={{ fontSize: 12 }}>
            Own-truck transport — no separate transport payment required.
          </div>
        )}

        {!isBuyer && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Only the buyer can make these payments. The statuses above stay up to date for
            everyone on the order.
          </p>
        )}
      </div>

      {rawPayments.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory ? 'Hide payment history' : `Show payment history (${rawPayments.length})`}
          </button>

          {showHistory && (
            <div style={{ marginTop: 10 }}>
              {rawPayments.map((payment) => (
                <div className="payment-row" key={payment.id}>
                  <span>
                    <strong>{payment.type}</strong>
                  </span>
                  <strong>{money(payment.amount)} ETB</strong>
                  <span>{payment.method || '—'}</span>
                  <span className="badge">{payment.status}</span>
                  {payment.reference && (
                    <span className="muted">Ref: {payment.reference.slice(0, 8)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
