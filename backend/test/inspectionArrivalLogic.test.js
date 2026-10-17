'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ARRIVAL_CODE_SECRET = 'test-secret';
const logic = require('../src/services/inspectionArrivalLogic');

test('arrival code is 4 digits, stable, and bound to request/inspector/salt', () => {
  const base = { requestId: 'r1', inspectorId: 'i1', salt: 'abc' };
  const code = logic.deriveArrivalCode(base);
  assert.match(code, /^\d{4}$/);
  assert.equal(logic.deriveArrivalCode(base), code);
  // A different inspector or salt gives a different derivation input; across a
  // sample, codes must not all collapse to one value.
  const sample = new Set();
  for (let n = 0; n < 40; n += 1) sample.add(logic.deriveArrivalCode({ ...base, salt: `s${n}` }));
  assert.ok(sample.size > 20);
  assert.equal(logic.deriveArrivalCode({ requestId: 'r1', inspectorId: 'i1' }), null);
});

test('arrival code derivation fails closed without a secret', () => {
  const prevA = process.env.ARRIVAL_CODE_SECRET;
  const prevJ = process.env.JWT_SECRET;
  delete process.env.ARRIVAL_CODE_SECRET;
  delete process.env.JWT_SECRET;
  assert.throws(() => logic.deriveArrivalCode({ requestId: 'r', inspectorId: 'i', salt: 's' }), /ARRIVAL_CODE_SECRET/);
  process.env.ARRIVAL_CODE_SECRET = prevA;
  if (prevJ !== undefined) process.env.JWT_SECRET = prevJ;
});

test('codesMatch only accepts exact 4-digit strings', () => {
  assert.equal(logic.codesMatch('0042', '0042'), true);
  assert.equal(logic.codesMatch('0042', '0043'), false);
  assert.equal(logic.codesMatch('0042', '42'), false);
  assert.equal(logic.codesMatch('0042', 42), false);
  assert.equal(logic.codesMatch('0042', '00420'), false);
  assert.equal(logic.codesMatch(null, '0042'), false);
});

test('haversine: Addis Ababa to Adama is roughly 75 km; identical points are 0', () => {
  const d = logic.haversineKm(9.03, 38.74, 8.54, 39.27);
  assert.ok(d > 70 && d < 85, `distance was ${d}`);
  assert.equal(logic.haversineKm(9, 38, 9, 38), 0);
});

test('validCoordinate rejects junk and the 0,0 default', () => {
  assert.equal(logic.validCoordinate(9.03, 38.74), true);
  assert.equal(logic.validCoordinate(0, 0), false);
  assert.equal(logic.validCoordinate('abc', 1), false);
  assert.equal(logic.validCoordinate(91, 10), false);
  assert.equal(logic.validCoordinate(10, 181), false);
});

test('scheduledWindow returns the earliest overlapping slot only', () => {
  const availability = [
    { party: 'SELLER', date: '2026-11-03', startTime: '08:00', endTime: '12:00' },
    { party: 'SELLER', date: '2026-11-05', startTime: '09:00', endTime: '17:00' },
    { party: 'INSPECTOR', date: '2026-11-03', startTime: '13:00', endTime: '16:00' }, // no overlap
    { party: 'INSPECTOR', date: '2026-11-05', startTime: '14:00', endTime: '18:00' },
  ];
  assert.deepEqual(logic.scheduledWindow(availability), { date: '2026-11-05', startTime: '14:00', endTime: '17:00' });
  assert.equal(logic.scheduledWindow([]), null);
  assert.equal(logic.scheduledWindow(availability.slice(0, 1)), null);
});

test('lateness uses the agreed window plus grace, in Ethiopian local time', () => {
  const window = { date: '2026-11-05', startTime: '14:00', endTime: '17:00' };
  // window ends 17:00 +03:00 = 14:00Z; default grace 60 min.
  assert.equal(logic.isLateArrival({ checkedInAt: '2026-11-05T14:30:00Z', window }), false);
  assert.equal(logic.isLateArrival({ checkedInAt: '2026-11-05T15:30:00Z', window }), true);
});

test('lateness falls back to hours-after-acceptance when no window was agreed', () => {
  const acceptedAt = '2026-11-01T08:00:00Z';
  assert.equal(logic.isLateArrival({ checkedInAt: '2026-11-02T07:00:00Z', window: null, acceptedAt }), false);
  assert.equal(logic.isLateArrival({ checkedInAt: '2026-11-02T09:00:00Z', window: null, acceptedAt }), true);
  assert.equal(logic.isLateArrival({ checkedInAt: '2026-11-02T09:00:00Z', window: null }), false);
});

test('reliability: new inspector starts at 90 and history moves the score sensibly', () => {
  assert.equal(logic.reliabilityScore({}), 90);
  const oneNoShow = logic.reliabilityScore({ noShows: 1 });
  const manyGood = logic.reliabilityScore({ onTimeArrivals: 20, reportsSubmitted: 20, totalReportMinutes: 20 * 60 * 10 });
  const manyBad = logic.reliabilityScore({ noShows: 5, lateArrivals: 3, onTimeArrivals: 1 });
  assert.ok(oneNoShow < 90 && oneNoShow > 60, `oneNoShow=${oneNoShow}`);
  assert.ok(manyGood > 95, `manyGood=${manyGood}`);
  assert.ok(manyBad < 60, `manyBad=${manyBad}`);
  assert.equal(logic.reliabilitySummary({ noShows: 5, lateArrivals: 3, onTimeArrivals: 1 }).tier, 'NEEDS_IMPROVEMENT');
  // slow reports cost points
  const slow = logic.reliabilityScore({ onTimeArrivals: 10, reportsSubmitted: 10, totalReportMinutes: 10 * 60 * 72 });
  const fast = logic.reliabilityScore({ onTimeArrivals: 10, reportsSubmitted: 10, totalReportMinutes: 10 * 60 * 12 });
  assert.ok(slow < fast);
});

test('reliability tiers', () => {
  assert.equal(logic.reliabilitySummary({}).tier, 'NEW');
  assert.equal(logic.reliabilitySummary({ onTimeArrivals: 30, reportsSubmitted: 30, totalReportMinutes: 30 * 60 * 6 }).tier, 'HIGHLY_RELIABLE');
  assert.equal(logic.reliabilitySummary({ noShows: 4, onTimeArrivals: 2 }).tier, 'NEEDS_IMPROVEMENT');
  assert.equal(logic.reliabilitySummary({ noShows: 1, reportsSubmitted: 2 }).avgReportHours, null);
});

test('compareBids ranks by reliability, then fee, then age', () => {
  const bids = [
    { id: 'cheap-flaky', amount: 300, reliability: { score: 60 }, createdAt: '2026-01-01' },
    { id: 'pricey-solid', amount: 500, reliability: { score: 95 }, createdAt: '2026-01-02' },
    { id: 'cheap-solid', amount: 400, reliability: { score: 95 }, createdAt: '2026-01-03' },
  ].sort(logic.compareBids);
  assert.deepEqual(bids.map((b) => b.id), ['cheap-solid', 'pricey-solid', 'cheap-flaky']);
});
