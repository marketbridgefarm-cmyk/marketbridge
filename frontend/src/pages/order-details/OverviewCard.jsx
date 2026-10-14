import React from 'react';

import {
  Avatar,
  Button,
  Card,
  Fact,
  Facts,
  PartyBadge,
  Section,
  YouTag,
} from './OrderDetailPrimitives.jsx';
import { money, shortId } from './orderDetailUtils.js';

// ============================================================================
// ORDER OVERVIEW CARD
// ============================================================================
//
// Extracted from OrderDetail.jsx. Contains:
//   • OverviewCard  — the top-of-page summary card
//   • OrderProgress — internal step indicator used only by OverviewCard
//
// Same props, same behavior, same rendering. Pure relocation.
// ============================================================================

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

export default function OverviewCard({ order, title, flags, canCancel, busy, onCancel, inspectionApplies }) {
  const { isBuyer, isSeller, marketplacePaid, marketplacePending, transportJob } = flags;
  const role = isBuyer ? 'Buying' : isSeller ? 'Selling' : 'Order';
  const showBuyer = isSeller;
  const other = showBuyer ? order.buyer : order.seller;
  const delivered = ['DELIVERED', 'COMPLETED'].includes(order.status) || transportJob?.status === 'DELIVERED';

  const inspectionDone = order.inspectionRequests?.some(r => r.status === 'COMPLETED' && r.report) || false;
  const decisionDone = order.buyerDecision === 'BUY';

  const transportDone = Boolean(transportJob && ['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'].includes(transportJob.status));
  const loadedDone = transportJob?.method === 'HIRE_TRANSPORTER'
    ? Boolean(transportJob?.buyerLoadingConfirmedAt)
    : Boolean(transportJob?.sellerPickupConfirmedAt);

  const steps = [
    { label: 'Ordered', done: true },
    { label: 'Inspected', done: inspectionApplies ? inspectionDone : true },
    { label: 'Decided', done: decisionDone },
    { label: 'Transport', done: transportDone },
    { label: 'Loaded', done: loadedDone },
    { label: 'Paid', done: marketplacePaid },
    { label: 'Delivered', done: delivered },
    { label: 'Completed', done: order.status === 'COMPLETED' },
  ];

  const currentStep = steps.find((s) => !s.done) || steps[steps.length - 1];
  const currentTone =
    currentStep.label === 'Completed' ? 'good'
    : currentStep.label === 'Delivered' ? 'info'
    : currentStep.label === 'Paid' ? 'wait'
    : currentStep.label === 'Inspected' ? 'info'
    : currentStep.label === 'Decided' ? 'wait'
    : currentStep.label === 'Transport' ? 'info'
    : currentStep.label === 'Loaded' ? 'wait'
    : 'neutral';

  const headerStatus =
    order.status === 'CANCELLED'
      ? { label: 'Cancelled', tone: 'bad' }
      : { label: currentStep.label, tone: currentTone };

  const partyRole = showBuyer ? 'Buyer' : 'Seller';

  const created = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString()
    : '—';

  return (
    <Card
      className="od-card-overview"
      eyebrow={role}
      eyebrowClass={isSeller ? 'is-selling' : ''}
      title={title}
      side={other?.name ? <PartyBadge role={partyRole} name={other.name} /> : <Avatar name={other?.name} />}
    >
      <Section
        title="Order status"
        meta={<span className={`od-header-status is-${headerStatus.tone}`}>{headerStatus.label}</span>}
      >
        <OrderProgress steps={steps} />
      </Section>

      <Section title="Order Details">
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

      <div className="od-order-meta">
        <span className="od-order-time">Created {created}</span>
        <span className="od-order-code">ORD {shortId(order.id).toUpperCase()}</span>
      </div>

      {canCancel && (
        <Button className="btn btn-outline btn-block" disabled={busy === 'cancel'} onClick={onCancel} busy={busy === 'cancel'} busyText="Cancelling…">
          Cancel order
        </Button>
      )}
    </Card>
  );
}
