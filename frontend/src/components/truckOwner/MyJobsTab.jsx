import React from 'react';
import { Link } from 'react-router-dom';
import JobActionButtons from './JobActionButtons.jsx';
import { fmtDate, shortOrder, jobAmount, arrangerShort, jobTone, jobProgress, workDetailsSummary, getArrangingPartyLabel, getStatusClass } from './truckOwnerHelpers.js';
import { ArrowIcon, RouteStrip, AmountRow } from './TruckOwnerParts.jsx';

// "My Jobs" tab: active trip cards, completed-trips table and empty state.
export default function MyJobsTab({ myJobs, activeJobs, completedJobs, actionLoading, setActiveTab, releaseTransportAgreement, confirmTruckArrived, updateStatus, openEvidenceModal, setLoadingReportJobId, setCoordModalJobId }) {
  return (
    <div>
      <div className="sd-toolbar">
        <div>
          <span className="sd-eyebrow">MY JOBS</span>
          <h2>Active and completed trips</h2>
          <p className="sd-muted">
            Manage accepted transport jobs from pickup through delivery.
          </p>
        </div>
      </div>

      {/* ── Active trips (cards) ─────────────────────────── */}

      {activeJobs.length > 0 && (
        <section className="sd-jobs-section">
          <div className="sd-jobs-section-head">
            <span className="sd-eyebrow">IN PROGRESS</span>
            <h3 className="sd-jobs-section-title">
              Active trips
              <span className="sd-jobs-count">{activeJobs.length}</span>
            </h3>
          </div>

          <div className="sd-cards">
            {activeJobs.map((job) => {
              const arranger = arrangerShort(job.arrangingParty);
              const createdLabel = fmtDate(job.createdAt);
              const tone = jobTone(job.status);
              const steps = jobProgress(job.status);
              const orderRef = shortOrder(job.orderId);
              const amount = jobAmount(job);

              return (
                <article className="sd-card sd-job-card" key={job.id}>
                  {/* Card head */}
                  <div className="sd-card-head">
                    <div className="sd-card-head-text">
                      <span className={`sd-eyebrow tone-${tone}`}>Active trip</span>
                      <h3 className="sd-card-title" title={job.load || 'Produce'}>
                        {job.load || 'Produce'}
                      </h3>
                      {createdLabel && <p className="sd-card-sub">{createdLabel}</p>}
                    </div>

                    <div className="sd-card-head-party">
                      <div className="sd-party-info">
                        <span className="sd-party-role">Arranged by</span>
                        <span className="sd-party-name">{arranger.name}</span>
                      </div>
                      <div className={`sd-avatar tone-${tone}`} aria-hidden="true">
                        {arranger.initials}
                      </div>
                    </div>
                  </div>

                  <div className="sd-card-body">
                    {/* Block 1 — Trip status */}
                    <section className="sd-card-block">
                      <div className="sd-card-block-title">
                        <h4>Trip status</h4>
                        {orderRef && <span className="sd-card-block-note">{orderRef}</span>}
                      </div>
                      <div className="sd-card-block-body">
                        <div className="sd-pills">
                          <span className={`sd-pill tone-${tone}`}>
                            <span className="sd-pill-dot" aria-hidden="true" />
                            {job.status.replace(/_/g, ' ')}
                          </span>
                        </div>

                        <div className="sd-progress" aria-label="Trip progress">
                          {steps.map((step) => (
                            <div
                              key={step.label}
                              className={`sd-progress-step ${step.cls}`}
                              title={step.label}
                            >
                              <span className="sd-progress-dot" aria-hidden="true" />
                              <span className="sd-progress-label">{step.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>

                    {/* Block 2 — Route */}
                    <section className="sd-card-block">
                      <div className="sd-card-block-title">
                        <h4>Route</h4>
                      </div>
                      <div className="sd-card-block-body">
                        <RouteStrip
                          compact
                          pickup={job.pickupLocation || '—'}
                          destination={job.destination || '—'}
                        />
                      </div>
                    </section>

                    {/* Block 3 — Details */}
                    <section className="sd-card-block">
                      <div className="sd-card-block-title">
                        <h4>Trip details</h4>
                      </div>
                      <div className="sd-card-block-body">
                        <div className="sd-job-meta">
                          <div className="sd-job-meta-item">
                            <span>Arrangement</span>
                            <strong>{getArrangingPartyLabel(job.arrangingParty)}</strong>
                          </div>
                          {job.requiredCapacity && (
                            <div className="sd-job-meta-item">
                              <span>Capacity</span>
                              <strong>{job.requiredCapacity}t+</strong>
                            </div>
                          )}
                        </div>
                        {job.workDetails && workDetailsSummary(job.workDetails) && (
                          <div className="sd-job-requirements">
                            <span className="sd-job-requirements-label">Work details</span>
                            <p>{workDetailsSummary(job.workDetails)}</p>
                          </div>
                        )}
                        {job.specialRequirements && (
                          <div className="sd-job-requirements">
                            <span className="sd-job-requirements-label">Requirements</span>
                            <p>{job.specialRequirements}</p>
                          </div>
                        )}
                      </div>
                    </section>

                    {/* Block 4 — Amount */}
                    {amount && (
                      <section className="sd-card-block">
                        <div className="sd-card-block-title">
                          <h4>Amount</h4>
                        </div>
                        <div className="sd-card-block-body">
                          <AmountRow value={amount} />
                        </div>
                      </section>
                    )}

                    {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                    {/* Footer */}
                    <div className="sd-card-actions">
                      <JobActionButtons
                        job={job}
                        actionLoading={actionLoading}
                        releaseTransportAgreement={releaseTransportAgreement}
                        confirmTruckArrived={confirmTruckArrived}
                        updateStatus={updateStatus}
                        openEvidenceModal={openEvidenceModal}
                        setLoadingReportJobId={setLoadingReportJobId}
                        setCoordModalJobId={setCoordModalJobId}
                      />
                      <Link
                        to={`/orders/${job.orderId}`}
                        className="sd-btn sd-btn-outline"
                      >
                        View order
                        <ArrowIcon />
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Completed trips (table) ──────────────────────── */}

      {completedJobs.length > 0 && (
        <section className="sd-jobs-section">
          <div className="sd-jobs-section-head">
            <span className="sd-eyebrow">HISTORY</span>
            <h3 className="sd-jobs-section-title">
              Completed trips
              <span className="sd-jobs-count">{completedJobs.length}</span>
            </h3>
          </div>

          <div className="sd-panel sd-table-wrap">
            <table className="sd-table sd-table--mobile-cards">
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Route</th>
                  <th>Arranged by</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {completedJobs.map((job) => (
                  <tr key={job.id}>
                    <td data-label="Load">
                      <strong>{job.load}</strong>
                    </td>
                    <td data-label="Route">
                      {job.pickupLocation} → {job.destination}
                    </td>
                    <td data-label="Arranged by">
                      {getArrangingPartyLabel(job.arrangingParty)}
                    </td>
                    <td data-label="Status">
                      <span className={getStatusClass(job.status)}>
                        {job.status}
                      </span>
                    </td>
                    <td data-label="Action">
                      <Link
                        to={`/orders/${job.orderId}`}
                        className="sd-table-action"
                      >
                        View order
                        <ArrowIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Empty state ──────────────────────────────────── */}

      {myJobs.length === 0 && (
        <div className="sd-empty-state">
          <div className="sd-empty-icon" aria-hidden="true">📋</div>
          <h3>No transport jobs yet</h3>
          <p className="sd-muted">
            Once a requester accepts your quote, the job will appear here with the next steps.
          </p>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={() => setActiveTab('available')}
          >
            Browse available jobs
          </button>
        </div>
      )}
    </div>
  );
}
