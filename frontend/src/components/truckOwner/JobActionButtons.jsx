import React from 'react';
import { fmtMoney } from './truckOwnerHelpers.js';

// Per-job action area for an active trip: waiting notices and the next step button.
export default function JobActionButtons({ job, actionLoading, releaseTransportAgreement, confirmTruckArrived, updateStatus, openEvidenceModal, setLoadingReportJobId, setCoordModalJobId }) {
  const busy = actionLoading?.startsWith(`status-${job.id}`);

  if (job.status === 'REQUESTED' || job.status === 'QUOTED') {
    // The backend keeps the job in QUOTED after a deal is accepted: the
    // agreement is provisional until transport payment settles. Without
    // this branch the truck owner whose quote was accepted was told the
    // requester was still "selecting a transporter".
    const agreedQuote = (job.quotes || []).find((quote) => quote.status === 'ACCEPTED');
    if (agreedQuote) {
      const orderPayments = job.order?.payments || [];
      const transportPayStarted =
        orderPayments.some(
          (p) => p.type === 'TRANSPORT' && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
        ) ||
        (job.payments || []).some(
          (p) => p.type === 'TRANSPORT' && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
        );
      return (
        <div className="sd-job-actions">
          <p className="sd-job-waiting">
            <span className="sd-job-waiting-dot" aria-hidden="true" />
            Agreement reached at {fmtMoney(job.agreedAmount ?? agreedQuote.amount)} ETB — waiting for the requester&apos;s transport payment
          </p>
          {!transportPayStarted && (
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              disabled={actionLoading === `quote-${agreedQuote.id}`}
              onClick={() => releaseTransportAgreement(job.id, agreedQuote.id)}
            >
              {actionLoading === `quote-${agreedQuote.id}` ? 'Releasing…' : 'Cancel provisional deal'}
            </button>
          )}
        </div>
      );
    }
    return (
      <p className="sd-job-waiting">
        <span className="sd-job-waiting-dot" aria-hidden="true" />
        Waiting for the requester to select a transporter
      </p>
    );
  }

  if (job.status === 'SELECTED') {
    return (
      <p className="sd-job-waiting">
        <span className="sd-job-waiting-dot" aria-hidden="true" />
        You've been selected — finalising the deal terms
      </p>
    );
  }

  if (job.status === 'ACCEPTED') {
    const acceptedQuote = (job.quotes || []).find((q) => q.status === 'ACCEPTED');
    const orderPayments = job.order?.payments || [];
    const marketplacePaid = orderPayments.some((p) => p.type === 'MARKETPLACE' && p.status === 'PAID');
    const transportPaid =
      job.method !== 'HIRE_TRANSPORTER' ||
      orderPayments.some((p) => p.type === 'TRANSPORT' && p.status === 'PAID') ||
      (job.payments || []).some((p) => p.type === 'TRANSPORT' && p.status === 'PAID');

    // FIXED: The transporter coordinates the pickup from their own
    // workspace. This button is shown at every step of the ACCEPTED state
    // so handoff is never blocked by an intermediate waiting gate.
    const coordinationButton = (
      <button
        type="button"
        className="sd-btn sd-btn-outline"
        onClick={() => setCoordModalJobId(job.id)}
      >
        Open pickup handoff
      </button>
    );

    const waiting = (text, extra) => (
      <div className="sd-job-actions">
        <p className="sd-job-waiting">
          <span className="sd-job-waiting-dot" aria-hidden="true" />{text}
        </p>
        {extra}
      </div>
    );

    if (!transportPaid) {
      return waiting(
        'Waiting for the buyer to pay the transport fee',
        <>
          {coordinationButton}
          {acceptedQuote && (
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              disabled={actionLoading === `quote-${acceptedQuote.id}`}
              onClick={() => releaseTransportAgreement(job.id, acceptedQuote.id)}
            >
              {actionLoading === `quote-${acceptedQuote.id}` ? 'Cancelling…' : 'Cancel provisional deal'}
            </button>
          )}
        </>
      );
    }
    if (!job.sellerPickupConfirmedAt) {
      return waiting('Waiting for the seller to confirm loading preparation', coordinationButton);
    }
    if (!job.truckArrivedAt) {
      return (
        <div className="sd-job-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy}
            onClick={() => confirmTruckArrived(job.id)}
          >
            {busy ? 'Confirming…' : 'Confirm truck arrived on site'}
          </button>
          {coordinationButton}
        </div>
      );
    }
    if (!job.loadingReport) {
      return (
        <div className="sd-job-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={() => setLoadingReportJobId(job.id)}
          >
            Submit loading-prep report
          </button>
          <p className="sd-job-note">
            Record what you will load. The buyer reviews it before goods payment.
          </p>
          {coordinationButton}
        </div>
      );
    }
    if (!job.buyerLoadingConfirmedAt) {
      return waiting('Waiting for the buyer to approve the loading report', coordinationButton);
    }
    if (!marketplacePaid) {
      return waiting('Waiting for the buyer to pay for the goods', coordinationButton);
    }

    return (
      <div className="sd-job-actions">
        <button
          type="button"
          className="sd-btn sd-btn-primary"
          disabled={busy}
          onClick={() => updateStatus(job.id, 'PICKUP')}
        >
          {busy ? 'Updating…' : 'Mark picked up'}
        </button>
        {coordinationButton}
      </div>
    );
  }

  if (job.status === 'PICKUP') {
    return (
      <div className="sd-job-actions">
        <button
          type="button"
          className="sd-btn sd-btn-primary"
          disabled={busy}
          onClick={() => openEvidenceModal(job.id, 'PICKUP', 'IN_TRANSIT')}
        >
          {busy ? 'Updating…' : 'Add pickup evidence & start trip'}
        </button>
      </div>
    );
  }

  if (job.status === 'IN_TRANSIT') {
    return (
      <div className="sd-job-actions">
        <button
          type="button"
          className="sd-btn sd-btn-primary"
          disabled={busy}
          onClick={() => openEvidenceModal(job.id, 'DELIVERY', 'DELIVERED')}
        >
          {busy ? 'Updating…' : 'Add delivery evidence & complete trip'}
        </button>
      </div>
    );
  }

  return null;
}
