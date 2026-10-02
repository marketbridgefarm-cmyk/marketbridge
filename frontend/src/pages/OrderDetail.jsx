import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';

import RatingBox from '../components/RatingBox.jsx';
import MessageThread from '../components/MessageThread.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import ActionCenter from '../components/ActionCenter.jsx';
import OrderTimeline from '../components/OrderTimeline.jsx';
import PaymentCenter from '../components/PaymentCenter.jsx';
import TransportSetup from '../components/TransportSetup.jsx';
import RefundStatusCard from '../components/RefundStatusCard.jsx';

import './order-details/OrderDetail.css';

/* ========================================================================
   1. Constants & pure helpers
   ======================================================================== */

const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

const DISPUTE_TYPES = [
  ['NOT_DELIVERED', 'Goods not delivered'],
  ['QUALITY_ISSUE', 'Quality issue'],
  ['DAMAGED_GOODS', 'Damaged goods'],
  ['PAYMENT_ISSUE', 'Payment issue'],
  ['TRANSPORT_ISSUE', 'Transport issue'],
  ['OTHER', 'Other'],
];

const pad2 = (n) => String(n).padStart(2, '0');
const shortId = (id) => id?.slice(0, 8) || '—';
const label = (value) => String(value || '').replace(/_/g, ' ');

const money = (value, fraction = 2) =>
  Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: fraction });

const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const getError = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback;

const statusTone = (status) => {
  const value = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'PAID', 'ACCEPTED', 'CONFIRMED'].includes(value)) return 'good';
  if (['CANCELLED', 'REJECTED', 'FAILED', 'DISPUTED'].includes(value)) return 'bad';
  if (['TRANSPORT_ARRANGED', 'ARRANGED', 'QUOTED'].includes(value)) return 'info';
  if (['PENDING', 'AWAITING_PAYMENT', 'IN_PROGRESS', 'PROCESSING'].includes(value)) return 'wait';
  return 'neutral';
};

const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

const scrollToId = (id, delay = 0) => {
  const go = () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (delay) window.setTimeout(go, delay);
  else go();
};

const leafQuotes = (quotes) => {
  const list = Array.isArray(quotes) ? quotes : [];
  const parents = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
  return list.filter((q) => !parents.has(q.id));
};

function useNowUntil(targetMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetMs || Number.isNaN(targetMs)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [targetMs]);
  return now;
}

/* ========================================================================
   2. UI primitives — every card on the page is built from these
   ======================================================================== */

function Card({ id, eyebrow, eyebrowClass, title, subtitle, side, tone, className, children }) {
  return (
    <section className={`card${tone ? ` od-card-${tone}` : ''}${className ? ` ${className}` : ''}`} id={id}>
      <header className="od-card-head">
        <div className="od-card-head-main">
          {eyebrow && <span className={`od-eyebrow${eyebrowClass ? ` ${eyebrowClass}` : ''}`}>{eyebrow}</span>}
          <h2 className="od-card-title">{title}</h2>
          {subtitle && <p className="od-card-subtitle">{subtitle}</p>}
        </div>
        {side && <div className="od-card-head-side">{side}</div>}
      </header>
      {children}
    </section>
  );
}

function Section({ title, meta, strong, children }) {
  return (
    <div className="od-card-section">
      {(title || meta) && (
        <div className="od-card-section-head">
          <h3 className="od-card-section-title">{title}</h3>
          {meta != null && <span className={`od-card-section-meta${strong ? ' is-strong' : ''}`}>{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

function PartyBadge({ role, name }) {
  return (
    <div className="od-card-side-party">
      <div>
        <span className="od-card-side-label">{role}</span>
        <span className="od-card-side-value">{name || '—'}</span>
      </div>
      <span className="od-party-avatar" aria-hidden="true">{initials(name)}</span>
    </div>
  );
}

const Finding = ({ text, empty }) =>
  text ? <span className="od-finding-flag">{text}</span> : <Pill tone="good" dot={false}>{empty}</Pill>;

const Facts = ({ children }) => <div className="od-detail-facts">{children}</div>;

const Fact = ({ name, children }) => (
  <div>
    <span>{name}</span>
    <strong>{children}</strong>
  </div>
);

const Pill = ({ tone = 'neutral', dot = true, children }) => (
  <span className={`od-status-pill od-tone-${tone}`}>
    {dot && <span className="od-status-pill-dot" aria-hidden="true" />}
    {children}
  </span>
);

const YouTag = ({ inline }) => <span className={`od-party-you${inline ? ' od-party-you-inline' : ''}`}>You</span>;

const Actions = ({ children }) => <div className="od-actions">{children}</div>;

const SideLabel = ({ name, children }) => (
  <>
    <span className="od-card-side-label">{name}</span>
    {children}
  </>
);

function Notice({ title, children }) {
  return (
    <div className="od-notice">
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

const Button = ({ variant = 'default', size, busy, busyText, children, ...rest }) => (
  <button
    type="button"
    className={`btn${variant !== 'default' ? ` btn-${variant}` : ''}${size ? ` btn-${size}` : ''}`}
    {...rest}
  >
    {busy ? busyText : children}
  </button>
);

/* ========================================================================
   3. Payout card
   ========================================================================
   Party labels are abbreviated (SR / IR / TR). The countdown strip shows
   "Due Date" and the timer on one horizontal row; the date itself is not
   repeated here because it already appears in the card head.

   The countdown strip and numbered notice use inline styles so they render
   flat regardless of what the stylesheet contains or what global CSS is
   loaded. */

function PayoutStatusCard({ payouts, names, you }) {
  const parties = [
    { key: 'seller', label: 'SR', name: names.seller, you: you.seller, payout: payouts.seller },
    payouts.inspector && { key: 'inspector', label: 'IR', name: names.inspector, you: you.inspector, payout: payouts.inspector },
    payouts.transporter && { key: 'transporter', label: 'TR', name: names.transporter, you: you.transporter, payout: payouts.transporter },
  ]
    .filter(Boolean)
    .map((p) => ({ ...p, status: p.payout?.status || null }));

  const releaseMs = (payout) => {
    const t = payout?.releaseAt ? new Date(payout.releaseAt).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  };

  const dueTimes = parties
    .filter((p) => ['HELD', 'RELEASED', 'PAID_OUT'].includes(p.status))
    .map((p) => releaseMs(p.payout))
    .filter((t) => t !== null);
  const dueMs = dueTimes.length ? Math.max(...dueTimes) : null;
  const now = useNowUntil(dueMs);

  const anyDispute = parties.some((p) => p.status === 'ON_HOLD_DISPUTE');
  const holdNotStarted = parties.every((p) => !p.payout);

  const badgeOf = ({ status, payout }) => {
    if (!status) return { text: 'Pending', tone: 'neutral' };
    if (status === 'HELD') {
      const at = releaseMs(payout);
      return at !== null && now >= at ? { text: 'Released', tone: 'good' } : { text: 'Held', tone: 'wait' };
    }
    if (status === 'RELEASED') return { text: 'Released', tone: 'good' };
    if (status === 'PAID_OUT') return { text: 'Paid out', tone: 'good' };
    if (status === 'ON_HOLD_DISPUTE') return { text: 'Dispute hold', tone: 'bad' };
    if (status === 'CANCELLED') return { text: 'Cancelled', tone: 'bad' };
    return { text: label(status), tone: 'neutral' };
  };

  const anyFraction = parties.some((p) => p.payout?.amount != null && Number(p.payout.amount) % 1 !== 0);
  const amountText = (v) =>
    Number(v || 0).toLocaleString(undefined, {
      minimumFractionDigits: anyFraction ? 2 : 0,
      maximumFractionDigits: 2,
    });

  const remainingMs = dueMs !== null ? Math.max(0, dueMs - now) : 0;
  const secs = Math.floor(remainingMs / 1000);
  const clock = `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
  const dueDate =
    dueMs !== null
      ? new Date(dueMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
  const duePassed = dueMs !== null && remainingMs === 0;

  /* ── Inline styles ─────────────────────────────────────── */

  const dueStripStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    flexWrap: 'wrap',
    padding: '14px 0 0',
    margin: '14px 0 0',
    border: 'none',
    borderTop: '1px solid #e5e9ef',
    borderRadius: 0,
    background: 'transparent',
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    boxShadow: 'none',
  };

  const dueLabelStyle = {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    color: '#64748b',
  };

  const dueClockStyle = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    fontVariantNumeric: 'tabular-nums',
  };

  const dueDigitsStyle = {
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: '-.6px',
    color: '#0d1b2a',
    lineHeight: 1,
  };

  const dueUnitStyle = {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: '#64748b',
  };

  const noticeWrapStyle = {
    marginTop: 18,
    paddingTop: 14,
    border: 'none',
    borderTop: '1px solid #e5e9ef',
    borderRadius: 0,
    background: 'transparent',
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    boxShadow: 'none',
  };

  const noticePrefixStyle = {
    display: 'block',
    margin: '0 0 8px',
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    color: '#0f7a44',
  };

  const noticeListStyle = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  };

  const noticeItemStyle = {
    position: 'relative',
    paddingLeft: 24,
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 13,
    lineHeight: 1.6,
    color: '#2c3a4a',
  };

  const noticeNumStyle = {
    position: 'absolute',
    left: 0,
    top: 0,
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 12,
    fontWeight: 800,
    color: '#0f7a44',
  };

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <Card
      id="order-payout-status"
      eyebrow="Order Payout"
      title="After Buyer Paid"
      side={dueDate && <SideLabel name="Due Date"><span className="od-card-side-value">{dueDate}</span></SideLabel>}
    >
      <Section title="Order Payout Status">
        <table className="payout-table">
          <thead>
            <tr>
              <th scope="col">Party</th>
              <th scope="col" className="payout-amount-col">Amount</th>
              <th scope="col" className="payout-status-col">Status</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const { key, name, payout, status } = party;
              const badge = badgeOf(party);
              const currency = payout?.currency && payout.currency !== 'ETB' ? payout.currency : null;
              return (
                <tr key={key}>
                  <th scope="row" className="payout-party">
                    <div className="payout-party-body">
                      <span className="payout-party-line">
                        <span className="payout-party-role">{party.label}</span>
                        {name && <span className="payout-party-name">{name}</span>}
                        {party.you && <YouTag />}
                      </span>
                      {status === 'RELEASED' && payout?.releasedAt && (
                        <span className="payout-party-note">Released {formatDateTime(payout.releasedAt)}</span>
                      )}
                      {status === 'PAID_OUT' && payout?.paidOutAt && (
                        <span className="payout-party-note">Paid out {formatDateTime(payout.paidOutAt)}</span>
                      )}
                      {payout?.payoutReference && (
                        <span className="payout-party-note">Ref {payout.payoutReference}</span>
                      )}
                    </div>
                  </th>
                  <td className="payout-amount">
                    {payout?.amount != null ? (
                      <>
                        {amountText(payout.amount)}
                        {currency && <span className="payout-currency">{currency}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="payout-status">
                    <Pill tone={badge.tone}>{badge.text}</Pill>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {dueMs !== null && (
        <div style={dueStripStyle} role="group" aria-label="Due date">
          <span style={dueLabelStyle}>Due Date</span>
          <div style={dueClockStyle} role="timer" aria-live="off">
            {duePassed ? (
              <span style={{ ...dueDigitsStyle, fontSize: 15, letterSpacing: '-.2px', color: '#0f7a44' }}>
                Hold cleared
              </span>
            ) : (
              <>
                <span style={dueDigitsStyle}>{clock}</span>
                <span style={dueUnitStyle}>left</span>
              </>
            )}
          </div>
        </div>
      )}

      {dueMs === null && holdNotStarted && (
        <div style={dueStripStyle} role="group" aria-label="Due date">
          <span style={dueLabelStyle}>Due Date</span>
          <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 13, color: '#64748b' }}>
            Starts after payment settles
          </span>
        </div>
      )}

      {anyDispute && (
        <p
          style={{
            marginTop: 12,
            padding: '8px 0 8px 12px',
            borderLeft: '3px solid #fecaca',
            fontSize: 12.5,
            lineHeight: 1.55,
            color: '#b42318',
          }}
        >
          One or more payouts are frozen while a dispute is open.
        </p>
      )}

      <div style={noticeWrapStyle}>
        <span style={noticePrefixStyle}>Notice:</span>
        <ol style={noticeListStyle}>
          <li style={noticeItemStyle}>
            <span style={noticeNumStyle}>1)</span>
            Each payout is held for 3 days after its payment settles.
          </li>
          <li style={noticeItemStyle}>
            <span style={noticeNumStyle}>2)</span>
            Buyer payment is separate from each payout below.
          </li>
          <li style={noticeItemStyle}>
            <span style={noticeNumStyle}>3)</span>
            No manual action is required.
          </li>
        </ol>
      </div>
    </Card>
  );
}

/* ========================================================================
   4. Order overview
   ======================================================================== */

function OrderProgress({ steps }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="order-progress" aria-label="Order progress">
      {steps.map((s, idx) => {
        const state = s.done ? 'done' : idx === current ? 'current' : 'todo';
        return (
          <li key={s.label} className={`order-progress-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="order-progress-dot" aria-hidden="true" />
            <span className="order-progress-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function OverviewCard({ order, title, flags, canCancel, busy, onCancel }) {
  const { isBuyer, isSeller, marketplacePaid, marketplacePending, transportJob } = flags;
  const role = isBuyer ? 'Buying' : isSeller ? 'Selling' : 'Order';
  const showBuyer = isSeller;
  const other = showBuyer ? order.buyer : order.seller;
  const otherLabel = showBuyer ? 'Buyer' : 'Seller';
  const delivered = ['DELIVERED', 'COMPLETED'].includes(order.status) || transportJob?.status === 'DELIVERED';

  const steps = [
    { label: 'Ordered', done: true },
    { label: 'Paid', done: marketplacePaid },
    { label: 'Delivered', done: delivered },
    { label: 'Completed', done: order.status === 'COMPLETED' },
  ];

  return (
    <Card
      className="od-card-overview"
      eyebrow={role}
      eyebrowClass={isSeller ? 'is-selling' : ''}
      title={title}
      side={<PartyBadge role={otherLabel} name={other?.name} />}
    >
      <Section title="Order status" meta={`ORD ${shortId(order.id).toUpperCase()}`}>
        <div className="od-status-row">
          <Pill tone={statusTone(order.status)}>{label(order.status)}</Pill>
          {marketplacePaid && <Pill tone="good" dot={false}>Payment: Paid</Pill>}
          {marketplacePending && !marketplacePaid && <Pill tone="wait" dot={false}>Payment: Pending</Pill>}
          {transportJob?.status && <Pill tone="neutral" dot={false}>Transport: {label(transportJob.status)}</Pill>}
        </div>
        <OrderProgress steps={steps} />
      </Section>

      <Section title="Details">
        <Facts>
          <Fact name="Amount">{money(order.finalPrice)} ETB</Fact>
          <Fact name="Buyer">{order.buyer?.name || '—'}{isBuyer && <YouTag inline />}</Fact>
          <Fact name="Seller">{order.seller?.name || '—'}{isSeller && <YouTag inline />}</Fact>
          {order.listing?.cropType && <Fact name="Product">{order.listing.cropType}</Fact>}
          {order.listing?.quantity != null && <Fact name="Quantity">{order.listing.quantity} units</Fact>}
          <Fact name="Ordered from">{order.listing?.location || '—'}</Fact>
          {order.buyer?.location && <Fact name="Deliver to">{order.buyer.location}</Fact>}
        </Facts>
      </Section>

      <p className="od-card-created">Created {order.createdAt ? new Date(order.createdAt).toLocaleDateString() : '—'}</p>

      {canCancel && (
        <Button className="btn btn-outline btn-block" disabled={busy === 'cancel'} onClick={onCancel} busy={busy === 'cancel'} busyText="Cancelling…">
          Cancel order
        </Button>
      )}
    </Card>
  );
}

/* ========================================================================
   5. Inspection
   ======================================================================== */

function InspectionCard({ order, title, i }) {
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
          <Button
            variant="primary"
            disabled={i.requesting}
            busy={i.requesting}
            busyText="Requesting…"
            onClick={() => i.request(i.isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}
          >
            Open inspection request
          </Button>
        )}
      </Card>
    );
  }

  const report = request.report;
  const reportReady = request.status === 'COMPLETED' && Boolean(report);
  const inspectorName = request.inspector?.name || null;
  const inspectionDate =
    report?.inspectedAt || report?.completedAt || request.completedAt || request.updatedAt || request.createdAt || null;

  const side =
    reportReady && inspectorName ? (
      <PartyBadge role="Inspector" name={inspectorName} />
    ) : (
      <SideLabel name="Status">
        <Pill tone={statusTone(request.status)}>{label(request.status)}</Pill>
      </SideLabel>
    );

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
        </Facts>
      </Section>

      {reportReady ? (
        <>
          <Section title="Findings">
            <Facts>
              <Fact name="Visible defects"><Finding text={report.visibleDefects} empty="No defects" /></Fact>
              <Fact name="Damage notes"><Finding text={report.damageNotes} empty="No damage" /></Fact>
              <Fact name="Packaging"><Finding text={report.packagingNotes} empty="Fully packed" /></Fact>
            </Facts>
          </Section>

          {i.decisionRequired && (
            <Section title="Purchase decision">
              {order.buyerDecision ? (
                <div className={`inspection-decision-state ${order.buyerDecision === 'BUY' ? 'is-buy' : 'is-cancel'}`}>
                  <span className="inspection-decision-icon" aria-hidden="true">{order.buyerDecision === 'BUY' ? '✓' : '×'}</span>
                  <div>
                    <strong>{order.buyerDecision === 'BUY' ? 'BUY decision recorded' : 'Purchase cancelled after inspection'}</strong>
                    <p>
                      {order.buyerDecision === 'BUY'
                        ? 'Goods payment is unlocked. Transport can proceed once the required payments are confirmed.'
                        : 'The purchase decision is closed.'}
                    </p>
                  </div>
                </div>
              ) : i.isBuyer ? (
                <>
                  <p className="muted">
                    Choose <strong>Buy</strong> only after reviewing the findings. Buy unlocks goods payment; it does not
                    complete payment or arrange transport.
                  </p>
                  <Actions>
                    <Button variant="primary" disabled={Boolean(i.busy)} busy={i.busy === 'buyer-decision-buy'} busyText="Recording…" onClick={() => i.decide('BUY')}>
                      Buy — continue purchase
                    </Button>
                    <Button variant="light" disabled={Boolean(i.busy)} busy={i.busy === 'buyer-decision-cancel'} busyText="Cancelling…" onClick={() => i.decide('CANCEL')}>
                      Cancel after inspection
                    </Button>
                  </Actions>
                </>
              ) : (
                <p className="muted">
                  <strong>Awaiting buyer decision.</strong> The buyer must review this report and choose Buy or Cancel
                  before payment opens.
                </p>
              )}
            </Section>
          )}
        </>
      ) : (
        ['REQUESTED', 'ACCEPTED'].includes(request.status) && (
          <Section title="Inspection recovery">
            <p className="muted">
              If every inspector bid is closed, reopen bidding. If you no longer want this request, cancel it without
              cancelling the order.
            </p>
            <Actions>
              <Button variant="primary" disabled={Boolean(i.busy)} busy={i.busy === `reopen-inspection-${request.id}`} busyText="Reopening…" onClick={i.reopenBidding}>
                Reopen inspection bidding
              </Button>
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

/* ========================================================================
   6. Transport
   ======================================================================== */

function EvidenceForm({ kind, t }) {
  const isPickup = kind === 'PICKUP';
  const { evidence, setEvidence, notes, setNotes, evidenceBusy } = t;
  const ready = evidence.photoKeys.length || evidence.videoKeys.length || notes.trim();
  return (
    <Notice title={isPickup ? 'Pickup evidence required' : 'Delivery evidence'}>
      {!isPickup && <p className="muted">Upload delivery evidence before marking the trip delivered.</p>}
      <EvidenceUploader
        uploadUrl={`/transport/${t.job.id}/evidence/media`}
        disabled={evidenceBusy}
        onUploaded={({ photoKeys, videoKeys }) =>
          setEvidence((prev) => ({
            photoKeys: [...prev.photoKeys, ...photoKeys],
            videoKeys: [...prev.videoKeys, ...videoKeys],
          }))
        }
      />
      {(evidence.photoKeys.length > 0 || evidence.videoKeys.length > 0) && (
        <p className="muted small">{evidence.photoKeys.length} photo(s), {evidence.videoKeys.length} video(s) ready.</p>
      )}
      <textarea
        className="field"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={`Optional ${isPickup ? 'pickup' : 'delivery'} condition / handover notes…`}
        rows={3}
        disabled={evidenceBusy}
      />
      <Button
        variant="primary"
        disabled={evidenceBusy || !ready}
        busy={evidenceBusy}
        busyText="Submitting…"
        onClick={() => t.submitEvidence(kind, isPickup ? 'IN_TRANSIT' : 'DELIVERED')}
      >
        {isPickup ? 'Submit pickup evidence & mark in transit' : 'Submit delivery evidence & mark delivered'}
      </Button>
    </Notice>
  );
}

function QuoteRow({ quote, t }) {
  const key = `quote-${quote.id}`;
  const working = t.busy === key;
  const amount = quote.status === 'COUNTERED' ? quote.counterAmount ?? quote.amount : quote.amount;
  const arrangerTurn = quote.status === 'SELECTED' || (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');
  const isOwner = quote.truckOwnerId === t.currentUserId;
  const transporterTurn = quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';
  const canRespond = (t.canChooseQuote && arrangerTurn) || (isOwner && transporterTurn);
  const rating = typeof quote.truckOwner?.rating === 'number' ? quote.truckOwner.rating.toFixed(1) : '—';

  return (
    <div className="transporter">
      <div>
        <strong>{quote.truckOwner?.name || 'Truck owner'}</strong>
        <p>
          {quote.truck?.truckType || 'Truck'} · {quote.truck?.capacity != null ? `${quote.truck.capacity}t` : 'Capacity —'} ·{' '}
          {quote.truck?.registration || 'Registration —'} · ★ {rating}
        </p>
        {quote.message && <p className="muted">{quote.message}</p>}
        <p>Status: <span className="badge">{quote.status || 'PENDING'}</span></p>
        {transporterTurn && <p className="muted">You countered {money(amount)} ETB — waiting for the transporter.</p>}
      </div>

      <div>
        <strong>{money(amount)} ETB</strong>

        {t.canChooseQuote && quote.status === 'PENDING' && (
          <>
            <Button variant="primary" size="sm" disabled={working} busy={working} busyText="Selecting…" onClick={() => t.selectQuote(quote.id)}>
              Select bid for deal
            </Button>
            <span className="muted small">Selecting opens price negotiation.</span>
          </>
        )}

        {canRespond && (
          <div className="od-quote-actions">
            <Button size="sm" disabled={working} busy={working} busyText="Accepting…" onClick={() => t.acceptQuote(quote.id)}>
              {transporterTurn ? 'Accept buyer counter' : 'Accept quote'}
            </Button>
            <input
              className="field field-inline"
              type="number"
              min="1"
              placeholder="Counter (ETB)"
              value={t.counterInputs[quote.id] || ''}
              onChange={(e) => t.setCounterInputs((q) => ({ ...q, [quote.id]: e.target.value }))}
            />
            <Button variant="light" size="sm" disabled={working} busy={working} busyText="Sending…" onClick={() => t.counterQuote(quote.id)}>
              Counter
            </Button>
            <Button variant="light" size="sm" disabled={working} busy={working} busyText="Rejecting…" onClick={() => t.rejectQuote(quote.id)}>
              Reject
            </Button>
          </div>
        )}

        {quote.status === 'ACCEPTED' && t.isArranger && !t.pending && (
          <>
            <span className="muted small">Provisional agreement — the truck is not committed until transport payment succeeds.</span>
            <Button variant="light" size="sm" disabled={working} busy={working} busyText="Releasing…" onClick={() => t.releaseQuote(quote.id)}>
              Transporter unavailable — choose another
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function TransportCard({ order, t }) {
  const job = t.job;
  const hired = job?.method === 'HIRE_TRANSPORTER';
  const quotes = leafQuotes(job?.quotes);

  return (
    <Card
      id="transport-section"
      eyebrow="Logistics"
      title="Transport"
      side={job?.status && <SideLabel name="Status"><Pill tone={statusTone(job.status)}>{label(job.status)}</Pill></SideLabel>}
    >
      {!job ? (
        t.canArrange ? (
          <TransportSetup
            orderId={order.id}
            pickupDefault={order.listing?.location}
            destinationDefault={order.buyer?.location}
            canBuyer={t.isBuyer}
            canSeller={t.isSeller}
            onCreated={t.reload}
          />
        ) : (
          <p className="muted">No transport arrangement recorded yet.</p>
        )
      ) : (
        <>
          <Section title="Trip details" meta={job.method || '—'}>
            <Facts>
              <Fact name="Arranged by">{job.arrangingParty || '—'}</Fact>
              <Fact name="Pickup">{job.pickupLocation || '—'}</Fact>
              <Fact name="Destination">{job.destination || '—'}</Fact>
              {job.load && <Fact name="Load">{job.load}</Fact>}
              {job.requiredCapacity != null && <Fact name="Required capacity">{job.requiredCapacity}</Fact>}
            </Facts>
          </Section>

          {job.truckOwner && (
            <Section title="Transporter" meta={job.agreedAmount != null ? `${money(job.agreedAmount)} ETB` : null} strong>
              <p><strong>{job.truckOwner.name || '—'}</strong></p>
              {job.truckOwner.phone && <p className="muted">Phone: {job.truckOwner.phone}</p>}
              {job.truck && (
                <p>
                  Truck: <strong>{job.truck.registration || '—'}</strong> · {job.truck.truckType || 'Truck'}
                  {job.truck.capacity != null && ` · ${job.truck.capacity}t`}
                </p>
              )}
            </Section>
          )}

          {hired && !t.paid && (
            <Section title="Transport quotes" meta="Bids">
              {quotes.length ? (
                quotes.map((q) => <QuoteRow key={q.id} quote={q} t={t} />)
              ) : (
                <p className="muted">Waiting for registered truck owners to submit quotes.</p>
              )}
            </Section>
          )}

          {job.method === 'OWN_TRUCK' && (
            <Section title="Transport payment">
              <p><strong>No separate transporter payment is required.</strong></p>
              <p className="muted">This order uses the owner's own truck, so no transport payment is created.</p>
            </Section>
          )}

          {hired && !t.paid && (
            <Section title="Transport payment" meta={job.agreedAmount != null ? `${money(job.agreedAmount)} ETB` : null} strong>
              <p className="muted">
                Transport payment is separate from the seller payment. You can pay as soon as the quote is accepted. The
                transporter cannot start the trip until every required payment is confirmed.
              </p>
              {t.canStartPayment && (
                <div className="od-field-row">
                  <select className="field field-inline" value={t.payMethod} onChange={(e) => t.setPayMethod(e.target.value)} disabled={t.busy === 'pay-transport'}>
                    {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <Button variant="primary" size="sm" disabled={t.busy === 'pay-transport'} busy={t.busy === 'pay-transport'} busyText="Submitting…" onClick={t.pay}>
                    Pay for transport
                  </Button>
                </div>
              )}
              {t.canResumePayment && (
                <>
                  <p>Pending payment: <strong>{t.payment.method || '—'}</strong>, {money(t.payment.amount)} ETB. It was started but not completed.</p>
                  <Button variant="primary" size="sm" disabled={t.busy === 'resume-transport'} busy={t.busy === 'resume-transport'} busyText="Redirecting…" onClick={() => t.resume(t.payment.id, 'resume-transport')}>
                    Resume payment
                  </Button>
                </>
              )}
            </Section>
          )}

          {t.paid && (
            <Section title="Transport payment confirmed" meta={`${money(t.paidAmount)} ETB`} strong />
          )}

          {t.isArranger && ['REQUESTED', 'QUOTED', 'ACCEPTED', 'CANCELLED'].includes(job.status) && (
            <Section title="Transport recovery">
              <p className="muted">
                If the competition has stalled or the previous arrangement was cancelled, request admin approval to
                release a fresh transport form.
              </p>
              {t.recoveryRequests.filter((r) => r.type === 'TRANSPORT').map((r) => (
                <p className="muted small" key={r.id}>
                  Recovery: <strong>{r.status}</strong>{r.formReleasedAt ? ' — fresh form released' : ' — awaiting admin approval'}
                </p>
              ))}
              <Button
                variant="primary"
                disabled={Boolean(t.busy) || t.recoveryRequests.some((r) => r.type === 'TRANSPORT' && r.status === 'PENDING')}
                busy={t.busy === 'recovery-TRANSPORT'}
                busyText="Requesting…"
                onClick={t.requestRecovery}
              >
                Request fresh transport form
              </Button>
            </Section>
          )}

          <Section title="Pickup and delivery evidence">
            <p className="muted">
              The transporter must upload pickup evidence before moving the trip from Pickup to In transit, and delivery
              evidence before marking it Delivered.
            </p>
            {t.isTransporter && job.status === 'PICKUP' && <EvidenceForm kind="PICKUP" t={t} />}
            {t.isTransporter && job.status === 'IN_TRANSIT' && <EvidenceForm kind="DELIVERY" t={t} />}
            <EvidenceGallery
              listUrl={`/transport/${job.id}/evidence`}
              mediaUrl={(evidenceId) => `/transport/${job.id}/evidence/${evidenceId}/media`}
            />
          </Section>

          {job.status === 'DELIVERED' && (
            <Section title="Delivery">
              <p><strong>✓ Transport marked as delivered.</strong></p>
              {job.deliveredConfirmedAt && <p className="muted">Delivery confirmed.</p>}
            </Section>
          )}

          {job.incidentNotes && (
            <div className="alert"><strong>Transport notes:</strong> {job.incidentNotes}</div>
          )}
        </>
      )}
    </Card>
  );
}

/* ========================================================================
   7. Offer, receipt, dispute, completed, admin
   ======================================================================== */

function OfferCard({ amount, setAmount, message, setMessage, submitting, onSubmit }) {
  return (
    <Card id="make-offer" eyebrow="Product marketplace" title="Make an offer" subtitle="Your offer enters the seller's competition. It does not charge you or reserve the product.">
      <form onSubmit={onSubmit} className="form">
        <label htmlFor="offer-amount">Offer amount (ETB)</label>
        <input id="offer-amount" className="field" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Enter your offer" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={submitting} required />
        <label htmlFor="offer-message">Message to seller <span className="optional">(optional)</span></label>
        <textarea id="offer-message" className="field" rows="3" placeholder="Add a message to the seller" value={message} onChange={(e) => setMessage(e.target.value)} disabled={submitting} />
        <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Make offer'}</button>
      </form>
    </Card>
  );
}

function ReceiptCard({ marketplacePaid, transportBlocked, busy, onConfirm }) {
  return (
    <Card id="confirm-receipt" eyebrow="Final step" title="Confirm receipt" subtitle="Confirm only after you have physically received the produce or product.">
      {!marketplacePaid && <div className="alert error">Marketplace payment must be confirmed before receipt can be completed.</div>}
      {transportBlocked && <div className="alert error">Transport payment must be confirmed before receipt can be completed.</div>}
      <Button variant="primary" className="btn btn-primary btn-block" disabled={busy === 'receipt' || !marketplacePaid || transportBlocked} busy={busy === 'receipt'} busyText="Confirming…" onClick={onConfirm}>
        Confirm receipt & complete order
      </Button>
    </Card>
  );
}

function DisputeCard({ order, d }) {
  if (order.status === 'DISPUTED') {
    return (
      <Card id="raise-dispute" tone="warning" eyebrow="Dispute" title="Dispute open">
        <p className="muted">
          An admin is reviewing this order. <strong>Payments, transport, inspection and payouts are paused</strong> while
          the dispute is open. The order will either resume or be cancelled and refunded after review.
        </p>
      </Card>
    );
  }
  if (!d.canRaise) return null;

  return (
    <Card id="raise-dispute" eyebrow="Dispute" title="Raise a dispute" subtitle="Use this if something went wrong — goods not delivered, quality issues, or a payment problem.">
      {d.submitted ? (
        <div className="alert success">Dispute submitted. The order is marked as disputed while an admin reviews it.</div>
      ) : (
        <form onSubmit={d.submit} className="form">
          <label htmlFor="dispute-against">Dispute against</label>
          <select id="dispute-against" className="field" value={d.againstId} onChange={(e) => d.setAgainstId(e.target.value)} required>
            <option value="">Select who this is about…</option>
            {d.counterparties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </select>
          <label htmlFor="dispute-type">Type</label>
          <select id="dispute-type" className="field" value={d.type} onChange={(e) => d.setType(e.target.value)}>
            {DISPUTE_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          <label htmlFor="dispute-description">What happened?</label>
          <textarea id="dispute-description" className="field" rows={4} placeholder="Describe the issue in detail" value={d.description} onChange={(e) => d.setDescription(e.target.value)} required />
          <button type="submit" className="btn btn-outline" disabled={d.submitting}>{d.submitting ? 'Submitting…' : 'Raise dispute'}</button>
        </form>
      )}
    </Card>
  );
}

/* ========================================================================
   8. Page
   ======================================================================== */

export default function OrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  /* ---------- state ---------- */
  const [order, setOrder] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [recoveryRequests, setRecoveryRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const [counterInputs, setCounterInputs] = useState({});
  const [evidence, setEvidence] = useState({ photoKeys: [], videoKeys: [] });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  const [offerAmount, setOfferAmount] = useState('');
  const [offerMessage, setOfferMessage] = useState('');
  const [submittingOffer, setSubmittingOffer] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState(false);

  const [disputeAgainstId, setDisputeAgainstId] = useState('');
  const [disputeType, setDisputeType] = useState('NOT_DELIVERED');
  const [disputeDescription, setDisputeDescription] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);

  /* ---------- toast auto-dismiss ---------- */
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), 3000);
    return () => window.clearTimeout(timer);
  }, [error]);

  /* ---------- data loading ---------- */
  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!orderId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const [orderRes, workflowRes, recoveryRes] = await Promise.allSettled([
          api.get(`/orders/${orderId}`),
          api.get(`/orders/${orderId}/workflow`),
          api.get(`/recovery-requests/order/${orderId}`),
        ]);
        if (orderRes.status !== 'fulfilled') throw orderRes.reason;
        setOrder(orderRes.value.data?.order || null);
        setWorkflow(workflowRes.status === 'fulfilled' ? workflowRes.value.data?.workflow || null : null);
        setRecoveryRequests(recoveryRes.status === 'fulfilled' ? recoveryRes.value.data?.recoveryRequests || [] : []);
      } catch (err) {
        setError(getError(err, 'Could not load order'));
      } finally {
        if (silent) setRefreshing(false);
        else setLoading(false);
      }
    },
    [orderId]
  );

  useEffect(() => { load(); }, [load]);
  const reload = useCallback(() => load({ silent: true }), [load]);

  useEffect(() => {
    if (loading) return;
    const id = location.hash?.replace('#', '');
    if (id) scrollToId(id);
  }, [loading, location.hash]);

  /* One wrapper for the "busy → call → reload → report error" pattern. */
  const run = async (key, fn, fallback) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(getError(err, fallback));
      return false;
    } finally {
      setBusy('');
    }
  };

  /* ---------- identity & roles ---------- */
  const currentUserId = user?.id || user?.userId || user?._id || null;
  const isAdmin = (Array.isArray(user?.roles) ? user.roles : []).includes('ADMIN');
  const isBuyer = Boolean(order && currentUserId && currentUserId === order.buyerId);
  const isSeller = Boolean(order && currentUserId && currentUserId === order.sellerId);
  const isParticipant = isBuyer || isSeller;
  const buyerIdentityMismatch = Boolean(order && currentUserId && !isParticipant && !isAdmin);

  /* ---------- listing kind ---------- */
  const isAgricultural = order?.listing?.category === 'AGRICULTURAL';
  const isProduct = order?.listing?.category === 'PRODUCT';
  const inspectionApplies = isAgricultural || isProduct;
  const title = order?.listing?.title || order?.listing?.cropType || 'Order';

  /* ---------- inspection ---------- */
  const allInspections = useMemo(
    () =>
      (order?.inspectionRequests || order?.listing?.inspectionRequests || [])
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [order?.inspectionRequests, order?.listing?.inspectionRequests]
  );
  const inspections = useMemo(() => allInspections.filter((r) => r.status !== 'CANCELLED'), [allInspections]);
  const currentInspection = inspections[0] || null;
  const assignedInspection = inspections.find((r) => r.inspectorId === currentUserId) || null;
  const isInspector = Boolean(assignedInspection);
  const inspectionFormReleased = recoveryRequests.some((r) => r.type === 'INSPECTION' && r.status === 'APPROVED' && r.formReleasedAt);
  const inspectorName = (order?.inspectionRequests || inspections).find((r) => r?.inspector?.name)?.inspector?.name || null;

  const inspectionGateMet =
    !inspectionApplies || Boolean(currentInspection && currentInspection.status === 'COMPLETED' && currentInspection.report);
  const decisionRequired = inspectionApplies;
  const decisionGateMet = !decisionRequired || order?.buyerDecision === 'BUY';
  const negotiatedGateMet = !isProduct || Boolean(order?.agreedOfferId);

  /* ---------- transport ---------- */
  const rawJob = order?.transportJob || null;
  const transportJob = rawJob?.status === 'CANCELLED' ? null : rawJob;
  const isTransporter = Boolean(transportJob?.truckOwnerId && transportJob.truckOwnerId === currentUserId);
  const isTransportArranger = Boolean(
    transportJob &&
      ((transportJob.arrangingParty === 'BUYER' && isBuyer) ||
        (transportJob.arrangingParty === 'SELLER' && isSeller) ||
        (transportJob.arrangingParty === 'JOINT' && isParticipant))
  );
  const transportInMotion = Boolean(transportJob && ['PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(transportJob.status));
  const acceptedQuote = Array.isArray(transportJob?.quotes) ? transportJob.quotes.find((q) => q.status === 'ACCEPTED') : null;

  /* ---------- payments ---------- */
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const active = (p) => ['PENDING', 'PROCESSING'].includes(p.status);
  const pick = (list) => list.find(active) || list.find((p) => p.status === 'PAID') || null;

  const marketplacePayments = useMemo(() => payments.filter((p) => p.type === 'MARKETPLACE'), [payments]);
  const transportPayments = useMemo(() => payments.filter((p) => p.type === 'TRANSPORT'), [payments]);
  const marketplacePayment = useMemo(() => pick(marketplacePayments), [marketplacePayments]); // eslint-disable-line react-hooks/exhaustive-deps
  const transportPayment = useMemo(() => pick(transportPayments), [transportPayments]); // eslint-disable-line react-hooks/exhaustive-deps

  const installmentPlan = useMemo(
    () =>
      marketplacePayments.find(
        (p) => p.installmentCount != null && ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
      ) || null,
    [marketplacePayments]
  );
  const installmentPayments = useMemo(
    () =>
      payments
        .filter(
          (p) =>
            p.type === 'MARKETPLACE_INSTALLMENT' &&
            p.installmentSequence != null &&
            (!installmentPlan || p.parentPaymentId === installmentPlan.id)
        )
        .sort((a, b) => (a.installmentSequence || 0) - (b.installmentSequence || 0)),
    [payments, installmentPlan]
  );

  /* Heal a plan whose installments are all paid but whose parent is still pending. */
  const planHealRef = useRef(null);
  useEffect(() => {
    if (
      !installmentPlan ||
      installmentPlan.status !== 'PENDING' ||
      installmentPayments.length !== installmentPlan.installmentCount ||
      !installmentPayments.every((p) => p.status === 'PAID') ||
      planHealRef.current === installmentPlan.id
    ) return;
    planHealRef.current = installmentPlan.id;
    api.get(`/payments/${installmentPlan.id}/chapa/verify`).then(reload).catch(() => {});
  }, [installmentPlan, installmentPayments, reload]);

  const marketplacePaid = marketplacePayments.some((p) => p.status === 'PAID');
  const marketplacePending = marketplacePayments.some(active);
  const marketplaceProcessing = marketplacePayments.some((p) => p.status === 'PROCESSING');
  const transportPaid = transportPayments.some((p) => p.status === 'PAID');
  const transportPending = transportPayments.some(active);
  const transportProcessing = transportPayments.some((p) => p.status === 'PROCESSING');
  const hiredTransport = transportJob?.method === 'HIRE_TRANSPORTER';

  const canPayMarketplace =
    Boolean(order) &&
    !['COMPLETED', 'CANCELLED'].includes(order.status) &&
    isBuyer &&
    inspectionGateMet &&
    decisionGateMet &&
    negotiatedGateMet &&
    !marketplacePayments.some((p) => ['PENDING', 'PROCESSING', 'PAID'].includes(p.status));

  const marketplaceBlockedReason =
    isProduct && !negotiatedGateMet
      ? 'This product must first be won through seller bidding and bilateral negotiation before payment.'
      : inspectionApplies && !inspectionGateMet
      ? !currentInspection
        ? 'Request and complete the inspection before paying for the goods.'
        : 'Complete the current inspection and make sure its report is published before paying for the goods.'
      : decisionRequired && !decisionGateMet
      ? `Choose BUY after reviewing the ${isAgricultural ? 'agricultural ' : ''}inspection report before paying for the goods.`
      : null;

  const canStartTransportPayment =
    Boolean(transportJob) &&
    hiredTransport &&
    Boolean(transportJob.truckOwnerId) &&
    Boolean(acceptedQuote) &&
    transportJob.agreedAmount != null &&
    Number(transportJob.agreedAmount) > 0 &&
    ['QUOTED', 'ACCEPTED'].includes(transportJob.status) &&
    !transportPayments.some((p) => ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)) &&
    isBuyer;

  /* ---------- payouts & refunds ---------- */
  const payouts = order?.payouts || [];
  const payoutBy = (role) => payouts.find((p) => p.payeeRole === role) || null;
  const refunds = order?.refunds || [];

  /* ---------- payment actions ---------- */
  const checkPayment = (paymentId, key) =>
    paymentId &&
    (async () => {
      setBusy(key);
      setError('');
      try {
        const res = await api.get(`/payments/${paymentId}/chapa/verify`);
        await reload();
        if (res.data?.status === 'PENDING') {
          setError('Chapa has not confirmed this payment yet. If you cancelled or the checkout failed, return to the order and retry once the payment shows FAILED.');
        }
      } catch (err) {
        setError(getError(err, 'Could not check payment status'));
      } finally {
        setBusy('');
      }
    })();

  const resumePayment = (paymentId, key) =>
    paymentId && run(key, () => chapaInitializeAndRedirect(paymentId), 'Could not resume payment');

  const payMarketplace = () => {
    if (!isBuyer) return setError('Only the buyer can make the marketplace payment');
    const amount = Number(order.finalPrice);
    if (!Number.isFinite(amount) || amount <= 0) return setError('Invalid marketplace payment amount');
    return run('pay-marketplace', () => startChapaPayment({ type: 'MARKETPLACE', orderId: order.id, amount, method: payMethod }), 'Could not start marketplace payment');
  };

  const payTransport = () => {
    if (!isParticipant) return setError('You are not authorized to pay for this transport');
    if (!hiredTransport) return setError('Transport payment is only required for hired transport');
    if (!transportJob.truckOwnerId) return setError('A transporter must be selected before transport payment');
    const amount = Number(transportJob.agreedAmount);
    if (!Number.isFinite(amount) || amount <= 0) return setError('Invalid transport payment amount');
    return run('pay-transport', () => startChapaPayment({ type: 'TRANSPORT', orderId: order.id, amount, method: payMethod }), 'Could not start transport payment');
  };

  const payInspection = (request) =>
    request?.id && request.fee &&
    run(`pay-inspection-${request.id}`, () =>
      startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, orderId: order.id, amount: Number(request.fee), method: payMethod }),
      'Could not start inspector payment');

  const startInstallments = () => {
    if (!isBuyer) return setError('Only the buyer can make the marketplace payment');
    return run('start-installments', () =>
      api.post('/payments', { type: 'MARKETPLACE', orderId: order.id, amount: Number(order.finalPrice), method: payMethod, installments: true }),
      'Could not set up installments');
  };

  const retryInstallment = (inst) =>
    inst?.id && run(`installment-${inst.id}`, () => api.post(`/payments/${inst.id}/retry-installment`), 'Could not retry this installment');

  const marketplaceObligation = {
    amount: order?.finalPrice,
    paid: marketplacePaid,
    pending: marketplacePending,
    processing: marketplaceProcessing,
    canPay: canPayMarketplace,
    canResume: Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PENDING' && isBuyer,
    canCheck: Boolean(marketplacePayment) && !installmentPlan && marketplacePayment.status === 'PROCESSING' && isBuyer,
    onPay: payMarketplace,
    onResume: () => resumePayment(marketplacePayment?.id, 'resume-marketplace'),
    onCheck: () => checkPayment(marketplacePayment?.id, 'check-marketplace'),
    installmentPlan,
    installments: installmentPayments,
    canStartInstallments: canPayMarketplace,
    onStartInstallments: startInstallments,
    onPayInstallment: (i) => resumePayment(i?.id, `installment-${i?.id}`),
    onCheckInstallment: (i) => checkPayment(i?.id, `installment-${i?.id}`),
    onRetryInstallment: retryInstallment,
  };

  const transportObligation = transportJob
    ? {
        required: hiredTransport,
        readyToPay: ['QUOTED', 'ACCEPTED'].includes(transportJob.status) && Boolean(acceptedQuote) && transportJob.agreedAmount != null,
        amount: transportJob.agreedAmount,
        paid: transportPaid,
        pending: transportPending,
        processing: transportProcessing,
        note:
          hiredTransport && !['QUOTED', 'ACCEPTED'].includes(transportJob.status) && !transportPaid && !transportPending
            ? 'Transporter payment becomes available after a provisional transporter agreement is accepted.'
            : null,
        canStart: canStartTransportPayment,
        canResume: Boolean(transportPayment) && transportPayment.status === 'PENDING' && isBuyer,
        canCheck: Boolean(transportPayment) && transportPayment.status === 'PROCESSING' && isBuyer,
        onStart: payTransport,
        onResume: () => resumePayment(transportPayment?.id, 'resume-transport'),
        onCheck: () => checkPayment(transportPayment?.id, 'check-transport'),
      }
    : null;

  const inspectionPaymentGroups = inspectionApplies && currentInspection && Number(currentInspection.fee) > 0
    ? [currentInspection].map((request) => {
        const list = request.payments || [];
        const open = list.find((p) => p.type === 'INSPECTOR' && active(p)) || null;
        const key = `${open?.status === 'PROCESSING' ? 'check' : open ? 'resume' : 'pay'}-inspection-${request.id}`;
        return {
          id: request.id,
          label: `${request.inspector?.name || 'Inspector'} — inspection fee`,
          amount: request.fee,
          paid: list.some((p) => p.type === 'INSPECTOR' && p.status === 'PAID'),
          pending: Boolean(open),
          processing: open?.status === 'PROCESSING',
          note: request.status !== 'COMPLETED' ? `Inspection status: ${request.status}` : null,
          busyKey: key,
          canCheck: open?.status === 'PROCESSING',
          canResume: Boolean(open) && open.status !== 'PROCESSING',
          onCheck: () => checkPayment(open?.id, key),
          onResume: () => resumePayment(open?.id, key),
          onPay: () => payInspection(request),
        };
      })
    : [];

  /* ---------- transport actions ---------- */
  const transportActions = {
    selectQuote: (id) => id && run(`quote-${id}`, () => api.patch(`/transport/quotes/${id}/select`), 'Could not select transport bid'),
    releaseQuote: (id) => id && run(`quote-${id}`, () => api.patch(`/transport/quotes/${id}`, { action: 'WITHDRAW' }), 'Could not release the transporter agreement'),
    rejectQuote: (id) => id && run(`quote-${id}`, () => api.patch(`/transport/quotes/${id}`, { action: 'REJECT' }), 'Could not reject transport quote'),
    acceptQuote: async (id) => {
      if (!id) return;
      const ok = await run(`quote-${id}`, () => api.patch(`/transport/quotes/${id}`, { action: 'ACCEPT' }), 'Could not accept transport quote');
      if (ok) scrollToId('payment-center', 150);
    },
    counterQuote: async (id) => {
      if (!id) return;
      const amount = Number(counterInputs[id]);
      if (!Number.isFinite(amount) || amount <= 0) return setError('Enter a valid counter amount before sending.');
      const ok = await run(`quote-${id}`, () => api.patch(`/transport/quotes/${id}`, { action: 'COUNTER', counterAmount: amount }), 'Could not send counter-offer');
      if (ok) setCounterInputs((q) => ({ ...q, [id]: '' }));
    },
    requestRecovery: () =>
      run('recovery-TRANSPORT', async () => {
        await api.post('/recovery-requests', {
          orderId: order.id,
          type: 'TRANSPORT',
          targetParties: isBuyer ? ['BUYER'] : ['SELLER'],
          reason: 'Transport competition has no usable live bid or the previous transporter arrangement is no longer available.',
        });
        setError('Recovery request sent to MarketBridge admin for approval.');
      }, 'Could not request workflow recovery'),
    submitEvidence: async (type, nextStatus) => {
      if (!transportJob || !isTransporter) return;
      const { photoKeys, videoKeys } = evidence;
      if (!photoKeys.length && !videoKeys.length && !evidenceNotes.trim()) {
        return setError(`Add at least one ${type.toLowerCase()} photo/video or note before continuing.`);
      }
      setEvidenceBusy(true);
      setError('');
      try {
        await api.post(`/transport/${transportJob.id}/evidence`, {
          type,
          photos: photoKeys,
          videos: videoKeys,
          notes: evidenceNotes.trim() || undefined,
        });
        if (nextStatus) await api.patch(`/transport/${transportJob.id}/status`, { status: nextStatus });
        setEvidence({ photoKeys: [], videoKeys: [] });
        setEvidenceNotes('');
        await reload();
      } catch (err) {
        setError(getError(err, `Could not submit ${type.toLowerCase()} evidence`));
      } finally {
        setEvidenceBusy(false);
      }
    },
  };

  /* ---------- inspection actions ---------- */
  const inspectionActions = {
    request: async (mode) => {
      if (!order?.listing) return;
      setRequestingInspection(true);
      setError('');
      try {
        await api.post('/inspections', { orderId: order.id, listingId: order.listing.id, mode });
        await reload();
      } catch (err) {
        setError(getError(err, 'Could not request inspection'));
      } finally {
        setRequestingInspection(false);
      }
    },
    cancel: () =>
      currentInspection &&
      window.confirm('Cancel this inspection request without cancelling the order? You can open a new request afterward.') &&
      run(`cancel-inspection-${currentInspection.id}`, () => api.patch(`/inspections/${currentInspection.id}/cancel`), 'Could not cancel inspection request'),
    reopenBidding: () =>
      currentInspection &&
      window.confirm('Reopen inspection bidding? Previous bids will expire and inspectors can submit fresh bids.') &&
      run(`reopen-inspection-${currentInspection.id}`, () => api.patch(`/inspections/${currentInspection.id}/reopen-bidding`), 'Could not reopen inspection bidding'),
    decide: async (decision) => {
      if (!order || !isBuyer || !decisionRequired) return;
      if (decision === 'BUY' && !(currentInspection?.report && currentInspection.status === 'COMPLETED')) {
        return setError('Review the completed inspection report before choosing BUY.');
      }
      if (decision === 'CANCEL' && !window.confirm('Cancel this purchase after reviewing the inspection report? This cannot be undone.')) return;
      const ok = await run(`buyer-decision-${decision.toLowerCase()}`, () => api.patch(`/orders/${order.id}/buyer-decision`, { decision }), `Could not record ${decision === 'BUY' ? 'BUY' : 'cancellation'} decision`);
      if (ok) scrollToId(decision === 'BUY' ? 'payment-center' : 'inspection-section', 120);
    },
  };

  /* ---------- order actions ---------- */
  const canCancelOrder = Boolean(
    order &&
      !['COMPLETED', 'CANCELLED'].includes(order.status) &&
      !transportInMotion &&
      (isAdmin ||
        (isBuyer && order.status === 'PENDING_PAYMENT') ||
        (isSeller && ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)))
  );

  const cancelOrder = () => {
    if (!canCancelOrder) return;
    if (!window.confirm('Cancel this order? This cannot be undone. The listing becomes available again and completed payments are flagged for refund.')) return;
    const reason = window.prompt('Optional: add a reason for cancelling (shown in the order history).') || undefined;
    return run('cancel', () => api.patch(`/orders/${order.id}/cancel`, reason ? { reason } : {}), 'Could not cancel order');
  };

  const confirmReceipt = () => {
    if (!isBuyer) return setError('Only the buyer can confirm receipt');
    if (!marketplacePaid) return setError('Marketplace payment must be confirmed before receipt');
    if (hiredTransport && !transportPaid) return setError('Transport payment must be confirmed before receipt');
    return run('receipt', () => api.patch(`/orders/${order.id}/confirm-receipt`), 'Could not confirm receipt');
  };

  const submitOffer = async (event) => {
    event.preventDefault();
    const amount = Number(offerAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !order?.listingId) {
      return setError('Enter a valid offer amount before submitting.');
    }
    setSubmittingOffer(true);
    const ok = await run('offer', () => api.post('/offers', { listingId: order.listingId, amount, message: offerMessage.trim() || undefined }), 'Could not submit your offer');
    setSubmittingOffer(false);
    if (ok) {
      setOfferAmount('');
      setOfferMessage('');
      setError('Offer submitted. The seller can select it and begin negotiation.');
    }
  };

  const refundAction = (refund) =>
    run(`refund-${refund.id}`, () => {
      const base = `/admin/financial/refunds/${refund.id}`;
      if (refund.status === 'PROCESSING') return api.post(`${base}/verify`);
      if (refund.status === 'FAILED') return api.post(`${base}/retry`);
      return api.post(`${base}/process`);
    }, 'Could not process or verify the refund with Chapa');

  const failRefund = (refund) => {
    const reason = window.prompt('Why did this refund fail?', '');
    if (reason === null) return;
    if (!reason.trim()) return setError('Enter a reason before marking a refund as failed.');
    return run(`refund-${refund.id}`, () => api.patch(`/admin/financial/refunds/${refund.id}/fail`, { failureReason: reason.trim() }), 'Could not mark the refund as failed');
  };

  /* ---------- disputes ---------- */
  const disputeCounterparties = useMemo(() => {
    if (!order) return [];
    return [
      order.buyer && { id: order.buyer.id, name: order.buyer.name, role: 'Buyer' },
      order.seller && { id: order.seller.id, name: order.seller.name, role: 'Seller' },
      ...inspections.filter((r) => r.inspector).map((r) => ({ id: r.inspector.id, name: r.inspector.name, role: 'Inspector' })),
      transportJob?.truckOwner && { id: transportJob.truckOwner.id, name: transportJob.truckOwner.name, role: 'Truck owner' },
    ]
      .filter(Boolean)
      .filter((p) => p.id !== currentUserId);
  }, [order, transportJob, inspections, currentUserId]);

  const canRaiseDispute = Boolean(
    order &&
      !['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(order.status) &&
      (isBuyer || isSeller || isInspector || isTransporter) &&
      disputeCounterparties.length > 0
  );

  const submitDispute = async (event) => {
    event.preventDefault();
    if (!canRaiseDispute) return;
    if (!disputeAgainstId) return setError('Choose who the dispute is against');
    if (!disputeDescription.trim()) return setError('Describe what went wrong');
    setSubmittingDispute(true);
    setError('');
    try {
      await api.post('/disputes', {
        orderId: order.id,
        againstId: disputeAgainstId,
        disputeType,
        description: disputeDescription.trim(),
      });
      setDisputeSubmitted(true);
      setDisputeDescription('');
      await reload();
    } catch (err) {
      const message = getError(err, 'Could not raise dispute');
      if (/cannot be disputed/i.test(message) || /already has an open dispute/i.test(message)) {
        setError(`${message} If the order was cancelled, any payments already made (including an inspection fee) are refunded automatically — check the Payment Center for its status instead of disputing.`);
        await reload();
      } else {
        setError(message);
      }
    } finally {
      setSubmittingDispute(false);
    }
  };

  /* ---------- early returns ---------- */
  if (loading) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <div className="card loading"><p>Loading order…</p></div>
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="section order-detail-page">
        <div className="container-narrow">
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <div className="alert error">{error || 'Order not found'}</div>
        </div>
      </main>
    );
  }

  /* ---------- grouped props for section components ---------- */
  const counterpartId = isBuyer ? order.sellerId : isSeller ? order.buyerId : null;
  const counterpartName = isBuyer ? order.seller?.name : isSeller ? order.buyer?.name : null;
  const orderOpen = !['COMPLETED', 'CANCELLED'].includes(order.status);

  const inspectionProps = {
    all: allInspections,
    current: currentInspection,
    formReleased: inspectionFormReleased,
    requesting: requestingInspection,
    isBuyer,
    isAgricultural,
    decisionRequired,
    busy,
    ...inspectionActions,
  };

  const transportProps = {
    job: transportJob,
    currentUserId,
    isBuyer,
    isSeller,
    isTransporter,
    isArranger: isTransportArranger,
    canArrange: Boolean(!transportJob && order.status !== 'CANCELLED' && isParticipant),
    canChooseQuote: Boolean(transportJob && isTransportArranger && ['REQUESTED', 'QUOTED'].includes(transportJob.status)),
    canStartPayment: canStartTransportPayment,
    canResumePayment: Boolean(transportPayment) && transportPayment.status === 'PENDING' && isBuyer,
    paid: transportPaid,
    paidAmount: transportPayments.find((p) => p.status === 'PAID')?.amount,
    pending: transportPending,
    payment: transportPayment,
    payMethod,
    setPayMethod,
    pay: payTransport,
    resume: resumePayment,
    busy,
    reload,
    recoveryRequests,
    counterInputs,
    setCounterInputs,
    evidence,
    setEvidence,
    notes: evidenceNotes,
    setNotes: setEvidenceNotes,
    evidenceBusy,
    ...transportActions,
  };

  const disputeProps = {
    canRaise: canRaiseDispute,
    counterparties: disputeCounterparties,
    againstId: disputeAgainstId,
    setAgainstId: setDisputeAgainstId,
    type: disputeType,
    setType: setDisputeType,
    description: disputeDescription,
    setDescription: setDisputeDescription,
    submitting: submittingDispute,
    submitted: disputeSubmitted,
    submit: submitDispute,
  };

  /* ====================================================================
     Layout — top to bottom, the order a person works through an order:
     summary → what to do next → offer → inspection → transport →
     payments → receipt → payouts/refunds → history → dispute → rating →
     messages
     ==================================================================== */
  return (
    <main className="section order-detail-page">
      <div className="container-narrow">
        <div className="row-between page-bar">
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <Button size="sm" disabled={refreshing} busy={refreshing} busyText="Refreshing…" onClick={reload}>Refresh</Button>
        </div>

        {/* Summary */}
        <OverviewCard
          order={order}
          title={title}
          flags={{ isBuyer, isSeller, marketplacePaid, marketplacePending, transportJob }}
          canCancel={canCancelOrder}
          busy={busy}
          onCancel={cancelOrder}
        />

        {/* Next step */}
        {workflow ? (
          <ActionCenter workflow={workflow} onScroll={scrollToId} onActionComplete={reload} />
        ) : (
          isInspector && (
            <Card id="next-action" tone="accent" eyebrow="Next step" title="Inspector action">
              {assignedInspection.status === 'ACCEPTED' && <p>Start the accepted inspection.</p>}
              {assignedInspection.status === 'IN_PROGRESS' && <p>Complete the inspection and publish the evidence report.</p>}
              {assignedInspection.status === 'COMPLETED' && <p>The report is published. The buyer can now complete any required inspection payment and continue.</p>}
              <Actions><Link className="btn btn-primary" to="/dashboard/inspector">Open inspection dashboard</Link></Actions>
            </Card>
          )
        )}

        {/* Offer (product marketplace, before a deal exists) */}
        {isProduct && isBuyer && !order.agreedOfferId && (
          <OfferCard
            amount={offerAmount}
            setAmount={setOfferAmount}
            message={offerMessage}
            setMessage={setOfferMessage}
            submitting={submittingOffer}
            onSubmit={submitOffer}
          />
        )}

        {/* Inspection */}
        {inspectionApplies && isParticipant && orderOpen && (
          <InspectionCard order={order} title={title} i={inspectionProps} />
        )}

        {/* Transport */}
        <TransportCard order={order} t={transportProps} />

        {/* Payments */}
        {(!isProduct || order.agreedOfferId) && (
          <PaymentCenter
            workflowPayments={workflow?.payments}
            rawPayments={payments}
            isBuyer={isBuyer}
            buyerIdentityMismatch={buyerIdentityMismatch}
            marketplaceBlockedReason={marketplaceBlockedReason}
            payMethod={payMethod}
            setPayMethod={setPayMethod}
            paymentMethods={PAYMENT_METHODS}
            busy={busy}
            marketplace={marketplaceObligation}
            inspections={inspectionPaymentGroups}
            transport={transportObligation}
          />
        )}

        {/* Receipt */}
        {order.status === 'DELIVERED' && isBuyer && (
          <ReceiptCard
            marketplacePaid={marketplacePaid}
            transportBlocked={hiredTransport && !transportPaid}
            busy={busy}
            onConfirm={confirmReceipt}
          />
        )}

        {/* Money out */}
        <PayoutStatusCard
          payouts={{ seller: payoutBy('SELLER'), inspector: payoutBy('INSPECTOR'), transporter: payoutBy('TRANSPORTER') }}
          names={{ seller: order.seller?.name || null, inspector: inspectorName, transporter: transportJob?.truckOwner?.name || null }}
          you={{ seller: isSeller, inspector: isInspector, transporter: isTransporter }}
        />

        <RefundStatusCard
          refunds={refunds}
          payouts={payouts}
          people={{
            SELLER: { name: order.seller?.name || null, you: isSeller },
            INSPECTOR: { name: inspectorName, you: isInspector },
            TRANSPORTER: { name: transportJob?.truckOwner?.name || null, you: isTransporter },
          }}
          isAdmin={isAdmin}
          busy={busy}
          onComplete={refundAction}
          onFail={failRefund}
        />

        {/* History */}
        {workflow && (
          <Card eyebrow="History" title="Order timeline" subtitle="Everything that has happened on this order">
            <OrderTimeline steps={workflow.timeline?.steps} events={workflow.timeline?.events} />
          </Card>
        )}

        {/* Problems */}
        <DisputeCard order={order} d={disputeProps} />

        {/* Closing */}
        {order.status === 'COMPLETED' && (
          <Card eyebrow="Closed" title="Order completed">
            <Notice title="✓ This order has been completed.">
              <p className="muted">Receipt was confirmed by the buyer.</p>
            </Notice>
          </Card>
        )}

        <RatingBox order={order} userId={currentUserId} onRated={reload} />

        {counterpartId && (
          <MessageThread
            orderId={order.id}
            messages={order.messages || []}
            counterpartId={counterpartId}
            counterpartName={counterpartName}
            currentUserId={currentUserId}
            onSent={reload}
          />
        )}

        {isAdmin && (
          <Card eyebrow="Admin" title="Administrator view" subtitle="You are viewing this order with administrator access." />
        )}
      </div>

      {error && (
        <div className="order-detail-toast" role="alert" aria-live="assertive">
          <span className="order-detail-toast-icon" aria-hidden="true">!</span>
          <span className="order-detail-toast-message">{error}</span>
          <button type="button" className="order-detail-toast-close" onClick={() => setError('')} aria-label="Dismiss message">×</button>
        </div>
      )}
    </main>
  );
}
