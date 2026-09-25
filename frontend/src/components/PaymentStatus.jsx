import React from 'react';

// ============================================================================
// PAYMENT STATUS
// ============================================================================
// Displays every payment obligation on the order — goods, each fee-bearing
// inspection, and transport when hired — from the `payments` snapshot
// returned by GET /orders/:id/workflow. This mirrors the same gate the
// backend enforces before pickup (getTransportPaymentGate in
// routes/transport.js), so what the buyer sees here always matches what
// actually blocks pickup.
// ============================================================================

const money = (value) =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function Row({ label, amount, paid, note, payer, beneficiary }) {
  return (
    <div className="payment-status-row row-between">
      <div>
        <div>{label}</div>
        {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
        {(payer || beneficiary) && (
          <div className="muted" style={{ fontSize: 12 }}>
            {payer ? `Payer: ${payer}` : ''}{payer && beneficiary ? ' · ' : ''}{beneficiary ? `Recipient: ${beneficiary}` : ''}
          </div>
        )}
      </div>
      <div className="row-between" style={{ gap: 10 }}>
        <span>{money(amount)} ETB</span>
        <span className={`badge ${paid ? 'badge-success' : 'badge-pending'}`}>
          {paid ? 'PAID' : 'PENDING'}
        </span>
      </div>
    </div>
  );
}

export default function PaymentStatus({ payments }) {
  if (!payments) return null;

  const { marketplace, inspections, transport } = payments;
  const outstanding =
    (marketplace.paid ? 0 : 1) +
    inspections.filter((o) => !o.paid).length +
    (transport?.required && !transport.paid ? 1 : 0);

  return (
    <div className="payment-status mb-payment-status">
      <div className="row-between">
        <strong>Required payments</strong>
        {outstanding === 0 ? (
          <span className="badge badge-success">All settled</span>
        ) : (
          <span className="badge badge-pending">{outstanding} outstanding</span>
        )}
      </div>

      <Row
        label="Goods payment (to seller)"
        amount={marketplace.amount}
        paid={marketplace.paid}
        payer="Buyer"
        beneficiary="Seller"
      />

      {inspections.map((obligation) => (
        <Row
          key={obligation.inspectionRequestId}
          label="Inspection fee"
          amount={obligation.amount}
          paid={obligation.paid}
          note={
            obligation.inspectionStatus !== 'COMPLETED'
              ? `Inspection status: ${obligation.inspectionStatus}`
              : null
          }
          payer="Buyer"
          beneficiary="Inspector"
        />
      ))}

      {transport?.required && (
        <Row
          label="Transport payment (to transporter)"
          amount={transport.amount}
          paid={transport.paid}
          payer="Buyer"
          beneficiary="Transporter"
        />
      )}

      {!transport?.required && transport && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Own-truck transport — no separate transport payment required.
        </div>
      )}
    </div>
  );
}
