import React from 'react';

import AmountPicker from '../../components/AmountPicker.jsx';
import OrderDecisionPanel from '../../components/OrderDecisionPanel.jsx';
import { InspectionRequestSummary } from '../../components/RequestScopeSummary.jsx';
import ReleaseAgreementControl from './OrderDetailReleaseControl.jsx';
import {
  Actions,
  Avatar,
  Button,
  Card,
  Fact,
  Facts,
  Finding,
  Notice,
  PartyBadge,
  Pill,
  Section,
  SideLabel,
} from './OrderDetailPrimitives.jsx';
import {
  formatDateTime,
  label,
  leafQuotes,
  money,
  shortId,
  statusTone,
} from './orderDetailUtils.js';

// ============================================================================
// INSPECTION CARD
// ============================================================================
//
// Extracted from OrderDetail.jsx. Contains:
//   • InspectionCard — the main "Inspection" card
//
// InspectionRequestForm (the popup modal for opening a new inspection
// competition) stays in OrderDetail.jsx because it is only used by the
// page-level Modal, not by the card itself.
//
// Same props, same behavior, same rendering. Pure relocation.
// ============================================================================

export default function InspectionCard({ order, title, i }) {
  const request = i.current;

  if (!request) {
    const needsApproval = i.all.length > 0 && !i.formReleased;
    return (
      <Card id="inspection-section" eyebrow="Inspection" title={needsApproval ? 'Inspection request awaiting admin approval' : 'Request an inspection'}>
        <Section title="How it works">
          <p className="muted">
            Get an independent quality check before the purchase is committed. Registered inspectors compete by sending a
            sealed fee quote. You compare bids, pick one to negotiate with, and the accepted quote assigns the inspector.
            You review the finished report before paying for the goods.
          </p>
        </Section>
        {needsApproval ? (
          <Notice title="Admin approval required">
            <p>Ask MarketBridge admin to release a fresh inspection form before opening another competition.</p>
          </Notice>
        ) : (
          <Section title="Start inspection">
            <p className="muted">Open the form to describe the inspection scope and start the competition.</p>
            <Button variant="primary" size="sm" onClick={() => i.onOpenModal('inspection-request-form')}>
              Open inspection form
            </Button>
          </Section>
        )}
      </Card>
    );
  }

  const report = request.report;
  const reportReady = Boolean(report);
  const leafList = leafQuotes(request.quotes);
  const pendingLeafCount = leafList.filter((q) => ['PENDING', 'WAITING'].includes(q.status)).length;
  const liveBidderCount = leafList.filter((q) => ['PENDING', 'WAITING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)).length;
  const inspectorName = request.inspector?.name || null;
  const inspectionDate =
    report?.inspectedAt || report?.completedAt || request.completedAt || request.updatedAt || request.createdAt || null;

  const side = inspectorName ? (
    <PartyBadge role="Inspector" name={inspectorName} />
  ) : (
    <SideLabel name="Status">
      <Pill tone={statusTone(request.status)}>{label(request.status)}</Pill>
    </SideLabel>
  );

  const isRequester = request.requestedById === i.currentUserId;
  const quotes = leafList;
  const counterKeyFor = (quoteId) => `inspection-counter-${quoteId}`;
  const busyKey = (quoteId, action) => `inspection-quote-${quoteId}-${action}`;
  const isBusy = (quoteId, action) => i.busy === busyKey(quoteId, action);

  const inspectionObligations = (order?.paymentObligations || []).filter(
    (o) => o.type === 'INSPECTOR' && o.inspectionRequestId === request.id
  );
  const myInspectionObligation = inspectionObligations.find(
    (o) => o.payerId === i.currentUserId
  ) || null;
  const feePaid = inspectionObligations.length
    ? inspectionObligations.every((o) => o.status === 'PAID' || o.payment?.status === 'PAID')
    : (request.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID');
  const feePending = Boolean(
    myInspectionObligation?.payment?.status === 'PENDING' ||
    myInspectionObligation?.payment?.status === 'PROCESSING'
  );

  const acceptedLeaf = leafList.find((q) => q.status === 'ACCEPTED');
  const viewerIsAssignedInspector = request.inspectorId && request.inspectorId === i.currentUserId;

  const showBidsSection =
    !['CANCELLED', 'STALLED'].includes(request.status) &&
    (request.status === 'REQUESTED' ||
      request.status === 'ACCEPTED' ||
      request.status === 'IN_PROGRESS' ||
      request.status === 'COMPLETED');

  return (
    <Card
      id="inspection-section"
      eyebrow="Inspection"
      title={reportReady ? 'Quality report' : 'Inspection status'}
      subtitle={reportReady ? 'Review the findings before the purchase is committed.' : null}
      side={side}
    >
      <Section title="Inspection details" meta={`INS ${shortId(request.id).toUpperCase()}`}>
        <Facts>
          {reportReady && <Fact name="Product">{order.listing?.cropType || title}</Fact>}
          {reportReady && <Fact name="Quantity">{order.listing?.quantity != null ? `${order.listing.quantity} units` : '—'}</Fact>}
          {reportReady && <Fact name="Location">{order.listing?.location || '—'}</Fact>}
          <Fact name="Requested by">{request.mode === 'SELLER_REQUESTED' ? 'Seller' : 'Buyer'}</Fact>
          <Fact name="Requested on">{formatDateTime(request.createdAt)}</Fact>
          {reportReady && <Fact name="Inspection date">{formatDateTime(inspectionDate)}</Fact>}
          {inspectorName && <Fact name="Inspected by">{inspectorName}</Fact>}
          {request.fee != null && <Fact name="Inspection fee">{money(request.fee)} ETB</Fact>}
          {!inspectorName && <Fact name="Status">{label(request.status)}</Fact>}
        </Facts>
        <InspectionRequestSummary inspection={request} title="Agreed inspection scope" />
      </Section>

      {i.isSeller && ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(request.status) && (
        <Section
          title={
            request.status === 'ACCEPTED' && !request.sellerConfirmedAt
              ? 'Next step: confirm the inspector on-site'
              : 'Inspection coordination'
          }
        >
          <p className="muted small">
            {request.status === 'ACCEPTED' && !request.sellerConfirmedAt
              ? 'Open the coordination handoff below. Once you and the inspector have both shared your site and arrival details, use "Confirm inspector is on-site and ready" inside that panel to unlock the buyer\'s fee payment.'
              : 'Share site access and coordination details with the inspector.'}
          </p>
          <Button
            variant={request.status === 'ACCEPTED' && !request.sellerConfirmedAt ? 'primary' : 'light'}
            size="sm"
            onClick={() => i.onOpenModal('inspection-coordination')}
          >
            {request.status === 'ACCEPTED' && !request.sellerConfirmedAt
              ? 'Open handoff & confirm inspector'
              : 'Open inspection coordination'}
          </Button>
        </Section>
      )}

      {showBidsSection && quotes.length > 0 && (
        <Section
          title={
            request.status === 'REQUESTED'
              ? 'Inspector bids'
              : pendingLeafCount > 0
                ? `Waiting inspector bids (${pendingLeafCount})`
                : 'Inspector bids'
          }
          meta={`${quotes.length} bid${quotes.length === 1 ? '' : 's'}`}
        >
          {!isRequester && request.status === 'REQUESTED' ? (
            <p className="muted">
              {quotes.length === 0
                ? 'Waiting for registered inspectors to submit sealed bids.'
                : `The requester is reviewing ${quotes.length} inspector bid(s). You will see the assigned inspector once a quote is accepted.`}
            </p>
          ) : !isRequester ? (
            <p className="muted">
              The requester is reviewing inspector bids. You will see the assigned inspector once a quote is accepted.
            </p>
          ) : quotes.length === 0 ? (
            <p className="muted">
              Waiting for registered inspectors to submit sealed bids. You can compare
              all bids, then select one for price negotiation.
            </p>
          ) : (
            <>
              <div className="od-card-grid">
                {quotes.map((quote) => {
                  const displayAmount =
                    quote.status === 'COUNTERED'
                      ? quote.counterAmount ?? quote.amount
                      : quote.amount;
                  const isPending = quote.status === 'PENDING';
                  const isSelected = quote.status === 'SELECTED';
                  const isCounteredByProvider =
                    quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER';
                  const isCounteredByRequester =
                    quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';
                  const requesterCanAct =
                    isRequester && request.status === 'REQUESTED' && (isSelected || isCounteredByProvider);
                  const canSelect = isRequester && request.status === 'REQUESTED' && isPending;
                  const isWaiting = (isPending || quote.status === 'WAITING') && request.status !== 'REQUESTED';

                  return (
                    <div className="transporter" key={quote.id}>
                      <div>
                        <div className="od-person">
                          <Avatar small name={quote.inspector?.name || 'Inspector'} />
                          <strong>{quote.inspector?.name || 'Inspector'}</strong>
                        </div>
                        <p>
                          {quote.inspector?.location || 'Location not set'}
                          {typeof quote.inspector?.rating === 'number' &&
                            ` · ★ ${quote.inspector.rating.toFixed(1)}`}
                          {quote.inspector?.verificationStatus &&
                            ` · ${quote.inspector.verificationStatus}`}
                        </p>
                        {quote.message && <p className="muted">{quote.message}</p>}
                        <p>
                          Status:{' '}
                          <span className="badge">{label(quote.status || 'PENDING')}</span>
                          {isWaiting && (
                            <span className="badge od-badge-inline">Waiting</span>
                          )}
                        </p>
                        {isCounteredByRequester && (
                          <p className="muted small">
                            You countered {money(displayAmount)} ETB — waiting for the
                            inspector.
                          </p>
                        )}
                        {isWaiting && (
                          <p className="muted small">
                            This inspector stays queued until the selected inspection is completed.
                          </p>
                        )}
                      </div>

                      <div>
                        <strong>{money(displayAmount)} ETB</strong>

                        {canSelect && (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isBusy(quote.id, 'select')}
                              busy={isBusy(quote.id, 'select')}
                              busyText="Selecting…"
                              onClick={() => i.selectInspectionQuote(quote.id)}
                            >
                              Select bid for deal
                            </Button>
                            <span className="muted small">
                              Selecting opens price negotiation.
                            </span>
                          </>
                        )}

                        {requesterCanAct && (
                          <div className="od-quote-actions">
                            <Button
                              size="sm"
                              disabled={isBusy(quote.id, 'accept')}
                              busy={isBusy(quote.id, 'accept')}
                              busyText="Accepting…"
                              onClick={() => i.acceptInspectionQuote(quote.id)}
                            >
                              Accept quote
                            </Button>
                            <AmountPicker
                              className="field-inline"
                              reference={Number(quote.counterAmount ?? quote.amount)}
                              min={1}
                              placeholder="Counter (ETB)"
                              value={
                                i.counterInputs[counterKeyFor(quote.id)] || ''
                              }
                              onChange={(v) =>
                                i.setCounterInputs((prev) => ({
                                  ...prev,
                                  [counterKeyFor(quote.id)]: v,
                                }))
                              }
                              ariaLabel="Counter amount in ETB"
                            />
                            <Button
                              variant="light"
                              size="sm"
                              disabled={isBusy(quote.id, 'counter') || !Number(i.counterInputs[counterKeyFor(quote.id)])}
                              busy={isBusy(quote.id, 'counter')}
                              busyText="Sending…"
                              onClick={() =>
                                i.counterInspectionQuote(
                                  quote.id,
                                  counterKeyFor(quote.id)
                                )
                              }
                            >
                              Counter
                            </Button>
                            <Button
                              variant="light"
                              size="sm"
                              disabled={isBusy(quote.id, 'reject')}
                              busy={isBusy(quote.id, 'reject')}
                              busyText="Rejecting…"
                              onClick={() => i.rejectInspectionQuote(quote.id)}
                            >
                              Reject
                            </Button>
                          </div>
                        )}

                        {isPending && request.status === 'REQUESTED' && isRequester && !canSelect && (
                          <span className="muted small">
                            Locked — another inspector bid is in negotiation. Resolve it first.
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {pendingLeafCount > 0 && request.status !== 'REQUESTED' && (
                <p className="muted small od-mt-8">
                  {pendingLeafCount} inspector bid(s) are still waiting. They will be
                  released automatically once this inspection is completed.
                </p>
              )}
            </>
          )}
        </Section>
      )}

      {request.status === 'ACCEPTED' && request.fee != null && (
        <Section title={request.sellerConfirmedAt ? 'Inspector confirmed — fee payment' : 'Inspector provisionally selected'}>
          <p className="muted">
            {!request.sellerConfirmedAt
              ? 'The inspector and fee are provisionally agreed. The seller must confirm them before inspection payment can begin.'
              : !request.inspectorOnSiteConfirmedAt
                ? 'Fee confirmed. Now the seller confirms the inspector has physically arrived on site and is ready to start.'
                : 'Fee confirmed and inspector on site. The designated payer(s) may now pay the inspection fee.'}
          </p>
          <p>
            Fee: <strong>{money(request.fee)} ETB</strong>
          </p>

          {feePaid ? (
            <p className="muted small">Inspection fee paid.</p>
          ) : feePending ? (
            <p className="muted small">
              A payment for this inspection is pending or processing.
            </p>
          ) : !request.sellerConfirmedAt ? (
            <p className="muted small">
              Waiting for the seller to confirm the selected inspector and agreed fee.
              {request.workflowDueAt ? ` Deadline: ${new Date(request.workflowDueAt).toLocaleString()}.` : ''}
            </p>
          ) : !request.inspectorOnSiteConfirmedAt ? (
            <p className="muted small">
              Waiting for the seller to confirm the inspector is on site and ready to start.
            </p>
          ) : (
            <p className="muted small">
              Ready to pay. Use the Action Center above to make the inspection payment.
            </p>
          )}

          {isRequester && (
            <div className="od-mt-12">
              <ReleaseAgreementControl
                acceptedQuote={acceptedLeaf}
                label="Inspector unavailable — choose another"
                busy={i.busy === `withdraw-inspection-${request.id}`}
                disabled={Boolean(i.busy)}
                onConfirm={(reason, note) => i.withdrawInspectionAgreement(request.id, { reason, note })}
              />
              <p className="muted small od-mt-6">
                Provisional agreement — release it if the inspector drops out
                before payment.
              </p>
            </div>
          )}

          {viewerIsAssignedInspector && acceptedLeaf && (
            <div className="od-mt-12">
              <Button
                variant="light"
                size="sm"
                disabled={Boolean(i.busy)}
                onClick={() => i.openProviderRelease({
                  service: 'INSPECTION',
                  quoteId: acceptedLeaf.id,
                  inspectionRequestId: request.id,
                })}
              >
                Cancel provisional agreement
              </Button>
              <p className="muted small od-mt-6">
                Your provisional agreement is not committed yet. Cancelling it
                releases the slot for another inspector and is recorded against
                your standing.
              </p>
            </div>
          )}
        </Section>
      )}

      {reportReady ? (
        <>
          <Section title="Findings">
            <Facts>
              <Fact name="Visible defects"><Finding text={report.visibleDefects} empty="No defects" /></Fact>
              <Fact name="Damage notes"><Finding text={report.damageNotes} empty="No damage" /></Fact>
              <Fact name="Packaging"><Finding text={report.packagingNotes} empty="Fully packed" /></Fact>
            </Facts>
          </Section>

          {i.isParticipant && (
            <OrderDecisionPanel
              order={order}
              currentUserId={i.currentUserId}
              isBuyer={i.isBuyer}
              isSeller={i.isSeller}
              isParticipant={i.isParticipant}
              busy={i.busy}
              onBuy={i.onBuy}
              onCancel={i.onCancel}
              onProposePrice={i.onProposePrice}
              onRespondReview={i.onRespondReview}
              onScrollToPayment={i.onScrollToPayment}
            />
          )}
        </>
      ) : (
        ['REQUESTED', 'ACCEPTED'].includes(request.status) && (i.isAdmin || i.isParticipant) && (
          <Section title="Inspection recovery">
            <p className="muted">
              {i.isAdmin
                ? 'If every inspector bid is closed, reopen bidding. If the request is no longer wanted, cancel it without cancelling the order.'
                : 'If you no longer want this request, cancel it without cancelling the order. Only MarketBridge admin can release a fresh inspection form.'}
            </p>
            {liveBidderCount > 0 && (
              <p className="muted small">
                {liveBidderCount} inspector bid(s) are still waiting or pending. A fresh form can be released only when none remain — they stay on the waiting list until the selected inspector submits the report.
              </p>
            )}
            <Actions>
              {i.isAdmin && (
                <Button variant="primary" disabled={Boolean(i.busy) || liveBidderCount > 0} busy={i.busy === `reopen-inspection-${request.id}`} busyText="Releasing…" onClick={i.reopenBidding}>
                  Release fresh inspection form
                </Button>
              )}
              <Button variant="light" disabled={Boolean(i.busy)} busy={i.busy === `cancel-inspection-${request.id}`} busyText="Cancelling…" onClick={i.cancel}>
                Cancel inspection request
              </Button>
            </Actions>
          </Section>
        )
      )}
    </Card>
  );
}
