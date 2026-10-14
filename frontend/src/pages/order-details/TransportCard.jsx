import React from 'react';

import api from '../../api/client';
import AmountPicker from '../../components/AmountPicker.jsx';
import EvidenceGallery from '../../components/EvidenceGallery.jsx';
import { TransportLoadingReportSummary } from '../../components/TransportLoadingReport.jsx';
import { TransportRequestSummary } from '../../components/RequestScopeSummary.jsx';
import ReleaseAgreementControl from './OrderDetailReleaseControl.jsx';
import {
  Avatar,
  Button,
  Card,
  Facts,
  Fact,
  Pill,
  Section,
  SideLabel,
} from './OrderDetailPrimitives.jsx';
import {
  formatDateTime,
  label,
  leafQuotes,
  money,
  statusTone,
} from './orderDetailUtils.js';

// ============================================================================
// TRANSPORT CARD
// ============================================================================
//
// Extracted from OrderDetail.jsx. Contains:
//   • TransportCard   — the main "Transport" card
//   • QuoteRow        — internal row for individual transporter quotes
//   • transportReleaseAvailableAt — small helper used by QuoteRow
//
// Same props, same behavior, same rendering. Pure relocation.
// ============================================================================

const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

const TRANSPORT_RELEASE_AFTER_HOURS = (() => {
  const configured = Number(import.meta?.env?.VITE_TRANSPORT_RELEASE_AFTER_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 72;
})();

function transportReleaseAvailableAt(quote) {
  if (!quote) return null;
  const providerTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');
  if (!providerTurn) return null;
  const since = new Date(quote.updatedAt || quote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + TRANSPORT_RELEASE_AFTER_HOURS * 60 * 60 * 1000);
}

function QuoteRow({ quote, t, hasActiveNegotiation }) {
  const key = `quote-${quote.id}`;
  const working = t.busy === key;
  const amount = quote.status === 'COUNTERED' ? quote.counterAmount ?? quote.amount : quote.amount;

  const releaseAt = transportReleaseAvailableAt(quote);
  const releaseLocked = releaseAt !== null && releaseAt.getTime() > Date.now();

  const isArrangerTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');

  const canRespond = t.canChooseQuote && isArrangerTurn;
  const rating = typeof quote.truckOwner?.rating === 'number' ? quote.truckOwner.rating.toFixed(1) : '—';
  const ownerName = quote.truckOwner?.name || 'Truck owner';

  const isWaitingPending =
    (quote.status === 'PENDING' || quote.status === 'WAITING') &&
    !['REQUESTED', 'QUOTED'].includes(t.job?.status);

  return (
    <div className="transporter">
      <div>
        <div className="od-person">
          <Avatar small name={ownerName} />
          <strong>{ownerName}</strong>
        </div>
        <p>
          {quote.truck?.truckType || 'Truck'} · {quote.truck?.capacity != null ? `${quote.truck.capacity}t` : 'Capacity —'} ·{' '}
          {quote.truck?.registration || 'Registration —'} · ★ {rating}
        </p>
        {quote.message && <p className="muted">{quote.message}</p>}
        <p>
          Status: <span className="badge">{quote.status || 'PENDING'}</span>
          {isWaitingPending && <span className="badge od-badge-inline">Waiting</span>}
        </p>
        {quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER' && (
          <p className="muted">You countered {money(amount)} ETB — waiting for the transporter.</p>
        )}
        {isWaitingPending && (
          <p className="muted small">
            This transporter stays queued until the selected transport is delivered.
          </p>
        )}
      </div>

      <div>
        <strong>{money(amount)} ETB</strong>

        {t.canChooseQuote && quote.status === 'PENDING' && (
          <>
            {hasActiveNegotiation ? (
              <span className="muted small">
                Locked — another transporter bid is currently in negotiation or
                provisionally accepted. Release it first to select this bid.
              </span>
            ) : (
              <>
                <Button variant="primary" size="sm" disabled={working} busy={working} busyText="Selecting…" onClick={() => t.selectQuote(quote.id)}>
                  Select bid for deal
                </Button>
                <span className="muted small">Selecting opens price negotiation.</span>
              </>
            )}
          </>
        )}

        {canRespond && (
          <div className="od-quote-actions">
            <Button size="sm" disabled={working} busy={working} busyText="Accepting…" onClick={() => t.acceptQuote(quote.id)}>
              Accept quote
            </Button>
            <AmountPicker
              className="field-inline"
              reference={Number(quote.counterAmount ?? quote.amount)}
              min={1}
              placeholder="Counter (ETB)"
              value={t.counterInputs[quote.id] || ''}
              onChange={(v) => t.setCounterInputs((q) => ({ ...q, [quote.id]: v }))}
              ariaLabel="Counter amount in ETB"
            />
            <Button
              variant="light"
              size="sm"
              disabled={working || !Number(t.counterInputs[quote.id])}
              busy={working}
              busyText="Sending…"
              onClick={() => t.counterQuote(quote.id)}
            >
              Counter
            </Button>
            <Button variant="light" size="sm" disabled={working} busy={working} busyText="Rejecting…" onClick={() => t.rejectQuote(quote.id)}>
              Reject
            </Button>
          </div>
        )}

        {t.isArranger && !t.pending && (
          quote.status === 'ACCEPTED' ? (
            <>
              <span className="muted small">Provisional agreement — the truck is not committed until transport payment succeeds.</span>
              <ReleaseAgreementControl
                acceptedQuote={quote}
                label="Transporter unavailable — choose another"
                busy={working}
                disabled={working}
                onConfirm={(reason, note) => t.releaseQuote(quote.id, { reason, note })}
              />
            </>
          ) : (quote.status === 'SELECTED' ||
              (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER')) ? (
            releaseLocked ? (
              <span className="muted small">
                The waiting window has not elapsed. If the truck owner stays
                silent, you can release them from {formatDateTime(releaseAt)}.
              </span>
            ) : (
              <>
                <span className="muted small">
                  You can release this truck owner if they stay silent.
                </span>
                <Button variant="light" size="sm" disabled={working} busy={working} busyText="Releasing…" onClick={() => t.releaseQuote(quote.id)}>
                  Release silent truck owner
                </Button>
              </>
            )
          ) : null
        )}
      </div>
    </div>
  );
}

export default function TransportCard({ order, t }) {
  const job = t.job;
  const hired = job?.method === 'HIRE_TRANSPORTER';
  const quotes = leafQuotes(job?.quotes);
  const pendingLeafCount = quotes.filter((q) => ['PENDING', 'WAITING'].includes(q.status)).length;

  const hasActiveNegotiation = quotes.some((q) =>
    ['SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
  );
  const liveBidderCount = quotes.filter((q) => ['PENDING', 'WAITING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)).length;

  if (!job) {
    return (
      <Card
        id="transport-section"
        eyebrow="Logistics"
        title="Transport"
        subtitle="Either you or the counterparty may arrange transport. Once one of you does, the other cannot create a competing arrangement."
      >
        {t.canArrange && t.blockedReason ? (
          <Section title="Arrange transport">
            <p className="muted">{t.blockedReason}</p>
          </Section>
        ) : t.canArrange ? (
          <Section title="Arrange transport">
            <p className="muted">
              Open the transport request to define the trip scope and choose
              between hiring a registered transporter or using the owner's own
              truck.
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => t.onOpenModal('transport-setup-form')}
            >
              Open transport request
            </Button>
          </Section>
        ) : (
          <p className="muted">
            {t.buyerOnly ? 'The buyer requests transport for this order once the purchase decision is made.' : 'No transport arrangement recorded yet.'}
          </p>
        )}
      </Card>
    );
  }

  const loadingReportDone = Boolean(t.loadingReport);
  const showLoadingSummary =
    loadingReportDone && !(t.isTransporter && job.status === 'ACCEPTED');

  const hasEvidenceContent =
    job.status === 'IN_TRANSIT' ||
    job.status === 'DELIVERED' ||
    job.incidentNotes;

  const quotesSectionVisible =
    hired &&
    job.status !== 'CANCELLED' &&
    job.status !== 'DELIVERED';

  return (
    <div className="od-card-grid">
      <Card
        id="transport-section"
        eyebrow="Logistics"
        title="Transport"
        subtitle="The physical trip — who drives, where from, and where to."
        side={
          job?.status && (
            <SideLabel name="Status">
              <Pill tone={statusTone(job.status)}>{label(job.status)}</Pill>
            </SideLabel>
          )
        }
      >
        <Section title="Trip details" meta={job.method || '—'}>
          <Facts>
            <Fact name="Arranged by">{job.arrangingParty || '—'}</Fact>
            <Fact name="Pickup">{job.pickupLocation || '—'}</Fact>
            <Fact name="Destination">{job.destination || '—'}</Fact>
            {job.load && <Fact name="Load">{job.load}</Fact>}
            {job.requiredCapacity != null && (
              <Fact name="Required capacity">{job.requiredCapacity}</Fact>
            )}
          </Facts>
          {(job.workDetails || job.specialRequirements) && (
            <TransportRequestSummary job={job} compact title="Transport work requirements" />
          )}
        </Section>

        {job.truckOwner && (
          <Section
            title="Transporter"
            meta={
              <>
                <strong>{job.truckOwner.name || '—'}</strong>
                <Avatar name={job.truckOwner.name} />
              </>
            }
            strong
          >
            {job.truckOwner.phone && (
              <p className="muted">Phone: {job.truckOwner.phone}</p>
            )}
            {job.truck && (
              <p>
                Truck: <strong>{job.truck.registration || '—'}</strong> ·{' '}
                {job.truck.truckType || 'Truck'}
                {job.truck.capacity != null && ` · ${job.truck.capacity}t`}
              </p>
            )}
          </Section>
        )}

        {['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status) && t.isSeller && (
          <Section title="Coordination">
            <Button variant="light" size="sm" onClick={() => t.onOpenModal('seller-transport-coordination')}>
              Open pickup handoff
            </Button>
          </Section>
        )}

        {t.isSeller && job.status === 'ACCEPTED' && !job.sellerPickupConfirmedAt && (
          <Section title="Loading preparation">
            <p className="muted small">
              Confirm that the goods are ready and the loading site is prepared
              for the transporter.
            </p>
            <Button
              variant="primary"
              size="sm"
              disabled={t.busy === `seller-confirm-pickup-${job.id}`}
              busy={t.busy === `seller-confirm-pickup-${job.id}`}
              busyText="Confirming…"
              onClick={() =>
                t.run(
                  `seller-confirm-pickup-${job.id}`,
                  () => api.post(`/transport/${job.id}/seller-confirm-pickup`),
                  'Could not confirm loading preparation'
                )
              }
            >
              Confirm loading preparation
            </Button>
          </Section>
        )}

        {t.isSeller &&
          job.status === 'ACCEPTED' &&
          job.sellerPickupConfirmedAt &&
          !job.truckArrivedAt && (
            <Section title="Truck arrival">
              <p className="muted small">
                Confirm that the truck has physically arrived on site and is
                ready to load.
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={t.busy === `seller-truck-arrived-${job.id}`}
                busy={t.busy === `seller-truck-arrived-${job.id}`}
                busyText="Confirming…"
                onClick={() =>
                  t.run(
                    `seller-truck-arrived-${job.id}`,
                    () => api.post(`/transport/${job.id}/truck-arrived`),
                    'Could not confirm truck arrival'
                  )
                }
              >
                Confirm truck arrived
              </Button>
            </Section>
          )}

        {job.truckArrivedAt && (
          <Section title="Truck arrival" meta={formatDateTime(job.truckArrivedAt)} strong />
        )}

        {showLoadingSummary && (
          <>
            <TransportLoadingReportSummary
              loadingReport={t.loadingReport}
              evidence={t.loadingReportEvidence}
            />
            {t.isBuyer && job.status === 'ACCEPTED' && t.loadingReport && !job.buyerLoadingConfirmedAt && (
              <div className="od-card-section">
                <div className="od-card-section-head">
                  <h3 className="od-card-section-title">Review before loading</h3>
                </div>
                <p className="muted small">Review what the transporter plans to load, the quantity, timing and condition. Approving this report unlocks the goods payment.</p>
                <Button
                  variant="primary"
                  disabled={t.busy === 'confirm-loading'}
                  busy={t.busy === 'confirm-loading'}
                  busyText="Confirming…"
                  onClick={() => t.run('confirm-loading', () => api.post(`/transport/${job.id}/confirm-loading`), 'Could not approve the loading report')}
                >
                  Approve loading report
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {hasEvidenceContent && (
        <Card
          id="transport-evidence-section"
          eyebrow="Evidence"
          title="Trip evidence"
          subtitle="Photos, videos and handover notes uploaded by the transporter during the trip."
          side={
            job.status === 'DELIVERED' ? (
              <SideLabel name="Delivery">
                <Pill tone="good">Delivered</Pill>
              </SideLabel>
            ) : null
          }
        >
          <Section title="Evidence requirements">
            <p className="muted">
              Loading evidence is captured through the loading report above. The
              transporter uploads pickup and delivery evidence from their own
              dashboard before advancing the trip stages.
            </p>
          </Section>

          <Section title="Evidence gallery">
            <EvidenceGallery
              listUrl={`/transport/${job.id}/evidence`}
              mediaUrl={(evidenceId) => `/transport/${job.id}/evidence/${evidenceId}/media`}
            />
          </Section>

          {job.status === 'DELIVERED' && (
            <Section title="Delivery">
              <p><strong>✓ Transport marked as delivered.</strong></p>
              {job.deliveredConfirmedAt && (
                <p className="muted">Delivery confirmed.</p>
              )}
            </Section>
          )}

          {job.incidentNotes && (
            <div className="alert">
              <strong>Transport notes:</strong> {job.incidentNotes}
            </div>
          )}
        </Card>
      )}

      <Card
        id="transport-payment-section"
        eyebrow="Payment"
        title="Transport payment"
        subtitle="Select and pay the transporter. Separate from the seller payment and any inspection fee."
        side={
          hired && job.agreedAmount != null ? (
            <SideLabel name="Fee">
              <span className="od-card-side-value">{money(job.agreedAmount)} ETB</span>
            </SideLabel>
          ) : null
        }
      >
        {quotesSectionVisible && (
          <Section
            title={
              t.paid
                ? `Waiting transporter bids (${pendingLeafCount})`
                : 'Transport quotes'
            }
            meta="Bids"
          >
            {quotes.length ? (
              quotes.map((q) => (
                <QuoteRow
                  key={q.id}
                  quote={q}
                  t={t}
                  hasActiveNegotiation={hasActiveNegotiation}
                />
              ))
            ) : (
              <p className="muted">
                Waiting for registered truck owners to submit quotes.
              </p>
            )}
            {pendingLeafCount > 0 && t.paid && (
              <p className="muted small od-mt-8">
                {pendingLeafCount} transporter bid(s) are still waiting. They will be
                released automatically once this transport is delivered.
              </p>
            )}
          </Section>
        )}

        {job.method === 'OWN_TRUCK' && (
          <Section title="Transport payment">
            <p><strong>No separate transporter payment is required.</strong></p>
            <p className="muted">
              This order uses the owner's own truck, so no transport payment is created.
            </p>
          </Section>
        )}

        {hired && !t.paid && (
          <Section
            title="Fee due"
            meta={job.agreedAmount != null ? `${money(job.agreedAmount)} ETB` : null}
            strong
          >
            <p className="muted">
              Transport payment is separate from the seller payment. Pay the transporter
              once the quote is accepted. The seller coordination, driver arrival and
              loading-prep report all follow this payment.
            </p>

            {t.canStartPayment && (
              <div className="od-field-row">
                <select
                  className="field field-inline"
                  value={t.payMethod}
                  onChange={(e) => t.setPayMethod(e.target.value)}
                  disabled={t.busy === 'pay-transport'}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={t.busy === 'pay-transport'}
                  busy={t.busy === 'pay-transport'}
                  busyText="Submitting…"
                  onClick={t.pay}
                >
                  Pay for transport
                </Button>
              </div>
            )}

            {t.canResumePayment && (
              <>
                <p>
                  Pending payment: <strong>{t.payment.method || '—'}</strong>,{' '}
                  {money(t.payment.amount)} ETB. It was started but not completed.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={t.busy === 'resume-transport'}
                  busy={t.busy === 'resume-transport'}
                  busyText="Redirecting…"
                  onClick={() => t.resume(t.payment.id, 'resume-transport')}
                >
                  Resume payment
                </Button>
              </>
            )}
          </Section>
        )}

        {t.paid && (
          <Section
            title="Transport payment confirmed"
            meta={`${money(t.paidAmount)} ETB`}
            strong
          />
        )}

        {t.isArranger &&
          ['REQUESTED', 'QUOTED', 'ACCEPTED', 'CANCELLED'].includes(job.status) && (
            <Section title="Transport recovery">
              <p className="muted">
                If the transporter withdrew or the arrangement was cancelled, request admin review. The order stays separate from this service issue; a fresh competition opens only after approval and any required refund is resolved.
              </p>
              {t.recoveryRequests
                .filter((r) => r.type === 'TRANSPORT')
                .map((r) => (
                  <p className="muted small" key={r.id}>
                    Recovery: <strong>{r.status}</strong>
                    {r.formReleasedAt
                      ? ' — fresh form released'
                      : ' — awaiting admin approval'}
                  </p>
                ))}
              {liveBidderCount > 0 && (
                <p className="muted small">
                  {liveBidderCount} transporter bid(s) are still waiting or pending. A fresh form can be released only when none remain — they stay pending until the selected transporter delivers.
                </p>
              )}
              <Button
                variant="primary"
                disabled={
                  Boolean(t.busy) ||
                  liveBidderCount > 0 ||
                  t.recoveryRequests.some(
                    (r) => r.type === 'TRANSPORT' && r.status === 'PENDING'
                  )
                }
                busy={t.busy === 'recovery-transport'}
                busyText="Requesting…"
                onClick={t.requestRecovery}
              >
                Request admin review for new transport bids
              </Button>
            </Section>
          )}
      </Card>
    </div>
  );
}
