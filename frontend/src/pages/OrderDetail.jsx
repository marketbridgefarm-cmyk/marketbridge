import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AmountPicker from '../components/AmountPicker.jsx';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import api from '../api/client';
import {
  startChapaPayment,
  chapaInitializeAndRedirect,
} from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';

import RatingBox from '../components/RatingBox.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import ActionCenter from '../components/ActionCenter.jsx';

import OrderTimeline from '../components/OrderTimeline.jsx';
import PaymentCenter from '../components/PaymentCenter.jsx';
import TransportSetup from '../components/TransportSetup.jsx';
import RefundStatusCard from '../components/RefundStatusCard.jsx';

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
  const go = () => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('od-flash');
    void el.offsetWidth;
    el.classList.add('od-flash');
    window.setTimeout(() => el.classList.remove('od-flash'), 1800);
  };
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
   2. UI primitives
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
          {meta != null && (
            <div className={`od-card-section-meta${strong ? ' is-strong' : ''}`}>
              {meta}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

const Avatar = ({ name, small }) => (
  <span className={`od-party-avatar${small ? ' od-party-avatar--sm' : ''}`} aria-hidden="true">
    {initials(name)}
  </span>
);

function PartyBadge({ role, name }) {
  return (
    <div className="od-card-side-party">
      <div>
        <span className="od-card-side-label">{role}</span>
        <span className="od-card-side-value">{name || '—'}</span>
      </div>
      <Avatar name={name} />
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
   ======================================================================== */

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
                        {name && <Avatar small name={name} />}
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
      side={<Avatar name={other?.name} />}
    >
      <Section title="Order status" meta={`ORD ${shortId(order.id).toUpperCase()}`}>
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
   5. Inspection (with full quote negotiation)
   ======================================================================== */

const PRICE_REVIEW_REASON_OPTIONS = [
  ['MARKET_PRICE_RISE', 'Market price increased'],
  ['MARKET_PRICE_FALL', 'Market price decreased'],
  ['QUALITY_OR_QUANTITY_CHANGE', 'Inspected quantity differs'],
  ['FRESHNESS_OR_DAMAGE', 'Freshness or damage finding'],
  ['OTHER_INSPECTION_FINDING', 'Other inspection finding'],
];

function PriceReviewPanel({ order, i }) {
  const [amount, setAmount] = useState(String(order.finalPrice ?? ''));
  const [reasonCode, setReasonCode] = useState('QUALITY_OR_QUANTITY_CHANGE');
  const [counterAmount, setCounterAmount] = useState('');
  const [counterReason, setCounterReason] = useState('QUALITY_OR_QUANTITY_CHANGE');
  const reviews = Array.isArray(order.priceReviews) ? order.priceReviews : [];
  const pending = [...reviews].reverse().find((review) => review.status === 'PENDING');
  const paymentStarted = (order.payments || []).some((payment) => payment.type === 'MARKETPLACE' && ['PENDING', 'PROCESSING', 'PAID'].includes(payment.status));
  const available = !paymentStarted && !['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status);
  const ownProposal = pending?.proposedById === i.currentUserId;
  const money = (value) => `${Number(value || 0).toLocaleString()} ETB`;
  return (
    <Section title="Provisional price review">
      <p className="muted">The current agreed price is protected from automatic market changes. A price changes only when the other party accepts a proposal. Inspection fees remain separate.</p>
      <div className="detail-facts">
        <div><span>Current agreed price</span><strong>{money(order.finalPrice)}</strong></div>
        <div><span>Price state</span><strong>{order.buyerDecision === 'BUY' ? 'Confirmed for payment' : pending ? 'Awaiting response' : 'Provisional'}</strong></div>
      </div>
      {reviews.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Price-review history</strong>
          {reviews.map((review) => (
            <div key={review.id} style={{ borderTop: '1px solid var(--border-color, #ddd)', padding: '10px 0' }}>
              <div><strong>{money(review.proposedPrice)}</strong> · {PRICE_REVIEW_REASON_OPTIONS.find(([key]) => key === review.reasonCode)?.[1] || review.reasonCode}</div>
              <div className="muted small">{review.proposedBy?.name || (review.proposedById === i.currentUserId ? 'You' : 'Other party')} · {review.status}</div>
            </div>
          ))}
        </div>
      )}
      {pending && available && (
        <div style={{ marginTop: 12 }}>
          <p><strong>Proposal awaiting response:</strong> {money(pending.proposedPrice)} — {PRICE_REVIEW_REASON_OPTIONS.find(([key]) => key === pending.reasonCode)?.[1] || pending.reasonCode}</p>
          {ownProposal ? <p className="muted">Your proposal is waiting for the other party.</p> : (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
                <Button variant="primary" disabled={Boolean(i.busy)} onClick={() => i.respondPriceReview(pending.id, 'ACCEPT')}>Accept revised price</Button>
                <Button variant="light" disabled={Boolean(i.busy)} onClick={() => i.respondPriceReview(pending.id, 'REJECT')}>Reject proposal</Button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                <label>Counter price (ETB)<input type="number" min="0.01" step="0.01" value={counterAmount} onChange={(e) => setCounterAmount(e.target.value)} /></label>
                <label>Reason<select value={counterReason} onChange={(e) => setCounterReason(e.target.value)}>{PRICE_REVIEW_REASON_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              </div>
              <Button variant="light" disabled={Boolean(i.busy) || !(Number(counterAmount) > 0)} onClick={() => i.respondPriceReview(pending.id, 'COUNTER', Number(counterAmount), counterReason)}>Send counter-proposal</Button>
            </>
          )}
        </div>
      )}
      {!pending && available && order.buyerDecision !== 'BUY' && i.isParticipant && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            <label>Proposed total price (ETB)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label>Reason<select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>{PRICE_REVIEW_REASON_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <Button variant="light" disabled={Boolean(i.busy) || !(Number(amount) > 0) || Number(amount) === Number(order.finalPrice)} onClick={() => i.createPriceReview(Number(amount), reasonCode)}>Request price review</Button>
        </div>
      )}
      {order.buyerDecision === 'BUY' && <p className="muted">The price has been confirmed for payment. Further price changes must use the applicable dispute/refund process.</p>}
    </Section>
  );
}

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
          <div className="od-inspection-work-form">
            <h3>Describe the inspection work</h3>
            <p className="muted">Inspectors will see these requirements before submitting a bid. Be specific so their fees cover the same work.</p>
            <label>Inspection category<select value={i.workDetails.workCategory || 'GENERAL_QUALITY'} onChange={(e) => i.setWorkDetails({ ...i.workDetails, workCategory: e.target.value })}><option value="GENERAL_QUALITY">General quality and condition</option><option value="AGRICULTURAL_PRODUCE">Agricultural produce quality</option><option value="QUANTITY_VERIFICATION">Quantity and weight verification</option><option value="DAMAGE_ASSESSMENT">Damage and packaging assessment</option><option value="FUNCTIONAL_TESTING">Functionality / performance testing</option><option value="CONFORMITY_CHECK">Specification / conformity check</option><option value="SAFETY_COMPLIANCE">Safety-related checks</option></select></label>
            <div className="od-form-grid">
              <label>Quantity to inspect<input value={i.workDetails.quantityToInspect} onChange={(e) => i.setWorkDetails({ ...i.workDetails, quantityToInspect: e.target.value })} placeholder="e.g. 500 kg or 20 crates" /></label>
              <label>Number of lots / batches<input type="number" min="1" value={i.workDetails.lotCount} onChange={(e) => i.setWorkDetails({ ...i.workDetails, lotCount: e.target.value })} placeholder="e.g. 4" /></label>
              <label>Inspection deadline<input type="datetime-local" value={i.workDetails.requiredBy} onChange={(e) => i.setWorkDetails({ ...i.workDetails, requiredBy: e.target.value })} /></label>
            </div>
            <fieldset><legend>Checks required</legend><div className="od-check-grid">{[['QUALITY_GRADE','Quality / grading'],['SIZE_WEIGHT','Size / weight'],['MOISTURE','Moisture (if applicable)'],['VISIBLE_DEFECTS','Visible defects / damage'],['PACKAGING','Packaging condition'],['SAMPLING','Sampling / testing'],['PHOTOGRAPHS','Photos / evidence']].map(([value, label]) => <label key={value}><input type="checkbox" checked={i.workDetails.checks.includes(value)} onChange={(e) => i.setWorkDetails({ ...i.workDetails, checks: e.target.checked ? [...i.workDetails.checks, value] : i.workDetails.checks.filter((x) => x !== value) })} /> {label}</label>)}</div></fieldset>
            <label>Report format<select value={i.workDetails.reportFormat || 'CHECKLIST_PHOTOS'} onChange={(e) => i.setWorkDetails({ ...i.workDetails, reportFormat: e.target.value })}><option value="CHECKLIST_PHOTOS">Checklist, findings and photos</option><option value="MEASUREMENTS">Measurements and test results</option><option value="PASS_FAIL">Pass / fail against agreed criteria</option><option value="FULL_REPORT">Full structured inspection report</option></select></label>
            <Button variant="primary" disabled={i.requesting} busy={i.requesting} busyText="Requesting…" onClick={() => i.request(i.isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}>Open inspection competition</Button>
          </div>
        )}
      </Card>
    );
  }

  const report = request.report;
  const reportReady = request.status === 'COMPLETED' && Boolean(report);
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

  // ── Quotes / negotiation state ─────────────────────────────
  const isRequester = request.requestedById === i.currentUserId;
  const quotes = leafQuotes(request.quotes);
  const counterKeyFor = (quoteId) => `inspection-counter-${quoteId}`;
  const busyKey = (quoteId, action) => `inspection-quote-${quoteId}-${action}`;
  const isBusy = (quoteId, action) => i.busy === busyKey(quoteId, action);

  const feePaid = (request.payments || []).some(
    (p) => p.type === 'INSPECTOR' && p.status === 'PAID'
  );
  const feePending = (request.payments || []).some(
    (p) => p.type === 'INSPECTOR' && ['PENDING', 'PROCESSING'].includes(p.status)
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
          {!inspectorName && <Fact name="Status">{label(request.status)}</Fact>}
        </Facts>
        {request.workDetails && <div className="od-work-details"><h4>Agreed inspection scope</h4>{request.workDetails.workDescription && <p>{request.workDetails.workDescription}</p>}<div className="od-work-detail-items">{request.workDetails.quantityToInspect && <span><b>Quantity:</b> {request.workDetails.quantityToInspect}</span>}{request.workDetails.lotCount && <span><b>Lots:</b> {request.workDetails.lotCount}</span>}{request.workDetails.requiredBy && <span><b>Deadline:</b> {formatDateTime(request.workDetails.requiredBy)}</span>}</div>{request.workDetails.checks?.length > 0 && <p><b>Checks:</b> {request.workDetails.checks.map((v) => v.replaceAll('_', ' ').toLowerCase()).join(', ')}</p>}{request.workDetails.reportRequirements && <p><b>Report:</b> {request.workDetails.reportRequirements}</p>}</div>}
      </Section>

      {/* ── Inspector bids and negotiation (REQUESTED state) ── */}
      {request.status === 'REQUESTED' && (
        <Section
          title="Inspector bids"
          meta={`${quotes.length} bid${quotes.length === 1 ? '' : 's'}`}
        >
          {!isRequester ? (
            <p className="muted">
              {quotes.length === 0
                ? 'Waiting for registered inspectors to submit sealed bids.'
                : `The requester is reviewing ${quotes.length} inspector bid(s). You will see the assigned inspector once a quote is accepted.`}
            </p>
          ) : quotes.length === 0 ? (
            <p className="muted">
              Waiting for registered inspectors to submit sealed bids. You can compare
              all bids, then select one for price negotiation.
            </p>
          ) : (
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
                  isRequester && (isSelected || isCounteredByProvider);
                const canSelect = isRequester && isPending;

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
                      </p>
                      {isCounteredByRequester && (
                        <p className="muted small">
                          You countered {money(displayAmount)} ETB — waiting for the
                          inspector.
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
                            disabled={isBusy(quote.id, 'counter')}
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
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* ── Provisional inspector agreement (ACCEPTED state) ── */}
      {request.status === 'ACCEPTED' && request.fee != null && (
        <Section title="Inspector assigned — fee due">
          <p className="muted">
            The inspector is provisionally assigned. Pay the inspection fee below to
            let the inspector start.
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
          ) : i.canPayInspection ? (
            <Button
              variant="primary"
              size="sm"
              disabled={isBusy(request.id, 'pay')}
              busy={isBusy(request.id, 'pay')}
              busyText="Starting…"
              onClick={() => i.payInspection(request)}
            >
              Pay inspection fee
            </Button>
          ) : (
            <p className="muted small">
              Only the buyer can pay the inspector fee.
            </p>
          )}

          {isRequester && (
            <div style={{ marginTop: 12 }}>
              <Button
                variant="light"
                size="sm"
                disabled={Boolean(i.busy)}
                busy={i.busy === `withdraw-inspection-${request.id}`}
                busyText="Releasing…"
                onClick={() => i.withdrawInspectionAgreement(request.id)}
              >
                Inspector unavailable — choose another
              </Button>
              <p className="muted small" style={{ marginTop: 6 }}>
                Provisional agreement — release it if the inspector drops out
                before payment.
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
          {i.isParticipant && <PriceReviewPanel order={order} i={i} />}
        </>
      ) : (
        ['REQUESTED', 'ACCEPTED'].includes(request.status) && (i.isAdmin || i.isParticipant) && (
          <Section title="Inspection recovery">
            <p className="muted">
              {i.isAdmin
                ? 'If every inspector bid is closed, reopen bidding. If the request is no longer wanted, cancel it without cancelling the order.'
                : 'If you no longer want this request, cancel it without cancelling the order. Only MarketBridge admin can reopen inspection bidding.'}
            </p>
            <Actions>
              {i.isAdmin && (
                <Button variant="primary" disabled={Boolean(i.busy)} busy={i.busy === `reopen-inspection-${request.id}`} busyText="Reopening…" onClick={i.reopenBidding}>
                  Reopen inspection bidding
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

  const isArrangerTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'PROVIDER');
  const isTransporterTurn =
    quote.status === 'SELECTED' ||
    (quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER');

  const isOwner = quote.truckOwnerId === t.currentUserId;
  const canRespond =
    (t.canChooseQuote && isArrangerTurn) ||
    (isOwner && isTransporterTurn);
  const rating = typeof quote.truckOwner?.rating === 'number' ? quote.truckOwner.rating.toFixed(1) : '—';
  const ownerName = quote.truckOwner?.name || 'Truck owner';

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
        <p>Status: <span className="badge">{quote.status || 'PENDING'}</span></p>
        {quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER' && (
          <p className="muted">You countered {money(amount)} ETB — waiting for the transporter.</p>
        )}
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
              {isTransporterTurn && quote.status === 'COUNTERED' ? 'Accept buyer counter' : 'Accept quote'}
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

  if (!job) {
    return (
      <Card
        id="transport-section"
        eyebrow="Logistics"
        title="Transport"
        subtitle="The buyer or seller arranges transport. MarketBridge does not assign a transporter automatically."
      >
        {t.canArrange ? (
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
        )}
      </Card>
    );
  }

  const evidenceAvailable =
    t.isTransporter && (job.status === 'PICKUP' || job.status === 'IN_TRANSIT');
  const hasEvidenceContent =
    evidenceAvailable || job.status === 'DELIVERED' || job.incidentNotes;

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
          {job.workDetails && <div className="od-work-details"><h4>Transport work requirements</h4><div className="od-work-detail-items">{job.workDetails.weight && <span><b>Weight:</b> {job.workDetails.weight}</span>}{job.workDetails.packageCount && <span><b>Packages:</b> {job.workDetails.packageCount}</span>}{job.workDetails.vehicleType && <span><b>Vehicle:</b> {job.workDetails.vehicleType}</span>}{job.workDetails.deliveryDeadline && <span><b>Deadline:</b> {formatDateTime(job.workDetails.deliveryDeadline)}</span>}</div>{job.workDetails.handling?.length > 0 && <p><b>Handling:</b> {job.workDetails.handling.map((v) => v.replaceAll('_', ' ').toLowerCase()).join(', ')}</p>}</div>}
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
      </Card>

      {hasEvidenceContent && (
        <Card
          id="transport-evidence-section"
          eyebrow="Evidence"
          title="Pickup & delivery evidence"
          subtitle="Photos, videos and handover notes uploaded by the transporter at pickup and delivery."
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
              The transporter must upload pickup evidence before moving the trip from Pickup to In transit, and delivery
              evidence before marking it Delivered.
            </p>
            {t.isTransporter && job.status === 'PICKUP' && <EvidenceForm kind="PICKUP" t={t} />}
            {t.isTransporter && job.status === 'IN_TRANSIT' && <EvidenceForm kind="DELIVERY" t={t} />}
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
        {hired && !t.paid && (
          <Section title="Transport quotes" meta="Bids">
            {quotes.length ? (
              quotes.map((q) => <QuoteRow key={q.id} quote={q} t={t} />)
            ) : (
              <p className="muted">
                Waiting for registered truck owners to submit quotes.
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
              Transport payment is separate from the seller payment. You can pay as soon as the quote is accepted. The
              transporter cannot start the trip until every required payment is confirmed.
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
              <Button
                variant="primary"
                disabled={
                  Boolean(t.busy) ||
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

/* ========================================================================
   7. Offer, receipt, dispute, completed, admin
   ======================================================================== */

function OfferCard({ amount, setAmount, reference, submitting, onSubmit }) {
  return (
    <Card id="make-offer" eyebrow="Product marketplace" title="Make an offer" subtitle="Your offer enters the seller's competition. It does not charge you or reserve the product.">
      <form onSubmit={onSubmit} className="form">
        <label htmlFor="offer-amount">Offer amount (ETB)</label>
        <AmountPicker id="offer-amount" reference={reference} min={1} placeholder="Select your offer" value={amount} onChange={setAmount} disabled={submitting} required ariaLabel="Offer amount in ETB" />
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
          <select id="dispute-description" className="field" value={d.description} onChange={(e) => d.setDescription(e.target.value)} required><option value="">Select a dispute reason</option><option value="ITEM_NOT_AS_DESCRIBED">Item differs from agreed description</option><option value="INSPECTION_CONCERN">Inspection or quality concern</option><option value="PAYMENT_ISSUE">Payment issue</option><option value="DELIVERY_ISSUE">Delivery or transport issue</option><option value="DAMAGE_OR_LOSS">Damage or loss</option><option value="OTHER_REVIEW_REQUIRED">Other issue requiring admin review</option></select>
          <button type="submit" className="btn btn-outline" disabled={d.submitting}>{d.submitting ? 'Submitting…' : 'Raise dispute'}</button>
        </form>
      )}
    </Card>
  );
}

function BuyerConfidenceCard({ order, recoveryRequests }) {
  const latest = [...(recoveryRequests || [])].sort((a, b) =>
    new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  )[0];
  const hasOpenDispute = order?.status === 'DISPUTED';
  const recoveryPending = latest?.status === 'PENDING';
  const formReleased = Boolean(latest?.formReleasedAt) || latest?.status === 'APPROVED';
  const recoveryRejected = latest?.status === 'REJECTED';

  let status = 'Order remains active';
  let detail = 'If an inspection or transport arrangement changes, the affected service can be reviewed separately. Your goods order is not automatically cancelled.';
  let tone = 'is-safe';
  if (hasOpenDispute) {
    status = 'Admin review in progress';
    detail = 'The case is under review. Payments affected by the dispute remain protected while the decision is pending. You will see the next permitted action here after review.';
    tone = 'is-review';
  } else if (recoveryPending) {
    status = 'Waiting for admin approval';
    detail = `Your ${String(latest.type || 'service').toLowerCase()} recovery request has been submitted. A fresh competition is not opened until an administrator approves it.`;
    tone = 'is-review';
  } else if (formReleased) {
    status = 'Fresh competition available';
    detail = 'Admin approved recovery. Follow the released form to invite new bids. The replacement provider must have its own agreement and payment.';
    tone = 'is-safe';
  } else if (recoveryRejected) {
    status = 'Recovery request reviewed';
    detail = 'The latest recovery request was not approved. Review the decision and reason, then contact MarketBridge support if you need help.';
    tone = 'is-review';
  }

  return (
    <section className={`card od-buyer-confidence ${tone}`} aria-live="polite">
      <div className="od-confidence-icon" aria-hidden="true">{hasOpenDispute || recoveryPending ? 'i' : '✓'}</div>
      <div className="od-confidence-main">
        <span className="od-eyebrow">MARKETBRIDGE ORDER PROTECTION</span>
        <h2>{status}</h2>
        <p>{detail}</p>
        <div className="od-confidence-promises">
          <span><b aria-hidden="true">✓</b> Service issues reviewed separately</span>
          <span><b aria-hidden="true">✓</b> No automatic replacement charge</span>
          <span><b aria-hidden="true">✓</b> Payment and refund status stays visible</span>
        </div>
      </div>
    </section>
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
  const [submittingOffer, setSubmittingOffer] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState(false);
  const [inspectionWorkDetails, setInspectionWorkDetails] = useState({ workCategory: 'GENERAL_QUALITY', quantityToInspect: '', lotCount: '', checks: ['QUALITY_GRADE', 'VISIBLE_DEFECTS', 'PHOTOGRAPHS'], reportFormat: 'CHECKLIST_PHOTOS', requiredBy: '' });

  const [disputeAgainstId, setDisputeAgainstId] = useState('');
  const [disputeType, setDisputeType] = useState('NOT_DELIVERED');
  const [disputeDescription, setDisputeDescription] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);

  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), 3000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!orderId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const orderRes = await api.get(`/orders/${orderId}`);
        const nextOrder = orderRes.data?.order || null;
        setOrder(nextOrder);
        if (!silent) setLoading(false);

        const [workflowRes, recoveryRes] = await Promise.allSettled([
          api.get(`/orders/${orderId}/workflow`),
          api.get(`/recovery-requests/order/${orderId}`),
        ]);

        setWorkflow(
          workflowRes.status === 'fulfilled'
            ? workflowRes.value.data?.workflow || null
            : null
        );
        setRecoveryRequests(
          recoveryRes.status === 'fulfilled'
            ? recoveryRes.value.data?.recoveryRequests || []
            : []
        );
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

  const currentUserId = user?.id || user?.userId || user?._id || null;
  const isAdmin = (Array.isArray(user?.roles) ? user.roles : []).includes('ADMIN');
  const isBuyer = Boolean(order && currentUserId && currentUserId === order.buyerId);
  const isSeller = Boolean(order && currentUserId && currentUserId === order.sellerId);
  const isParticipant = isBuyer || isSeller;
  const buyerIdentityMismatch = Boolean(order && currentUserId && !isParticipant && !isAdmin);

  const isAgricultural = order?.listing?.category === 'AGRICULTURAL';
  const isProduct = order?.listing?.category === 'PRODUCT';
  const inspectionApplies = isAgricultural || isProduct;
  const title = order?.listing?.title || order?.listing?.cropType || 'Order';

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

  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const active = (p) => ['PENDING', 'PROCESSING'].includes(p.status);
  const pick = (list) => list.find(active) || list.find((p) => p.status === 'PAID') || null;

  const marketplacePayments = useMemo(() => payments.filter((p) => p.type === 'MARKETPLACE'), [payments]);
  const transportPayments = useMemo(() => payments.filter((p) => p.type === 'TRANSPORT'), [payments]);
  const marketplacePayment = useMemo(() => pick(marketplacePayments), [marketplacePayments]);
  const transportPayment = useMemo(() => pick(transportPayments), [transportPayments]);

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

  const payouts = order?.payouts || [];
  const payoutBy = (role) => payouts.find((p) => p.payeeRole === role) || null;
  const refunds = order?.refunds || [];

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

  const inspectionActions = {
    request: async (mode) => {
      if (!order?.listing) return;
      setRequestingInspection(true);
      setError('');
      try {
        await api.post('/inspections', { orderId: order.id, listingId: order.listing.id, mode, workDetails: inspectionWorkDetails });
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
    isBuyer,
    isSeller,
    isParticipant,
    createPriceReview: (proposedPrice, reasonCode) => run(
      'price-review-create',
      () => api.post(`/orders/${order.id}/price-reviews`, { proposedPrice, reasonCode }),
      'Could not submit price review'
    ),
    respondPriceReview: (reviewId, action, proposedPrice, reasonCode) => run(
      `price-review-${reviewId}-${action.toLowerCase()}`,
      () => api.patch(`/orders/${order.id}/price-reviews/${reviewId}/respond`, { action, ...(proposedPrice ? { proposedPrice, reasonCode } : {}) }),
      'Could not respond to price review'
    ),
    selectInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-select`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/select`),
        'Could not select inspection bid'
      );
    },
    acceptInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-accept`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/accept`),
        'Could not accept inspection quote'
      );
    },
    counterInspectionQuote: async (quoteId, counterKey) => {
      if (!currentInspection) return;
      const amount = Number(counterInputs[counterKey] || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Enter a valid counter amount before sending.');
        return;
      }
      const ok = await run(
        `inspection-quote-${quoteId}-counter`,
        () =>
          api.post(`/inspections/${currentInspection.id}/quotes/${quoteId}/counter`, {
            counterAmount: amount,
          }),
        'Could not send counter-offer'
      );
      if (ok) setCounterInputs((prev) => ({ ...prev, [counterKey]: '' }));
    },
    rejectInspectionQuote: (quoteId) => {
      if (!currentInspection) return;
      return run(
        `inspection-quote-${quoteId}-reject`,
        () => api.patch(`/inspections/${currentInspection.id}/quotes/${quoteId}/reject`),
        'Could not reject inspection quote'
      );
    },
    withdrawInspectionAgreement: (requestId) => {
      if (!currentInspection) return;
      const accepted = leafQuotes(currentInspection.quotes).find(
        (q) => q.status === 'ACCEPTED'
      );
      if (!accepted) return;
      const reason = window.prompt(
        'Why are you releasing this provisional inspection agreement?',
        'Inspector unavailable before payment'
      );
      if (reason === null) return;
      return run(
        `withdraw-inspection-${requestId}`,
        () =>
          api.patch(`/inspections/${requestId}/quotes/${accepted.id}/withdraw`, {
            reason: (reason || '').trim() || undefined,
          }),
        'Could not release inspection agreement'
      );
    },
    payInspection: (request) => payInspection(request),
    currentUserId,
    counterInputs,
    setCounterInputs,
    canPayInspection: Boolean(
      currentInspection &&
      isBuyer &&
      currentInspection.status === 'ACCEPTED' &&
      currentInspection.fee != null &&
      !(currentInspection.payments || []).some((p) =>
        ['PENDING', 'PROCESSING', 'PAID'].includes(p.status)
      )
    ),
  };

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
    const ok = await run('offer', () => api.post('/offers', { listingId: order.listingId, amount }), 'Could not submit your offer');
    setSubmittingOffer(false);
    if (ok) {
      setOfferAmount('');
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

  const counterpartId = isBuyer ? order.sellerId : isSeller ? order.buyerId : null;
  const counterpartName = isBuyer ? order.seller?.name : isSeller ? order.buyer?.name : null;
  const orderOpen = !['COMPLETED', 'CANCELLED'].includes(order.status);

  const inspectionProps = {
    all: allInspections,
    current: currentInspection,
    formReleased: inspectionFormReleased,
    requesting: requestingInspection,
    workDetails: inspectionWorkDetails,
    setWorkDetails: setInspectionWorkDetails,
    isBuyer,
    isAdmin,
    isParticipant,
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

  return (
    <main className="section order-detail-page">
      <div className="container-narrow">
        <div className="row-between page-bar">
          <button type="button" className="back-link" onClick={() => navigate(-1)}>← Back</button>
          <Button size="sm" disabled={refreshing} busy={refreshing} busyText="Refreshing…" onClick={reload}>Refresh</Button>
        </div>

        <div className="od-page-grid">
          <div className="od-span-all">
            <OverviewCard
              order={order}
              title={title}
              flags={{ isBuyer, isSeller, marketplacePaid, marketplacePending, transportJob }}
              canCancel={canCancelOrder}
              busy={busy}
              onCancel={cancelOrder}
            />
          </div>

          {isBuyer && (
            <div className="od-span-all">
              <BuyerConfidenceCard order={order} recoveryRequests={recoveryRequests} />
            </div>
          )}

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

          {isProduct && isBuyer && !order.agreedOfferId && (
            <OfferCard
              amount={offerAmount}
              setAmount={setOfferAmount}
              reference={Number(order.listing?.askingPrice ?? order.listing?.price)}
              submitting={submittingOffer}
              onSubmit={submitOffer}
            />
          )}

          {inspectionApplies && isParticipant && orderOpen && (
            <InspectionCard order={order} title={title} i={inspectionProps} />
          )}

          <div className="od-span-all">
            <TransportCard order={order} t={transportProps} />
          </div>

          {(!isProduct || order.agreedOfferId) && (
            <div className="od-span-all">
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
            </div>
          )}

          {order.status === 'DELIVERED' && isBuyer && (
            <ReceiptCard
              marketplacePaid={marketplacePaid}
              transportBlocked={hiredTransport && !transportPaid}
              busy={busy}
              onConfirm={confirmReceipt}
            />
          )}

          <div className="od-span-all">
            <PayoutStatusCard
              payouts={{ seller: payoutBy('SELLER'), inspector: payoutBy('INSPECTOR'), transporter: payoutBy('TRANSPORTER') }}
              names={{ seller: order.seller?.name || null, inspector: inspectorName, transporter: transportJob?.truckOwner?.name || null }}
              you={{ seller: isSeller, inspector: isInspector, transporter: isTransporter }}
            />
          </div>

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

          {workflow && (
            <div className="od-span-all">
              <Card eyebrow="History" title="Order timeline" subtitle="Everything that has happened on this order">
                <OrderTimeline steps={workflow.timeline?.steps} events={workflow.timeline?.events} />
              </Card>
            </div>
          )}

          <DisputeCard order={order} d={disputeProps} />

          {order.status === 'COMPLETED' && (
            <Card eyebrow="Closed" title="Order completed">
              <Notice title="✓ This order has been completed.">
                <p className="muted">Receipt was confirmed by the buyer.</p>
              </Notice>
            </Card>
          )}

          <RatingBox order={order} userId={currentUserId} onRated={reload} />

          {counterpartId && (
            <div className="od-span-all">
            </div>
          )}

          {isAdmin && (
            <Card eyebrow="Admin" title="Administrator view" subtitle="You are viewing this order with administrator access." />
          )}
        </div>
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
