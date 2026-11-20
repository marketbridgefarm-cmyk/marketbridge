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

// Same stages, from counts the server already grouped by status ({ PENDING_PAYMENT: 3, … }). The admin's orders list is
// paginated, so counting that list would only cover the newest orders.
export function pipelineFromCounts(byStatus) {
  const counts = byStatus || {};
  return PIPELINE.map((s) => ({ ...s, count: s.statuses.reduce((sum, st) => sum + (Number(counts[st]) || 0), 0) }));
}

// Orders that are still moving (waiting for payment, being prepared or on the road).
export function inProgressCount(orders) {
  return movingFrom(pipelineCounts(orders));
}
export function movingFrom(stages) {
  return (stages || []).filter((s) => ['awaiting', 'preparing', 'transit'].includes(s.key))
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
    items.push({ id: `offer-${o.id}`, tone: 'accent', text: `Reply to the ${money(o.amount)} offer on ${listingLabel(o.listing)}`, href: `/listings/${o.listing?.id}`, cta: 'Reply' });
  }
  for (const o of orders || []) {
    if (statusOf(o) === 'PENDING_PAYMENT' && o.viewerRole === 'BUYER') {
      items.push({ id: `pay-${o.id}`, tone: 'wait', text: `Pay for ${listingLabel(o.listing)}`, href: `/orders/${o.id}`, cta: 'Pay now' });
    }
    if (statusOf(o) === 'DISPUTED') {
      items.push({ id: `dispute-${o.id}`, tone: 'danger', text: `Dispute open on ${listingLabel(o.listing)}`, href: `/orders/${o.id}`, cta: 'Review' });
    }
  }
  return { items: items.slice(0, limit), total: items.length };
}

// Orders created per day for the last `days` days, oldest first (today is the last entry). Drives the dot chart.
export function dailyActivity(orders, now = new Date(), days = 30) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const counts = new Map();
  for (const o of orders || []) {
    if (!o?.createdAt) continue;
    const k = dayKey(new Date(o.createdAt));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { key: dayKey(d), day: d.getDate(), count: counts.get(dayKey(d)) || 0, isToday: i === days - 1 };
  });
}

// Orders created in the last `days` days versus the `days` before them, as a whole-number percent (null with no earlier data).
export function activityChange(orders, now = new Date(), days = 7) {
  const dayMs = 86400000;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  let recent = 0;
  let before = 0;
  for (const o of orders || []) {
    if (!o?.createdAt) continue;
    const age = (end - new Date(o.createdAt).getTime()) / dayMs;
    if (age > 0 && age <= days) recent += 1;
    else if (age > days && age <= days * 2) before += 1;
  }
  return { recent, before, percent: before === 0 ? null : Math.round(((recent - before) / before) * 100) };
}

// Where an order is on its journey, for the progress strip on each row. Cancelled orders have no journey.
export const JOURNEY = ['PENDING_PAYMENT', 'CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'];
const JOURNEY_COPY = {
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'wait' },
  CONFIRMED: { label: 'Preparing', tone: 'info' },
  TRANSPORT_ARRANGED: { label: 'Transport set', tone: 'info' },
  IN_TRANSIT: { label: 'On the road', tone: 'accent' },
  DELIVERED: { label: 'Delivered', tone: 'ok' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  DISPUTED: { label: 'Disputed', tone: 'danger' },
};
export function orderProgress(order) {
  const status = statusOf(order);
  const copy = JOURNEY_COPY[status];
  if (!copy) return null;
  const idx = JOURNEY.indexOf(status);
  return { label: copy.label, tone: copy.tone, step: idx < 0 ? 0 : idx + 1, total: JOURNEY.length };
}

// The orders worth showing in the list: still moving or in dispute first (newest activity first), then the rest.
export function liveOrders(orders, limit = 5) {
  const rank = (o) => (['PENDING_PAYMENT', 'CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DISPUTED'].includes(statusOf(o)) ? 0 : 1);
  return (orders || [])
    .filter((o) => statusOf(o) !== 'CANCELLED')
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)   // stable: callers pass newest-first
    .slice(0, limit)
    .map((x) => x.o);
}
