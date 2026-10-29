'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dayKey, weekWindow, bucketWeek } = require('../src/utils/adminWeek');

test('days follow Ethiopian local time (UTC+3), not UTC', () => {
  assert.equal(dayKey('2026-10-28T23:30:00Z', 3), '2026-10-29');   // 02:30 on Thursday locally
  assert.equal(dayKey('2026-10-28T20:59:59Z', 3), '2026-10-28');
  assert.equal(dayKey('2026-10-28T21:00:00Z', 3), '2026-10-29');
});

test('the week runs Monday to Sunday and starts at local midnight', () => {
  const w = weekWindow(new Date('2026-10-29T12:00:00Z'), 3);       // a Thursday
  assert.deepEqual(w.days, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(w.start.toISOString(), '2026-10-25T21:00:00.000Z');   // Monday 00:00 at UTC+3
  // Sunday evening still belongs to the week that began the Monday before; Monday 00:30 local starts a new one
  assert.equal(weekWindow(new Date('2026-11-01T17:00:00Z'), 3).days[0], '2026-10-26');
  assert.equal(weekWindow(new Date('2026-11-01T21:30:00Z'), 3).days[0], '2026-11-02');
});

test('orders and paid volume are counted on the right day and anything outside the week is ignored', () => {
  const r = bucketWeek({
    now: new Date('2026-10-29T12:00:00Z'),
    orders: [{ createdAt: '2026-10-26T05:00:00Z' }, { createdAt: '2026-10-26T06:00:00Z' }, { createdAt: '2026-10-28T22:00:00Z' }, { createdAt: '2026-10-20T10:00:00Z' }, { createdAt: '2026-11-03T10:00:00Z' }],
    payments: [{ updatedAt: '2026-10-29T08:00:00Z', amount: '1500.50' }, { updatedAt: '2026-10-29T09:00:00Z', amount: 500 }, { updatedAt: '2026-10-19T09:00:00Z', amount: 99999 }],
    offsetHours: 3,
  });
  assert.equal(r.weekStart, '2026-10-26');
  assert.equal(r.today, '2026-10-29');
  assert.deepEqual(r.days.map((d) => d.orders), [2, 0, 0, 1, 0, 0, 0]);      // 22:00 UTC on the 28th is already Thursday locally
  assert.deepEqual(r.days.map((d) => d.paidVolume), [0, 0, 0, 2000.5, 0, 0, 0]);
  assert.equal(r.days.length, 7);
});

test('an empty week gives seven empty days', () => {
  const r = bucketWeek({ now: new Date('2026-10-29T12:00:00Z'), offsetHours: 3 });
  assert.deepEqual(r.days.map((d) => d.orders + d.paidVolume), [0, 0, 0, 0, 0, 0, 0]);
});
