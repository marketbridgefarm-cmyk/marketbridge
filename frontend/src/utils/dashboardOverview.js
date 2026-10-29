// Pure helpers behind the dashboard overview cards (no React, so they can be tested with plain node).

// The order pipeline, left to right. Cancelled orders are not part of it.
export const PIPELINE = [
  { key: 'awaiting', label: 'Awaiting payment', statuses: ['PENDING_PAYMENT'], tone: 'wait' },
  { key: 'preparing', label: 'Preparing', statuses: ['CONFIRMED', 'TRANSPORT_ARRANGED'], tone: 'info' },
  { key: 'transit', label: 'In transit', statuses: ['IN_TRANSIT'], tone: 'accent' },
  { key: 'done', label: 'Delivered', statuses: ['DELIVERED', 'COMPLETED'], tone: 'ok' },
  { key: 'disputed', label: 'Disputed', statuses: ['DISPUTED'], tone: 'danger' },
];

const statusOf = (o) => String(o?.status || '').toUpperCase();

export function pipelineCounts(orders) {
  const stages = PIPELINE.map((s) => ({ ...s, count: 0 }));
  for (const o of orders || []) {
    const stage = stages.find((s) => s.statuses.includes(statusOf(o)));
    if (stage) stage.count += 1;
  }
  return stages;
}

// Orders that are still moving (waiting for payment, being prepared or on the road).
export function inProgressCount(orders) {
  return pipelineCounts(orders).filter((s) => ['awaiting', 'preparing', 'transit'].includes(s.key))
    .reduce((sum, s) => sum + s.count, 0);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// Payment deadlines still ahead, nearest first. paymentDueAt exists only on orders waiting for payment.
export function upcomingDues(orders, now = new Date(), limit = 3) {
  return (orders || [])
    .filter((o) => statusOf(o) === 'PENDING_PAYMENT' && o.paymentDueAt && new Date(o.paymentDueAt) >= now)
    .sort((a, b) => new Date(a.paymentDueAt) - new Date(b.paymentDueAt))
    .slice(0, limit);
}

// The current week, Monday to Sunday, with today marked and a flag on days that have a payment deadline.
export function weekDays(now = new Date(), orders = []) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const dueDays = new Set(
    (orders || []).filter((o) => statusOf(o) === 'PENDING_PAYMENT' && o.paymentDueAt).map((o) => dayKey(new Date(o.paymentDueAt)))
  );
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return {
      key: dayKey(d),
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      day: d.getDate(),
      isToday: dayKey(d) === dayKey(now),
      hasDue: dueDays.has(dayKey(d)),
    };
  });
}

// "Needs your attention": offers waiting for the user's reply, orders the user must pay, open disputes.
export function attentionItems({ orders, myTurnOffers, listingLabel, money, limit = 5 }) {
  const items = [];
  for (const o of myTurnOffers || []) {
    items.push({ id: `offer-${o.id}`, tone: 'accent', text: `Reply to the ${money(o.amount)} offer on ${listingLabel(o.listing)}`, href: `/listings/${o.listing?.id}` });
  }
  for (const o of orders || []) {
    if (statusOf(o) === 'PENDING_PAYMENT' && o.viewerRole === 'BUYER') {
      items.push({ id: `pay-${o.id}`, tone: 'wait', text: `Pay for ${listingLabel(o.listing)}`, href: `/orders/${o.id}` });
    }
    if (statusOf(o) === 'DISPUTED') {
      items.push({ id: `dispute-${o.id}`, tone: 'danger', text: `Dispute open on ${listingLabel(o.listing)}`, href: `/orders/${o.id}` });
    }
  }
  return { items: items.slice(0, limit), total: items.length };
}
