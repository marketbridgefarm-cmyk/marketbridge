import React from 'react';
import TransportCoordinationTransporter from '../TransportCoordinationTransporter.jsx';

// Modal: pickup handoff coordination with the seller (transporter side).
export default function PickupHandoffModal({ coordModalJobId, setCoordModalJobId }) {
  return (
    <div
      className="sd-report-backdrop"
      role="presentation"
      onClick={() => setCoordModalJobId(null)}
    >
      <div
        className="sd-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coord-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sd-report-header">
          <h2 id="coord-modal-title">Pickup handoff</h2>
          <button
            type="button"
            className="btn btn-light btn-sm"
            onClick={() => setCoordModalJobId(null)}
          >
            Close
          </button>
        </div>
        <TransportCoordinationTransporter transportJobId={coordModalJobId} />
      </div>
    </div>
  );
}
