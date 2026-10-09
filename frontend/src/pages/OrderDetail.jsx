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

import InspectionCoordinationSeller from '../components/InspectionCoordinationSeller.jsx';
import OrderDecisionPanel from '../components/OrderDecisionPanel.jsx';
import TransportLoadingReport, {
  TransportLoadingReportSummary,
} from '../components/TransportLoadingReport.jsx';
import TransportCoordinationSeller from '../components/TransportCoordinationSeller.jsx';
import TransportCoordinationTransporter from '../components/TransportCoordinationTransporter.jsx';

import RatingBox from '../components/RatingBox.jsx';
import EvidenceGallery from '../components/EvidenceGallery.jsx';
import EvidenceUploader from '../components/EvidenceUploader.jsx';
import ActionCenter from '../components/ActionCenter.jsx';

import OrderTimeline from '../components/OrderTimeline.jsx';
import PaymentCenter from '../components/PaymentCenter.jsx';
import TransportSetup from '../components/TransportSetup.jsx';
import { InspectionRequestSummary, TransportRequestSummary } from '../components/RequestScopeSummary.jsx';
import { DEADLINE_WINDOWS, QUANTITY_VALUES, deadlineFromWindow } from '../components/RequestOptions.js';
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

// ── Modal shell ───────────────────────────────────────────────────────────
function Modal({ isOpen, onClose, title, children }) {
  if (!isOpen) return null;
  return (
    <div className="od-modal-backdrop" onClick={onClose}>
      <div className="od-modal" onClick={(e) => e.stopPropagation()}>
        <div className="od-modal-head">
          <span className="od-modal-title">{title}</span>
          <button type="button" className="od-modal-close" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>
        <div className="od-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

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
   5. Inspection — request form (popup) + status card
   ======================================================================== */

// ── Inspection request form (opened in a modal) ───────────────────────────
function InspectionRequestForm({ workDetails, setWorkDetails, requesting, request, isBuyer, onCancel }) {
  return (
    <div className="od-inspection-work-form">
      <h3>Describe the inspection work</h3>
      <p className="muted">
        Inspectors will see these requirements before submitting a bid. Be specific so their fees
        cover the same work.
      </p>

      <label>Inspection category
        <select
          value={workDetails.workCategory || 'GENERAL_QUALITY'}
          onChange={(e) => setWorkDetails({ ...workDetails, workCategory: e.target.value })}
        >
          <option value="GENERAL_QUALITY">General quality and condition</option>
          <option value="AGRICULTURAL_PRODUCE">Agricultural produce quality</option>
          <option value="QUANTITY_VERIFICATION">Quantity and weight verification</option>
          <option value="DAMAGE_ASSESSMENT">Damage and packaging assessment</option>
          <option value="FUNCTIONAL_TESTING">Functionality / performance testing</option>
          <option value="CONFORMITY_CHECK">Specification / conformity check</option>
          <option value="SAFETY_COMPLIANCE">Safety-related checks</option>
        </select>
      </label>

      <div className="od-form-grid">
        <label>
          Quantity to inspect
          <div className="od-quantity-row">
            <select
              className="field"
              aria-label="Quantity to inspect"
              value={workDetails.quantityValue || ''}
              onChange={(e) => setWorkDetails({ ...workDetails, quantityValue: e.target.value })}
            >
              <option value="">Select quantity…</option>
              {QUANTITY_VALUES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <select
              className="field"
              value={workDetails.quantityUnit || 'kg'}
              onChange={(e) => setWorkDetails({ ...workDetails, quantityUnit: e.target.value })}
            >
              <option value="kg">kg</option>
              <option value="tons">tons</option>
              <option value="quintals">quintals</option>
              <option value="units">units</option>
              <option value="crates">crates</option>
              <option value="bags">bags</option>
            </select>
          </div>
        </label>

        <label>Number of lots / batches
          <select
            value={
              workDetails.lotCount === undefined || workDetails.lotCount === null
                ? ''
                : String(workDetails.lotCount)
            }
            onChange={(e) => {
              const raw = e.target.value;
              setWorkDetails({
                ...workDetails,
                lotCount: raw === '' ? '' : Number(raw),
              });
            }}
          >
            <option value="">Select number of lots…</option>
            <option value="1">1 lot</option>
            <option value="2">2 lots</option>
            <option value="3">3 lots</option>
            <option value="4">4 lots</option>
            <option value="5">5 lots</option>
            <option value="6">6 lots</option>
            <option value="7">7 lots</option>
            <option value="8">8 lots</option>
            <option value="9">9 lots</option>
            <option value="10">10 lots</option>
            <option value="15">More than 10 lots (approx. 15)</option>
            <option value="20">More than 20 lots (approx. 20)</option>
          </select>
        </label>

        <label>Inspection deadline
          <select
            className="field"
            value={workDetails.deadlineWindow || ''}
            onChange={(e) =>
              setWorkDetails({
                ...workDetails,
                deadlineWindow: e.target.value,
                requiredBy: deadlineFromWindow(e.target.value),
              })
            }
          >
            <option value="">No deadline</option>
            {DEADLINE_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>{w.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="od-inspection-checks">
        Checks required (hold Ctrl / Cmd to select multiple)
        <select
          multiple
          size={7}
          className="od-inspection-checks-select"
          value={Array.isArray(workDetails.checks) ? workDetails.checks : []}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
            setWorkDetails({ ...workDetails, checks: selected });
          }}
        >
          <option value="QUALITY_GRADE">Quality / grading</option>
          <option value="SIZE_WEIGHT">Size / weight</option>
          <option value="MOISTURE">Moisture (if applicable)</option>
          <option value="VISIBLE_DEFECTS">Visible defects / damage</option>
          <option value="PACKAGING">Packaging condition</option>
          <option value="SAMPLING">Sampling / testing</option>
          <option value="PHOTOGRAPHS">Photos / evidence</option>
        </select>
      </label>

      <p className="muted small">
        {Array.isArray(workDetails.checks) && workDetails.checks.length > 0
          ? `Selected: ${workDetails.checks.map((c) => c.replaceAll('_', ' ').toLowerCase()).join(', ')}`
          : 'No checks selected yet.'}
      </p>

      <label>Report format
        <select
          value={workDetails.reportFormat || 'CHECKLIST_PHOTOS'}
          onChange={(e) => setWorkDetails({ ...workDetails, reportFormat: e.target.value })}
        >
          <option value="CHECKLIST_PHOTOS">Checklist, findings and photos</option>
          <option value="MEASUREMENTS">Measurements and test results</option>
          <option value="PASS_FAIL">Pass / fail against agreed criteria</option>
          <option value="FULL_REPORT">Full structured inspection report</option>
        </select>
      </label>

      <div className="od-actions">
        <Button
          variant="primary"
          disabled={requesting}
          busy={requesting}
          busyText="Requesting…"
          disabled={!workDetails.quantityValue}
          onClick={() => request(isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}
        >
          Open inspection competition
        </Button>
        <Button variant="light" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
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
  const reportReady = request.status === 'COMPLETED' && Boolean(report);
  // A fresh form is released only when no inspector is waiting or pending.
  const liveBidderCount = leafQuotes(request.quotes).filter((q) => ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)).length;
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
  const quotes = leafQuotes(request.quotes);
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
        <Section title="Inspection coordination">
          <p className="muted">Share site access and coordination details with the inspector.</p>
          <Button variant="light" size="sm" onClick={() => i.onOpenModal('inspection-coordination')}>
            Open inspection coordination
          </Button>
        </Section>
      )}

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

      {request.status === 'ACCEPTED' && request.fee != null && (
        <Section title={request.sellerConfirmedAt ? 'Inspector confirmed — fee payment' : 'Inspector provisionally selected'}>
          <p className="muted">
            {request.sellerConfirmedAt
              ? 'The seller confirmed the inspector and agreed fee. The designated payer(s) can now pay the inspection obligation.'
              : 'The inspector and fee are provisionally agreed. The seller must confirm them before inspection payment can begin.'}
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
          ) : i.isSeller && !request.sellerConfirmedAt ? (
            <>
              <p className="muted small">
                Confirm the inspector and agreed fee to unlock payment and let
                work begin. If you do not respond
                {request.workflowDueAt ? ` by ${new Date(request.workflowDueAt).toLocaleString()}` : ' in time'},
                the provisional purchase is closed automatically.
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={Boolean(i.busy)}
                busy={i.busy === `seller-confirm-${request.id}`}
                busyText="Confirming…"
                onClick={() => i.confirmSellerInspection(request.id)}
              >
                Confirm inspector &amp; fee
              </Button>
              <Button
                variant="light"
                size="sm"
                disabled={Boolean(i.busy)}
                busy={i.busy === `seller-decline-${request.id}`}
                busyText="Declining…"
                onClick={() => {
                  if (window.confirm('Decline this inspector and fee? The provisional purchase will be closed and the buyer notified.')) {
                    i.declineSellerInspection(request.id);
                  }
                }}
              >
                Decline
              </Button>
            </>
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
          ) : request.sellerConfirmedAt ? (
            <p className="muted small">
              Seller confirmed. The designated payer can now pay the inspection fee
              {request.workflowDueAt ? ` before ${new Date(request.workflowDueAt).toLocaleString()}` : ''}.
            </p>
          ) : (
            <p className="muted small">
              Waiting for the seller to confirm the selected inspector before
              payment can begin
              {request.workflowDueAt ? `. If the seller does not respond by ${new Date(request.workflowDueAt).toLocaleString()}, this purchase is closed automatically` : ''}.
            </p>
          )}

          {isRequester && (
            <div style={{ marginTop: 12 }}>
              <ReleaseAgreementControl
                acceptedQuote={leafQuotes(request.quotes).find((q) => q.status === 'ACCEPTED')}
                label="Inspector unavailable — choose another"
                busy={i.busy === `withdraw-inspection-${request.id}`}
                disabled={Boolean(i.busy)}
                onConfirm={(reason, note) => i.withdrawInspectionAgreement(request.id, { reason, note })}
              />
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

/* ========================================================================
   6. Transport
   ======================================================================== */

function DeliveryEvidenceForm({ t }) {
  const { evidence, setEvidence, notes, setNotes, evidenceBusy } = t;
  const ready = evidence.photoKeys.length || evidence.videoKeys.length || notes.trim();
  return (
    <Notice title="Delivery evidence">
      <p className="muted">Upload delivery evidence before marking the trip delivered.</p>
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
        placeholder="Optional delivery condition / handover notes…"
        rows={3}
        disabled={evidenceBusy}
      />
      <Button
        variant="primary"
        disabled={evidenceBusy || !ready}
        busy={evidenceBusy}
        busyText="Submitting…"
        onClick={() => t.submitEvidence('DELIVERY', 'DELIVERED')}
      >
        Submit delivery evidence & mark delivered
      </Button>
    </Notice>
  );
}

const RELEASE_AFTER_ACCEPT_HOURS = (() => {
  const configured = Number(import.meta?.env?.VITE_RELEASE_AFTER_ACCEPT_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 24;
})();

const RELEASE_REASONS = [
  ['PROVIDER_UNAVAILABLE', 'Provider is unavailable'],
  ['NO_RESPONSE', 'Provider is not responding'],
  ['PRICE_CHANGED', 'Provider changed the price'],
  ['SCHEDULE_CONFLICT', 'Schedule conflict'],
  ['OTHER', 'Other (add a note)'],
];

function acceptedReleaseAvailableAt(acceptedQuote) {
  if (!acceptedQuote) return null;
  const since = new Date(acceptedQuote.updatedAt || acceptedQuote.createdAt).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + RELEASE_AFTER_ACCEPT_HOURS * 60 * 60 * 1000);
}

function ReleaseAgreementControl({ acceptedQuote, label, busy, disabled, onConfirm }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const availableAt = acceptedReleaseAvailableAt(acceptedQuote);
  const now = useNowUntil(availableAt ? availableAt.getTime() : null);
  const locked = availableAt !== null && availableAt.getTime() > now;
  const needsNote = reason === 'OTHER';
  const canSubmit = Boolean(reason) && (!needsNote || note.trim().length > 0);

  if (locked) {
    return (
      <span className="muted small">
        Release opens {formatDateTime(availableAt)} ({RELEASE_AFTER_ACCEPT_HOURS}h after acceptance).
      </span>
    );
  }

  if (!open) {
    return (
      <Button variant="light" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="od-release-form" style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <label>
        Reason for releasing
        <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}>
          <option value="">Select a reason…</option>
          {RELEASE_REASONS.map(([value, text]) => (
            <option key={value} value={value}>{text}</option>
          ))}
        </select>
      </label>
      {needsNote && (
        <input
          type="text"
          maxLength={200}
          placeholder="Short note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      )}
      <p className="muted small">
        Each release is recorded against your account and visible to MarketBridge admin.
        After 2 releases on this job, further releases need admin review.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="light"
          size="sm"
          disabled={disabled || !canSubmit}
          busy={busy}
          busyText="Releasing…"
          onClick={async () => {
            const ok = await onConfirm(reason, note.trim());
            if (ok) { setOpen(false); setReason(''); setNote(''); }
          }}
        >
          Confirm release
        </Button>
        <Button variant="light" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
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
  const isTransporterTurn =
    quote.status === 'COUNTERED' && quote.counteredBy === 'REQUESTER';

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

function TransportCard({ order, t }) {
  const job = t.job;
  const hired = job?.method === 'HIRE_TRANSPORTER';
  const quotes = leafQuotes(job?.quotes);

  const hasActiveNegotiation = quotes.some((q) =>
    ['SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)
  );
  // A fresh form is released only when no transporter is waiting or pending.
  const liveBidderCount = quotes.filter((q) => ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'].includes(q.status)).length;

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
            {t.buyerOnly ? 'The buyer requests transport for this order once the inspection is complete.' : 'No transport arrangement recorded yet.'}
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

        {['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status) && (
          <Section title="Coordination">
            {t.isSeller && (
              <Button variant="light" size="sm" onClick={() => t.onOpenModal('seller-transport-coordination')}>
                Open pickup handoff
              </Button>
            )}
            {t.isTransporter && (
              <Button variant="light" size="sm" onClick={() => t.onOpenModal('transporter-transport-coordination')}>
                Open pickup handoff
              </Button>
            )}
          </Section>
        )}

        {t.isTransporter && job.status === 'ACCEPTED' && (
          <TransportLoadingReport
            transportJobId={job.id}
            jobStatus={job.status}
            sellerConfirmed={Boolean(job.sellerPickupConfirmedAt)}
            paymentsReady={t.marketplacePaid}
            missingPayments={t.missingPayments}
            onSubmitted={t.reload}
          />
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
                <p className="muted small">Review what the transporter plans to load, the quantity, timing and condition. Approve it before physical loading begins.</p>
                <Button
                  variant="primary"
                  disabled={busy === 'confirm-loading'}
                  busy={busy === 'confirm-loading'}
                  busyText="Confirming…"
                  onClick={() => run('confirm-loading', () => api.post(`/transport/${job.id}/confirm-loading`), 'Could not approve the loading report')}
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
              transporter uploads delivery evidence before marking the trip
              delivered.
            </p>
            {t.isTransporter && job.status === 'IN_TRANSIT' && <DeliveryEvidenceForm t={t} />}
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
              Transport payment is separate from the seller payment. It becomes available only after the buyer makes the final BUY decision and the seller payment is confirmed. The transporter cannot start loading until the required payments and loading approvals are complete.
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

  const [activeModal, setActiveModal] = useState(null);

  const [payMethod, setPayMethod] = useState('TELEBIRR');

  const [counterInputs, setCounterInputs] = useState({});
  const [evidence, setEvidence] = useState({ photoKeys: [], videoKeys: [] });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  const [offerAmount, setOfferAmount] = useState('');
  const [submittingOffer, setSubmittingOffer] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState(false);
  const [inspectionWorkDetails, setInspectionWorkDetails] = useState({
    workCategory: 'GENERAL_QUALITY',
    quantityValue: '',
    quantityUnit: 'kg',
    lotCount: '',
    checks: ['QUALITY_GRADE', 'VISIBLE_DEFECTS', 'PHOTOGRAPHS'],
    reportFormat: 'CHECKLIST_PHOTOS',
    requiredBy: '',
  });

  const [loadingReport, setLoadingReport] = useState(null);
  const [loadingReportEvidence, setLoadingReportEvidence] = useState(null);

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

        const job = nextOrder?.transportJob || null;
        if (job && ['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(job.status)) {
          try {
            const lr = await api.get(`/transport/${job.id}/loading-report`);
            setLoadingReport(lr.data?.loadingReport || null);
            setLoadingReportEvidence(lr.data?.evidence || null);
          } catch (_) {
            setLoadingReport(null);
            setLoadingReportEvidence(null);
          }
        } else {
          setLoadingReport(null);
          setLoadingReportEvidence(null);
        }
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

  // Section targets that need a request form open the popup (after scrolling to the card).
  const goToSection = (id, delay = 0) => {
    const needsInspectionForm =
      id === 'inspection-section' && !currentInspection && (inspections.length === 0 || inspectionFormReleased);
    const needsTransportForm =
      id === 'transport-section' && !transportJob && order && order.status !== 'CANCELLED' && !transportBlockedReason && (isPhysicalGoods ? isBuyer : isBuyer || isSeller);
    scrollToId(id, delay);
    if (needsInspectionForm) setActiveModal('inspection-request-form');
    else if (needsTransportForm) setActiveModal('transport-setup-form');
  };

  useEffect(() => {
    if (loading) return;
    const id = location.hash?.replace('#', '');
    if (id) goToSection(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Same rules the server enforces: for physical goods, transport opens only after the
  // inspection report is published and its fee paid, and the buyer runs the transporter competition.
  const isPhysicalGoods = isAgricultural || isProduct;
  const inspectionReportDone = Boolean(currentInspection && currentInspection.status === 'COMPLETED' && currentInspection.report);
  const paidInspections = inspections.filter((r) => r.fee != null && Number(r.fee) > 0);
  const inspectionFeesPaid =
    !paidInspections.every((r) => Array.isArray(r.payments)) ||
    paidInspections.every((r) => r.payments.some((p) => p.type === 'INSPECTOR' && p.status === 'PAID'));
  const transportBlockedReason = !isPhysicalGoods
    ? null
    : !inspectionReportDone
      ? 'Transport opens after the inspection report is published.'
      : !inspectionFeesPaid
        ? 'Transport opens after the inspection fee is paid.'
        : null;

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

  const missingPayments = useMemo(() => {
    const missing = [];
    if (!marketplacePaid) missing.push('MARKETPLACE');
    for (const r of inspections) {
      if (r.fee == null || Number(r.fee) <= 0) continue;
      const paid = (r.payments || []).some((p) => p.type === 'INSPECTOR' && p.status === 'PAID');
      if (!paid) missing.push(`INSPECTOR:${r.id}`);
    }
    if (hiredTransport && !transportPaid) missing.push('TRANSPORT');
    return missing;
  }, [marketplacePaid, inspections, hiredTransport, transportPaid]);

  const allOrderPaymentsSettled = missingPayments.length === 0;

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
    order?.buyerDecision === 'BUY' &&
    marketplacePaid &&
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

  const payInspection = (request) => {
    if (!request?.id || !request.fee) return;
    const obligation = (order?.paymentObligations || []).find(
      (o) => o.type === 'INSPECTOR' &&
        o.inspectionRequestId === request.id &&
        o.payerId === currentUserId &&
        o.status !== 'PAID' &&
        o.payment?.status !== 'PAID'
    );
    const amount = obligation?.amount != null
      ? Number(obligation.amount)
      : request.feePayer === 'SPLIT'
        ? Number(currentUserId === order.buyerId ? request.buyerFeeAmount : request.sellerFeeAmount)
        : Number(request.fee);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('No payable inspection obligation is assigned to your account.');
      return;
    }
    return run(`pay-inspection-${request.id}`, () =>
      startChapaPayment({ type: 'INSPECTOR', inspectionRequestId: request.id, orderId: order.id, amount, method: payMethod }),
      'Could not start inspector payment');
  };

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
        readyToPay: ['QUOTED', 'ACCEPTED'].includes(transportJob.status) && Boolean(acceptedQuote) && transportJob.agreedAmount != null && order?.buyerDecision === 'BUY' && marketplacePaid,
        amount: transportJob.agreedAmount,
        paid: transportPaid,
        pending: transportPending,
        processing: transportProcessing,
        note:
          hiredTransport && !['QUOTED', 'ACCEPTED'].includes(transportJob.status) && !transportPaid && !transportPending
            ? 'Transporter payment becomes available after the final BUY decision and confirmed seller payment.'
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
        const obligations = (order?.paymentObligations || []).filter(
          (o) => o.type === 'INSPECTOR' && o.inspectionRequestId === request.id
        );
        const mine = obligations.find((o) => o.payerId === currentUserId) || null;
        const open = mine?.payment || null;
        const key = `${open?.status === 'PROCESSING' ? 'check' : open ? 'resume' : 'pay'}-inspection-${request.id}`;
        const allPaid = obligations.length > 0 && obligations.every((o) => o.status === 'PAID' || o.payment?.status === 'PAID');
        return {
          id: request.id,
          label: `${request.inspector?.name || 'Inspector'} — inspection fee`,
          amount: mine?.amount ?? request.fee,
          paid: allPaid,
          pending: Boolean(open && ['PENDING', 'PROCESSING'].includes(open.status)),
          processing: open?.status === 'PROCESSING',
          note: !request.sellerConfirmedAt
            ? 'Waiting for seller confirmation before inspection payment can begin.'
            : !mine
              ? 'No inspection payment obligation is assigned to your account.'
              : request.feePayer === 'SPLIT'
                ? `Your share of the inspection fee is ${Number(mine.amount).toLocaleString()} ETB.`
                : request.status !== 'COMPLETED' ? `Inspection status: ${request.status}` : null,
          busyKey: key,
          canCheck: Boolean(open) && open.status === 'PROCESSING',
          canResume: Boolean(open) && open.status !== 'PROCESSING',
          onCheck: () => checkPayment(open?.id, key),
          onResume: () => resumePayment(open?.id, key),
          onPay: () => payInspection(request),
        };
      })
    : [];

  const transportActions = {
    selectQuote: (quoteId) => {
      if (!quoteId || !transportJob) return;
      return run(
        `quote-${quoteId}`,
        () => api.patch(`/transport/${transportJob.id}/quotes/${quoteId}/select`),
        'Could not select transport bid'
      );
    },
    releaseQuote: (quoteId, body) => {
      if (!quoteId || !transportJob) return;
      return run(
        `quote-${quoteId}`,
        () => api.patch(`/transport/${transportJob.id}/quotes/${quoteId}/withdraw`, body),
        'Could not release the transporter agreement'
      );
    },
    rejectQuote: (quoteId) => {
      if (!quoteId || !transportJob) return;
      return run(
        `quote-${quoteId}`,
        () => api.patch(`/transport/${transportJob.id}/quotes/${quoteId}/reject`),
        'Could not reject transport quote'
      );
    },
    acceptQuote: async (quoteId) => {
      if (!quoteId || !transportJob) return;
      const ok = await run(
        `quote-${quoteId}`,
        () => api.patch(`/transport/${transportJob.id}/quotes/${quoteId}/accept`),
        'Could not accept transport quote'
      );
      if (ok) scrollToId('payment-center', 150);
    },
    counterQuote: async (quoteId) => {
      if (!quoteId || !transportJob) return;
      const amount = Number(counterInputs[quoteId]);
      if (!Number.isFinite(amount) || amount <= 0) return setError('Enter a valid counter amount before sending.');
      const ok = await run(
        `quote-${quoteId}`,
        () => api.post(`/transport/${transportJob.id}/quotes/${quoteId}/counter`, { counterAmount: amount }),
        'Could not send counter-offer'
      );
      if (ok) setCounterInputs((q) => ({ ...q, [quoteId]: '' }));
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

  const decide = async (decision) => {
    if (!order || !isBuyer || !decisionRequired) return false;
    if (decision === 'BUY' && !(currentInspection?.report && currentInspection.status === 'COMPLETED')) {
      setError('Review the completed inspection report before choosing BUY.');
      return false;
    }
    if (decision === 'CANCEL' && !window.confirm('Cancel this purchase after reviewing the inspection report? This cannot be undone.')) return false;
    const ok = await run(
      `buyer-decision-${decision.toLowerCase()}`,
      () => api.patch(`/orders/${order.id}/buyer-decision`, { decision }),
      `Could not record ${decision === 'BUY' ? 'BUY' : 'cancellation'} decision`
    );
    if (ok) scrollToId(decision === 'BUY' ? 'payment-center' : 'inspection-section', 120);
    return ok;
  };

  const inspectionActions = {
    request: async (mode) => {
      if (!order?.listing) return false;
      setRequestingInspection(true);
      setError('');
      try {
        await api.post('/inspections', {
          orderId: order.id,
          listingId: order.listing.id,
          mode,
          workDetails: inspectionWorkDetails,
        });
        await reload();
        return true;
      } catch (err) {
        setError(getError(err, 'Could not request inspection'));
        return false;
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
    decide,
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
    withdrawInspectionAgreement: (requestId, { reason, note } = {}) => {
      if (!currentInspection) return;
      const accepted = leafQuotes(currentInspection.quotes).find(
        (q) => q.status === 'ACCEPTED'
      );
      if (!accepted) return;
      return run(
        `withdraw-inspection-${requestId}`,
        () =>
          api.patch(`/inspections/${requestId}/quotes/${accepted.id}/withdraw`, {
            reason,
            note: note || undefined,
          }),
        'Could not release inspection agreement'
      );
    },
    confirmSellerInspection: (requestId) =>
      run(
        `seller-confirm-${requestId}`,
        () => api.post(`/inspections/${requestId}/seller-confirm`),
        'Could not confirm the inspector'
      ),
    declineSellerInspection: (requestId) =>
      run(
        `seller-decline-${requestId}`,
        () => api.post(`/inspections/${requestId}/seller-decline`),
        'Could not decline the inspection'
      ),
    payInspection: (request) => payInspection(request),
    currentUserId,
    counterInputs,
    setCounterInputs,
    canPayInspection: Boolean(
      currentInspection &&
      currentInspection.status === 'ACCEPTED' &&
      currentInspection.fee != null &&
      currentInspection.sellerConfirmedAt != null &&
      (order?.paymentObligations || []).some(
        (o) => o.type === 'INSPECTOR' &&
          o.inspectionRequestId === currentInspection.id &&
          o.payerId === currentUserId &&
          o.status !== 'PAID' &&
          o.payment?.status !== 'PAID' &&
          !['PENDING', 'PROCESSING'].includes(o.payment?.status)
      )
    ),

    onBuy: () => decide('BUY'),
    onCancel: () => decide('CANCEL'),
    onProposePrice: (proposedPrice, reasonCode) =>
      run(
        'price-review-create',
        () => api.post(`/orders/${order.id}/price-reviews`, { proposedPrice, reasonCode }),
        'Could not submit price review'
      ),
    onRespondReview: (reviewId, action, proposedPrice, reasonCode) =>
      run(
        `price-review-${reviewId}-${action.toLowerCase()}`,
        () => api.patch(`/orders/${order.id}/price-reviews/${reviewId}/respond`, { action, ...(proposedPrice ? { proposedPrice, reasonCode } : {}) }),
        'Could not respond to price review'
      ),
    onScrollToPayment: () => scrollToId('payment-center', 150),
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
    onOpenModal: setActiveModal,
    ...inspectionActions,
  };

  const transportProps = {
    job: transportJob,
    currentUserId,
    isBuyer,
    isSeller,
    isTransporter,
    isArranger: isTransportArranger,
    canArrange: Boolean(!transportJob && order.status !== 'CANCELLED' && (isPhysicalGoods ? isBuyer : isParticipant)),
    blockedReason: transportBlockedReason,
    buyerOnly: isPhysicalGoods,
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
    loadingReport,
    loadingReportEvidence,
    allOrderPaymentsSettled,
    marketplacePaid,
    missingPayments,
    onOpenModal: setActiveModal,
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
            <ActionCenter workflow={workflow} onScroll={goToSection} onActionComplete={reload} />
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

          {isAdmin && (
            <Card eyebrow="Admin" title="Administrator view" subtitle="You are viewing this order with administrator access." />
          )}
        </div>
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────── */}

      {/* Inspection request form */}
      <Modal
        isOpen={activeModal === 'inspection-request-form'}
        onClose={() => setActiveModal(null)}
        title="Request an Inspection"
      >
        <InspectionRequestForm
          workDetails={inspectionWorkDetails}
          setWorkDetails={setInspectionWorkDetails}
          requesting={requestingInspection}
          isBuyer={isBuyer}
          onCancel={() => setActiveModal(null)}
          request={async (mode) => {
            const ok = await inspectionProps.request(mode);
            if (ok) setActiveModal(null);
          }}
        />
      </Modal>

      {/* Transport setup form */}
      <Modal
        isOpen={activeModal === 'transport-setup-form'}
        onClose={() => setActiveModal(null)}
        title="Arrange Transport"
      >
        <TransportSetup
          orderId={order.id}
          pickupDefault={order.listing?.location}
          loadDefault={[order.listing?.title, order.listing?.cropType].filter(Boolean)[0] || ''}
          destinationDefault={order.buyer?.location}
          canBuyer={isBuyer}
          canSeller={isSeller}
          buyerOnlyCompetition={isPhysicalGoods}
          onCreated={() => {
            reload();
            setActiveModal(null);
          }}
        />
      </Modal>

      {/* Inspection coordination (seller) */}
      <Modal
        isOpen={activeModal === 'inspection-coordination'}
        onClose={() => setActiveModal(null)}
        title="Inspection Coordination"
      >
        {currentInspection?.id && (
          <InspectionCoordinationSeller inspectionRequestId={currentInspection.id} />
        )}
      </Modal>

      {/* Transport coordination (seller) */}
      <Modal
        isOpen={activeModal === 'seller-transport-coordination'}
        onClose={() => setActiveModal(null)}
        title="Pickup Handoff (Seller)"
      >
        {transportJob?.id && <TransportCoordinationSeller transportJobId={transportJob.id} />}
      </Modal>

      {/* Transport coordination (transporter) */}
      <Modal
        isOpen={activeModal === 'transporter-transport-coordination'}
        onClose={() => setActiveModal(null)}
        title="Pickup Handoff (Transporter)"
      >
        {transportJob?.id && <TransportCoordinationTransporter transportJobId={transportJob.id} />}
      </Modal>

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
