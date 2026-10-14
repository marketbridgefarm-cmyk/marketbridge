import React from 'react';
import { fmtDate, fmtMoney, arrangerShort, workDetailsSummary, getArrangingPartyLabel, leafTransportQuote, isQuoteExpired } from './truckOwnerHelpers.js';
import { RouteStrip, AmountRow } from './TruckOwnerParts.jsx';

// "Available Jobs" tab: open transport requests and the quote/negotiation controls.
export default function AvailableJobsTab({ openJobs, actionLoading, respondToJob, withdrawWaitingBid, acceptTransportQuote, counterTransportQuote, rejectTransportQuote }) {
  return (
    <div>
      <div className="sd-toolbar">
        <div>
          <span className="sd-eyebrow">MARKETPLACE</span>
          <h2>Open transport requests</h2>
          <p className="sd-muted">
            Buyer-, seller-, or jointly-arranged requests looking for a transporter.
          </p>
        </div>
      </div>

      <div className="sd-cards">
        {openJobs.map((job) => {
          const quoting = actionLoading === `job-${job.id}-QUOTE`;

          const myLeaf = leafTransportQuote(job.quotes);
          const leafExpired = isQuoteExpired(myLeaf);
          // A quote the requester already accepted is settled (payment
          // pending); show that instead of offering to quote again.
          const hasAgreement = Boolean(myLeaf) && myLeaf.status === 'ACCEPTED';
          const hasActiveThread =
            myLeaf && !leafExpired && ['SELECTED', 'COUNTERED'].includes(myLeaf.status);
          const hasWaitingBid =
            myLeaf && !leafExpired && myLeaf.status === 'PENDING';
          const isMyTurn =
            hasActiveThread &&
            myLeaf.status === 'COUNTERED' &&
            myLeaf.counteredBy === 'REQUESTER';
          const respondBusy = myLeaf && actionLoading === `quote-${myLeaf.id}`;
          // One bid per job: once a truck owner has quoted (including
          // after withdrawing), they cannot bid on that job again.
          const canQuote = !myLeaf && !hasAgreement;

          const quoteAmount = hasActiveThread
            ? fmtMoney(
                myLeaf.status === 'COUNTERED'
                  ? (myLeaf.counterAmount ?? myLeaf.amount)
                  : myLeaf.amount
              )
            : null;

          const arranger = arrangerShort(job.arrangingParty);
          const createdLabel = fmtDate(job.createdAt);
          const showFooter = canQuote || isMyTurn || hasWaitingBid;
          const workSummary = workDetailsSummary(job.workDetails);

          return (
            <article className="sd-card sd-job-card" key={job.id}>
              {/* Card head */}
              <div className="sd-card-head">
                <div className="sd-card-head-text">
                  <span className="sd-eyebrow tone-info">Open request</span>
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
                  <div className="sd-avatar tone-success" aria-hidden="true">
                    {arranger.initials}
                  </div>
                </div>
              </div>

              <div className="sd-card-body">
                {/* Block 1 — Route */}
                <section className="sd-card-block">
                  <div className="sd-card-block-title">
                    <h4>Route</h4>
                  </div>
                  <div className="sd-card-block-body">
                    <RouteStrip
                      pickup={job.pickupLocation}
                      destination={job.destination}
                    />
                  </div>
                </section>

                {/* Block 2 — Load details */}
                <section className="sd-card-block">
                  <div className="sd-card-block-title">
                    <h4>Load details</h4>
                  </div>
                  <div className="sd-card-block-body">
                    <div className="sd-job-meta">
                      <div className="sd-job-meta-item">
                        <span>Load</span>
                        <strong>{job.load || 'Produce'}</strong>
                      </div>
                      {job.requiredCapacity && (
                        <div className="sd-job-meta-item">
                          <span>Capacity</span>
                          <strong>{job.requiredCapacity}t+</strong>
                        </div>
                      )}
                      <div className="sd-job-meta-item">
                        <span>Arrangement</span>
                        <strong>{getArrangingPartyLabel(job.arrangingParty)}</strong>
                      </div>
                    </div>

                    {workSummary && (
                      <div className="sd-job-requirements">
                        <span className="sd-job-requirements-label">Work details</span>
                        <p>{workSummary}</p>
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

                {/* Block 3 — Your quote (only while a thread is live) */}
                {hasActiveThread && (
                  <section className="sd-card-block">
                    <div className="sd-card-block-title">
                      <h4>{isMyTurn ? 'Counter-offer' : 'Your quote'}</h4>
                      <span className="sd-card-block-note">
                        {isMyTurn ? 'Your turn' : 'Waiting'}
                      </span>
                    </div>
                    <div className="sd-card-block-body">
                      <AmountRow value={quoteAmount} />
                      <p className="sd-amount-note">
                        {isMyTurn
                          ? 'The requester countered this price.'
                          : 'Waiting on the requester’s decision.'}
                      </p>
                    </div>
                  </section>
                )}

                {hasWaitingBid && (
                  <section className="sd-card-block">
                    <div className="sd-card-block-title">
                      <h4>Your waiting bid</h4>
                      <span className="sd-card-block-note">Pending</span>
                    </div>
                    <div className="sd-card-block-body">
                      <AmountRow value={fmtMoney(myLeaf.amount)} />
                      <p className="sd-amount-note">
                        The requester has not selected your bid yet. You can withdraw
                        it to stop waiting, or leave it open for selection.
                      </p>
                    </div>
                  </section>
                )}

                {hasAgreement && (
                  <section className="sd-card-block">
                    <div className="sd-card-block-title">
                      <h4>Agreement reached</h4>
                      <span className="sd-card-block-note">Provisional</span>
                    </div>
                    <div className="sd-card-block-body">
                      <AmountRow value={fmtMoney(myLeaf.counterAmount ?? myLeaf.amount)} />
                      <p className="sd-amount-note">
                        Your price was accepted. The deal becomes final once the requester pays for transport.
                      </p>
                    </div>
                  </section>
                )}

                {createdLabel && <p className="sd-card-foot">Created {createdLabel}</p>}

                {/* Footer */}
                {showFooter && (
                  <div className="sd-card-actions">
                    {canQuote && (
                      <button
                        type="button"
                        className="sd-btn sd-btn-primary"
                        disabled={quoting}
                        onClick={() => respondToJob(job)}
                      >
                        {quoting ? 'Sending…' : 'Submit transport quote'}
                      </button>
                    )}

                    {hasWaitingBid && (
                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={respondBusy}
                        onClick={() => withdrawWaitingBid(job.id, myLeaf.id)}
                      >
                        {respondBusy ? 'Withdrawing…' : 'Withdraw waiting bid'}
                      </button>
                    )}

                    {isMyTurn && (
                      <>
                        <button
                          type="button"
                          className="sd-btn sd-btn-primary"
                          disabled={respondBusy}
                          onClick={() => acceptTransportQuote(job.id, myLeaf.id)}
                        >
                          {respondBusy ? 'Accepting…' : 'Accept'}
                        </button>
                        <button
                          type="button"
                          className="sd-btn sd-btn-outline"
                          disabled={respondBusy}
                          onClick={() => counterTransportQuote(job.id, myLeaf.id, myLeaf.counterAmount ?? myLeaf.amount)}
                        >
                          {respondBusy ? 'Sending…' : 'Counter'}
                        </button>
                        <button
                          type="button"
                          className="sd-btn sd-btn-outline"
                          disabled={respondBusy}
                          onClick={() => rejectTransportQuote(job.id, myLeaf.id)}
                        >
                          {respondBusy ? 'Rejecting…' : 'Reject'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}

        {openJobs.length === 0 && (
          <div className="sd-empty-state">
            <div className="sd-empty-icon" aria-hidden="true">📭</div>
            <h3>No open transport requests</h3>
            <p className="sd-muted">
              New requests will appear here when buyers or sellers choose <strong>Hire Transporter</strong> through MarketBridge.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
