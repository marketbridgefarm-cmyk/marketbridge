import React from 'react';
import EvidenceUploader from '../EvidenceUploader.jsx';

// Modal: pickup/delivery evidence capture before a status change.
export default function EvidenceModal({ evidenceModal, evidenceError, evidenceKeys, setEvidenceKeys, evidenceGps, setEvidenceGps, evidenceNotes, setEvidenceNotes, submittingEvidence, closeEvidenceModal, submitEvidenceAndAdvance }) {
  return (
    <div
      className="sd-report-backdrop"
      role="presentation"
      onClick={closeEvidenceModal}
    >
      <div
        className="sd-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sd-report-header">
          <h2 id="evidence-modal-title">
            {evidenceModal.type === 'PICKUP'
              ? 'Pickup evidence'
              : 'Delivery evidence'}
          </h2>
          <button
            type="button"
            className="btn btn-light btn-sm"
            aria-label="Close evidence form"
            onClick={closeEvidenceModal}
          >
            Close
          </button>
        </div>

        <p className="muted small">
          A photo, video, GPS location or note is required before this trip can be marked{' '}
          {evidenceModal.nextStatus === 'IN_TRANSIT' ? 'in transit' : 'delivered'}.
        </p>

        {evidenceError && <div className="alert error">{evidenceError}</div>}

        <EvidenceUploader
          uploadUrl={`/transport/${evidenceModal.jobId}/evidence/media`}
          disabled={submittingEvidence}
          onUploaded={({ photoKeys, videoKeys }) =>
            setEvidenceKeys((prev) => ({
              photoKeys: [...prev.photoKeys, ...photoKeys],
              videoKeys: [...prev.videoKeys, ...videoKeys],
            }))
          }
        />

        {(evidenceKeys.photoKeys.length > 0 ||
          evidenceKeys.videoKeys.length > 0) && (
          <p className="muted small">
            {evidenceKeys.photoKeys.length} photo(s),{' '}
            {evidenceKeys.videoKeys.length} video(s) ready to submit
          </p>
        )}

        <div className="sd-form-grid">
          <div>
            <label>GPS location (optional)</label>
            <input
              value={evidenceGps}
              onChange={(e) => setEvidenceGps(e.target.value)}
              placeholder="lat,lng"
            />
          </div>
          <div>
            <label>Notes (optional)</label>
            <input
              value={evidenceNotes}
              onChange={(e) => setEvidenceNotes(e.target.value)}
              placeholder="Condition on pickup/delivery…"
            />
          </div>
        </div>

        <div className="sd-modal-actions sd-report-actions">
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={submittingEvidence}
            onClick={submitEvidenceAndAdvance}
          >
            {submittingEvidence
              ? 'Submitting…'
              : `Submit & mark ${
                  evidenceModal.nextStatus === 'IN_TRANSIT'
                    ? 'in transit'
                    : 'delivered'
                }`}
          </button>
        </div>
      </div>
    </div>
  );
}
