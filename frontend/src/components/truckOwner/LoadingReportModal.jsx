import React from 'react';
import TransportLoadingReport from '../TransportLoadingReport.jsx';

// Modal: transporter-side loading-preparation report (was an inline IIFE).
export default function LoadingReportModal({ loadingReportJobId, myJobs, setLoadingReportJobId, loadAll }) {
  const j = myJobs.find((x) => x.id === loadingReportJobId);
  if (!j) return null;
  return (
    <div
      className="sd-report-backdrop"
      role="presentation"
      onClick={() => setLoadingReportJobId(null)}
    >
      <div
        className="sd-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="loading-report-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sd-report-header">
          <h2 id="loading-report-modal-title">Loading preparation report</h2>
          <button
            type="button"
            className="btn btn-light btn-sm"
            onClick={() => setLoadingReportJobId(null)}
          >
            Close
          </button>
        </div>
        <TransportLoadingReport
          transportJobId={j.id}
          jobStatus={j.status}
          sellerConfirmed={Boolean(j.sellerPickupConfirmedAt)}
          paymentsReady={j.order?.payments?.some(
            (p) => p.type === 'TRANSPORT' && p.status === 'PAID'
          )}
          truckArrived={Boolean(j.truckArrivedAt)}
          onSubmitted={async () => {
            setLoadingReportJobId(null);
            await loadAll(false);
          }}
        />
      </div>
    </div>
  );
}
