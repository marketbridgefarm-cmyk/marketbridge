// Plain node test (no dependencies):  node tests/dashboardOverview.test.mjs
import assert from 'node:assert/strict';
import { attentionItems, inProgressCount, pipelineCounts, upcomingDues, weekDays } from '../src/utils/dashboardOverview.js';

const o = (id, status, extra = {}) => ({ id, status, listing: { id: `l${id}`, title: `Teff ${id}` }, ...extra });
const orders = [
  o(1, 'PENDING_PAYMENT', { viewerRole: 'BUYER', paymentDueAt: '2026-10-30T10:00:00' }),
  o(2, 'PENDING_PAYMENT', { viewerRole: 'SELLER', paymentDueAt: '2026-10-28T10:00:00' }),   // already past
  o(3, 'CONFIRMED'), o(4, 'TRANSPORT_ARRANGED'), o(5, 'IN_TRANSIT'),
  o(6, 'DELIVERED'), o(7, 'COMPLETED'), o(8, 'DISPUTED', { viewerRole: 'SELLER' }), o(9, 'CANCELLED'),
];

// pipeline: every status lands in one stage, cancelled orders in none
const counts = Object.fromEntries(pipelineCounts(orders).map((s) => [s.key, s.count]));
assert.deepEqual(counts, { awaiting: 2, preparing: 2, transit: 1, done: 2, disputed: 1 });
assert.equal(inProgressCount(orders), 5);
assert.equal(inProgressCount([]), 0);
assert.equal(inProgressCount(null), 0);

// payment deadlines: only future ones on orders still waiting for payment, nearest first
const now = new Date('2026-10-29T12:00:00');          // Thursday
assert.deepEqual(upcomingDues(orders, now).map((x) => x.id), [1]);
assert.deepEqual(upcomingDues([o(1, 'CONFIRMED', { paymentDueAt: '2026-10-30T10:00:00' })], now), []);

// week: Monday to Sunday, Thursday 29 is today, Friday 30 has the deadline
const week = weekDays(now, orders);
assert.equal(week.length, 7);
assert.deepEqual(week.map((d) => d.weekday), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
assert.deepEqual(week.map((d) => d.day), [26, 27, 28, 29, 30, 31, 1]);
assert.deepEqual(week.filter((d) => d.isToday).map((d) => d.day), [29]);
assert.deepEqual(week.filter((d) => d.hasDue).map((d) => d.day), [28, 30]);   // 28 = the past deadline of order 2, still marked in this week
// a Sunday belongs to the week that started the Monday before
assert.equal(weekDays(new Date('2026-11-01T09:00:00'), [])[0].day, 26);
assert.equal(weekDays(new Date('2026-11-02T09:00:00'), [])[0].day, 2);

// attention list
const label = (l) => l?.title || 'Listing';
const money = (v) => `${v} ETB`;
const r = attentionItems({ orders, myTurnOffers: [{ id: 'x', amount: 500, listing: { id: 'l9', title: 'Onion' } }], listingLabel: label, money });
assert.equal(r.total, 3);
assert.deepEqual(r.items.map((i) => i.id), ['offer-x', 'pay-1', 'dispute-8']);
assert.equal(r.items[0].text, 'Reply to the 500 ETB offer on Onion');
assert.equal(r.items[0].href, '/listings/l9');
assert.equal(attentionItems({ orders: [], myTurnOffers: [], listingLabel: label, money }).total, 0);
const many = attentionItems({ orders: [], myTurnOffers: Array.from({ length: 9 }, (_, i) => ({ id: i, amount: 1, listing: {} })), listingLabel: label, money });
assert.equal(many.items.length, 5);
assert.equal(many.total, 9);
console.log('ok: dashboard overview helpers');

// Admin: stages from counts the server grouped by status (the admin orders list is paginated, so it cannot be counted)
import { pipelineFromCounts, movingFrom } from '../src/utils/dashboardOverview.js';
const grouped = pipelineFromCounts({ PENDING_PAYMENT: 4, CONFIRMED: 2, TRANSPORT_ARRANGED: 1, IN_TRANSIT: 3, DELIVERED: 5, COMPLETED: 40, DISPUTED: 1, CANCELLED: 9, SOMETHING_NEW: 7 });
assert.deepEqual(Object.fromEntries(grouped.map((s) => [s.key, s.count])), { awaiting: 4, preparing: 3, transit: 3, done: 45, disputed: 1 });
assert.equal(movingFrom(grouped), 10);
assert.deepEqual(pipelineFromCounts(undefined).map((s) => s.count), [0, 0, 0, 0, 0]);
assert.equal(movingFrom(pipelineFromCounts(null)), 0);
console.log('ok: admin pipeline from server counts');
