'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.ARRIVAL_CODE_SECRET = 'test-secret';

// ── Stub the service's collaborators (same pattern as inspection.lapse.test.js) ──
const log = [];
const seenDedupe = new Set();
const NOW = new Date('2026-11-05T10:00:00Z');
const stubs = {
  '../utils/audit': { recordAuditEvent: async (_tx, e) => log.push(['audit', e.action]) },
  './orderEventService': { recordOrderEvent: async (_tx, e) => { if (e.metadata && e.metadata.dedupe) seenDedupe.add(e.metadata.dedupe); log.push(['event', e.type, e.metadata]); } },
  './paymentObligationService': { syncOrderPaymentObligations: async (_tx, id) => log.push(['syncObligations', id]) },
  './orderStateMachine': { lockOrderAndAssertNotClosed: async () => {} },
  './inspectionLapseService': { computeInspectionPaymentDueAt: () => new Date(NOW.getTime() + 24 * 3600 * 1000) },
  '../utils/orderTiming': { computeInspectionWorkflowDueAt: () => new Date(NOW.getTime() + 48 * 3600 * 1000) },
  './inspectionCoordinationService': { closeCoordination: async (_tx, id, why) => log.push(['closeCoordination', id, why]) },
  './providerStandingService': { applyProviderCancellation: async (_tx, a) => { log.push(['standing', a.userId, a.reason]); return { action: 'RATING_HIT' }; } },
  './waitingListService': { noticeInspectionWaitingUnlocked: async () => log.push(['noticeUnlocked']) },
  './payoutService': { releaseInspectorPayoutsForRequest: async (_tx, a) => { log.push(['releasePayouts', a.inspectionRequestId]); return { released: 1 }; } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && /inspectionArrivalService\.js$/.test(parent.filename) && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};
const svc = require('../src/services/inspectionArrivalService');
const logic = require('../src/services/inspectionArrivalLogic');
Module._load = originalLoad;

// ── Tiny in-memory database ─────────────────────────────────────────────────
function matches(where = {}, row) {
  return Object.entries(where).every(([key, cond]) => {
    const v = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) return cond.not === null ? v != null : v !== cond.not;
      if ('lt' in cond) return v < cond.lt;
      if ('lte' in cond) return v <= cond.lte;
      if ('gt' in cond) return v > cond.gt;
      if ('in' in cond) return cond.in.includes(v);
      return true; // nested relation filters are not needed here
    }
    return cond === null ? v == null : v === cond;
  });
}

function applyData(row, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment;
    else row[k] = v;
  }
}

function baseRequest(over = {}) {
  return {
    id: 'r1', orderId: 'o1', status: 'ACCEPTED', inspectorId: 'insp1', requestedById: 'buyer1',
    sellerConfirmedAt: new Date('2026-11-04T10:00:00Z'), inspectorOnSiteConfirmedAt: null,
    workflowDueAt: new Date('2026-11-07T10:00:00Z'), arrivalCodeSalt: 'salt', arrivalCodeFailedAttempts: 0,
    reportAcceptedAt: null, lockedFee: 500, fee: 500, feePayer: 'BUYER',
    order: { id: 'o1', sellerId: 'seller1', buyerId: 'buyer1', status: 'PENDING' },
    listing: { latitude: 9.03, longitude: 38.74, sellerId: 'seller1' },
    availability: [], report: null,
    ...over,
  };
}

function makeDb({ request = baseRequest(), arrival = null } = {}) {
  const state = { request, arrival, reliability: {}, quotesWithdrawn: 0, obligationsCancelled: 0 };
  const db = {
    state,
    $transaction: async (fn) => fn(db),
    inspectionRequest: {
      findUnique: async () => ({ ...state.request, arrival: state.arrival }),
      findMany: async ({ where }) => (matches(where, state.request) ? [{ ...state.request, arrival: state.arrival }] : []),
      updateMany: async ({ where, data }) => {
        if (!matches(where, state.request)) return { count: 0 };
        applyData(state.request, data);
        return { count: 1 };
      },
      update: async ({ data }) => { applyData(state.request, data); return state.request; },
    },
    inspectionArrival: {
      upsert: async ({ create, update }) => {
        state.arrival = state.arrival ? { ...state.arrival, ...update } : { id: 'a1', ...create };
        return state.arrival;
      },
      updateMany: async ({ where, data }) => {
        if (!state.arrival || !matches(where, state.arrival)) return { count: 0 };
        applyData(state.arrival, data);
        return { count: 1 };
      },
      findUnique: async ({ where }) => (state.arrival && (where.id === state.arrival.id) ? state.arrival : null),
      findMany: async ({ where }) => (state.arrival && matches(where, state.arrival) ? [state.arrival] : []),
    },
    inspectorReliability: {
      upsert: async ({ where, create, update }) => {
        const cur = state.reliability[where.inspectorId];
        if (!cur) state.reliability[where.inspectorId] = { ...create };
        else applyData(cur, update);
        return state.reliability[where.inspectorId];
      },
      findMany: async ({ where }) => where.inspectorId.in.map((id) => state.reliability[id] && { inspectorId: id, ...state.reliability[id] }).filter(Boolean),
    },
    inspectionQuote: { updateMany: async () => { state.quotesWithdrawn += 1; return { count: 1 }; } },
    paymentObligation: { updateMany: async () => { state.obligationsCancelled += 1; return { count: 1 }; }, count: async () => 1 },
    user: { findUnique: async ({ where }) => ({ id: where.id, name: 'Abebe', rating: 4.5 }) },
    orderEvent: { findFirst: async () => null },
  };
  return db;
}

const inspector = { id: 'insp1', roles: ['INSPECTOR'] };
const seller = { id: 'seller1', roles: ['SELLER'] };
const buyer = { id: 'buyer1', roles: ['BUYER'] };
const admin = { id: 'admin1', roles: ['ADMIN'] };
const PHOTO = ['evidence/inspection-arrival/r1/p.jpg'];
const GPS = { latitude: 9.031, longitude: 38.741 };
const goodCode = () => logic.deriveArrivalCode({ requestId: 'r1', inspectorId: 'insp1', salt: 'salt' });

// ── Check-in ────────────────────────────────────────────────────────────────

test('check-in without a code waits for the seller with a dispute window; arrival is NOT confirmed', async () => {
  log.length = 0;
  const db = makeDb();
  const out = await svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.confirmed, false);
  assert.equal(db.state.arrival.status, 'PENDING_SELLER');
  assert.equal(db.state.request.inspectorOnSiteConfirmedAt, null);
  assert.equal(db.state.arrival.disputeWindowEndsAt.getTime(), NOW.getTime() + 2 * 3600 * 1000);
  assert.ok(log.some((l) => l[0] === 'event' && l[1] === 'INSPECTION_ARRIVAL_CHECKED_IN'));
  assert.ok(!log.some((l) => l[1] === 'INSPECTION_INSPECTOR_ARRIVED'));
});

test('check-in with the right handshake code confirms instantly and opens the fee-payment clock', async () => {
  log.length = 0;
  const db = makeDb();
  const out = await svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, code: goodCode(), now: NOW });
  assert.equal(out.confirmed, true);
  assert.equal(db.state.arrival.status, 'CONFIRMED');
  assert.equal(db.state.arrival.codeVerified, true);
  assert.equal(db.state.request.inspectorOnSiteConfirmedAt.getTime(), NOW.getTime());
  assert.equal(db.state.request.workflowDueAt.getTime(), NOW.getTime() + 24 * 3600 * 1000);
  assert.ok(log.some((l) => l[0] === 'syncObligations'));
  const arrivedEvent = log.find((l) => l[1] === 'INSPECTION_INSPECTOR_ARRIVED');
  assert.equal(arrivedEvent[2].via, 'CODE');
  assert.equal(db.state.reliability.insp1.onTimeArrivals, 1);
});

test('a wrong code is counted, nothing is confirmed, and the code locks after the limit', async () => {
  const db = makeDb();
  let out = await svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, code: '0000' === goodCode() ? '1111' : '0000', now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'WRONG_CODE');
  assert.equal(out.attemptsLeft, 4);
  assert.equal(db.state.arrival, null);
  assert.equal(db.state.request.arrivalCodeFailedAttempts, 1);

  db.state.request.arrivalCodeFailedAttempts = 5;
  await assert.rejects(
    svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, code: goodCode(), now: NOW }),
    (e) => e.statusCode === 423 && e.code === 'CODE_LOCKED',
  );
  // …but checking in without a code still works, so a locked code never blocks the inspector.
  const fallback = await svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, now: NOW });
  assert.equal(fallback.ok, true);
  assert.equal(db.state.arrival.status, 'PENDING_SELLER');
});

test('check-in guards: photo, GPS, role, state, window, duplicate', async () => {
  const run = (over, args = {}) => svc.checkIn(makeDb(over), { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, now: NOW, ...args });
  await assert.rejects(run({}, { photoKeys: [] }), (e) => e.code === 'PHOTO_REQUIRED');
  await assert.rejects(run({}, { latitude: 0, longitude: 0 }), (e) => e.code === 'GPS_REQUIRED');
  await assert.rejects(run({}, { code: '12' }), (e) => e.code === 'CODE_FORMAT');
  await assert.rejects(run({}, { user: { id: 'someone', roles: ['INSPECTOR'] } }), (e) => e.statusCode === 403);
  await assert.rejects(run({ request: baseRequest({ sellerConfirmedAt: null }) }), (e) => e.code === 'NOT_AWAITING_ARRIVAL');
  await assert.rejects(run({ request: baseRequest({ inspectorOnSiteConfirmedAt: NOW }) }), (e) => e.code === 'NOT_AWAITING_ARRIVAL');
  await assert.rejects(run({ request: baseRequest({ workflowDueAt: new Date(NOW.getTime() - 1000) }) }), (e) => e.code === 'ARRIVAL_WINDOW_EXPIRED');
  await assert.rejects(
    run({ arrival: { id: 'a1', inspectorId: 'insp1', status: 'PENDING_SELLER' } }),
    (e) => e.code === 'ALREADY_CHECKED_IN',
  );
});

test('flags: distance and lateness are recorded', async () => {
  const db = makeDb({ request: baseRequest({ workflowDueAt: new Date('2026-11-20T00:00:00Z'), sellerConfirmedAt: new Date('2026-11-01T08:00:00Z') }) });
  await svc.checkIn(db, { requestId: 'r1', user: inspector, latitude: 8.54, longitude: 39.27, photoKeys: PHOTO, now: NOW });
  assert.equal(db.state.arrival.flagged, true);          // ~75 km from the listing
  assert.ok(db.state.arrival.distanceKm > 70);
  assert.equal(db.state.arrival.late, true);             // > 24h after acceptance, no agreed window
});

// ── Seller response ─────────────────────────────────────────────────────────

const pendingArrival = (over = {}) => ({ id: 'a1', inspectorId: 'insp1', status: 'PENDING_SELLER', late: false, disputeWindowEndsAt: new Date(NOW.getTime() + 3600 * 1000), ...over });

test('seller "Yes, they are here" confirms the arrival', async () => {
  log.length = 0;
  const db = makeDb({ arrival: pendingArrival() });
  await svc.sellerConfirm(db, { requestId: 'r1', user: seller, now: NOW });
  assert.equal(db.state.arrival.status, 'CONFIRMED');
  assert.equal(db.state.request.inspectorOnSiteConfirmedAt.getTime(), NOW.getTime());
  assert.equal(log.find((l) => l[1] === 'INSPECTION_INSPECTOR_ARRIVED')[2].via, 'SELLER');
});

test('only the seller can confirm or dispute, and only a pending arrival', async () => {
  const db = makeDb({ arrival: pendingArrival() });
  await assert.rejects(svc.sellerConfirm(db, { requestId: 'r1', user: buyer }), (e) => e.statusCode === 403);
  await assert.rejects(svc.sellerDispute(db, { requestId: 'r1', user: buyer, reason: 'NOT_PRESENT' }), (e) => e.statusCode === 403);
  await assert.rejects(svc.sellerDispute(db, { requestId: 'r1', user: seller, reason: 'because I said so' }), (e) => e.code === 'INVALID_REASON');
  await assert.rejects(svc.sellerConfirm(makeDb({ arrival: null }), { requestId: 'r1', user: seller }), (e) => e.code === 'NO_PENDING_ARRIVAL');
  await assert.rejects(svc.sellerConfirm(makeDb({ arrival: pendingArrival({ status: 'DISPUTED' }) }), { requestId: 'r1', user: seller }), (e) => e.code === 'NO_PENDING_ARRIVAL');
});

test('an arrival of a previous inspector is ignored after reassignment', async () => {
  const db = makeDb({ arrival: pendingArrival({ inspectorId: 'old-inspector' }) });
  await assert.rejects(svc.sellerConfirm(db, { requestId: 'r1', user: seller }), (e) => e.code === 'NO_PENDING_ARRIVAL');
  // …and the new inspector can check in over the stale row.
  const out = await svc.checkIn(db, { requestId: 'r1', user: inspector, ...GPS, photoKeys: PHOTO, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(db.state.arrival.inspectorId, 'insp1');
});

test('seller dispute sends it to the admin queue and does not confirm', async () => {
  log.length = 0;
  const db = makeDb({ arrival: pendingArrival() });
  await svc.sellerDispute(db, { requestId: 'r1', user: seller, reason: 'NOT_PRESENT', now: NOW });
  assert.equal(db.state.arrival.status, 'DISPUTED');
  assert.equal(db.state.arrival.disputeReason, 'NOT_PRESENT');
  assert.equal(db.state.request.inspectorOnSiteConfirmedAt, null);
  assert.ok(log.some((l) => l[1] === 'INSPECTION_ARRIVAL_DISPUTED'));
});

// ── Auto-confirm ────────────────────────────────────────────────────────────

test('auto-confirm: seller silence confirms after the window (never blocks)', async () => {
  log.length = 0;
  const db = makeDb({ arrival: pendingArrival({ disputeWindowEndsAt: new Date(NOW.getTime() - 1000) }) });
  const out = await svc.autoConfirmDueArrivals(db, NOW);
  assert.equal(out.confirmed, 1);
  assert.equal(db.state.arrival.status, 'AUTO_CONFIRMED');
  assert.ok(db.state.request.inspectorOnSiteConfirmedAt);
  assert.equal(log.find((l) => l[1] === 'INSPECTION_INSPECTOR_ARRIVED')[2].via, 'AUTO');
});

test('auto-confirm leaves not-yet-due and disputed arrivals alone', async () => {
  const notDue = makeDb({ arrival: pendingArrival() });
  assert.equal((await svc.autoConfirmDueArrivals(notDue, NOW)).confirmed, 0);
  const disputed = makeDb({ arrival: pendingArrival({ status: 'DISPUTED', disputeWindowEndsAt: new Date(NOW.getTime() - 1000) }) });
  assert.equal((await svc.autoConfirmDueArrivals(disputed, NOW)).confirmed, 0);
  assert.equal(notDue.state.request.inspectorOnSiteConfirmedAt, null);
});

// ── Admin ruling ────────────────────────────────────────────────────────────

test('admin rules ARRIVED: arrival confirmed, payment path opens', async () => {
  const db = makeDb({ arrival: pendingArrival({ status: 'DISPUTED' }) });
  await svc.adminResolve(db, { arrivalId: 'a1', adminId: 'admin1', outcome: 'ARRIVED', now: NOW });
  assert.equal(db.state.arrival.status, 'RESOLVED_ARRIVED');
  assert.ok(db.state.request.inspectorOnSiteConfirmedAt);
});

test('admin rules NO_SHOW: bidding reopens, order untouched, no-show counted, penalty applied', async () => {
  log.length = 0;
  const db = makeDb({ arrival: pendingArrival({ status: 'DISPUTED' }) });
  await svc.adminResolve(db, { arrivalId: 'a1', adminId: 'admin1', outcome: 'NO_SHOW', note: 'GPS 75 km away', now: NOW });
  const r = db.state.request;
  assert.equal(db.state.arrival.status, 'RESOLVED_NO_SHOW');
  assert.equal(r.status, 'REQUESTED');
  assert.equal(r.inspectorId, null);
  assert.equal(r.sellerConfirmedAt, null);
  assert.equal(r.arrivalCodeSalt, null);
  assert.equal(r.fee, null);
  assert.equal(r.workflowDueAt.getTime(), NOW.getTime() + 48 * 3600 * 1000);
  assert.equal(db.state.quotesWithdrawn, 1);
  assert.equal(db.state.obligationsCancelled, 1);
  assert.equal(db.state.reliability.insp1.noShows, 1);
  assert.ok(log.some((l) => l[0] === 'standing' && l[1] === 'insp1' && l[2] === 'NO_SHOW'));
  assert.ok(log.some((l) => l[0] === 'closeCoordination'));
  assert.ok(log.some((l) => l[0] === 'noticeUnlocked'));
  // the buyer's order is never cancelled by a no-show
  assert.ok(!log.some((l) => /CANCEL/.test(String(l[1]))));
});

test('admin can only resolve a disputed arrival with a valid outcome', async () => {
  await assert.rejects(svc.adminResolve(makeDb({ arrival: pendingArrival() }), { arrivalId: 'a1', adminId: 'admin1', outcome: 'ARRIVED' }), (e) => e.code === 'NOT_DISPUTED');
  await assert.rejects(svc.adminResolve(makeDb({ arrival: pendingArrival({ status: 'DISPUTED' }) }), { arrivalId: 'a1', adminId: 'admin1', outcome: 'MAYBE' }), (e) => e.code === 'INVALID_OUTCOME');
});

// ── Missed arrival window ───────────────────────────────────────────────────

test('inspector who never checks in before the window ends is a no-show; bidding reopens', async () => {
  const db = makeDb({ request: baseRequest({ workflowDueAt: new Date(NOW.getTime() - 1000) }) });
  const out = await svc.lapseMissedArrivals(db, NOW);
  assert.equal(out.lapsed, 1);
  assert.equal(db.state.request.status, 'REQUESTED');
  assert.equal(db.state.reliability.insp1.noShows, 1);
});

test('the window is NOT lapsed while a check-in is waiting on the seller or admin', async () => {
  for (const status of ['PENDING_SELLER', 'DISPUTED']) {
    const db = makeDb({ request: baseRequest({ workflowDueAt: new Date(NOW.getTime() - 1000) }), arrival: pendingArrival({ status }) });
    assert.equal((await svc.lapseMissedArrivals(db, NOW)).lapsed, 0, status);
    assert.equal(db.state.request.status, 'ACCEPTED');
  }
  const future = makeDb();
  assert.equal((await svc.lapseMissedArrivals(future, NOW)).lapsed, 0);
});

// ── Viewing ─────────────────────────────────────────────────────────────────

test('only the seller sees the handshake code; the inspector and buyer never do', async () => {
  const db = makeDb();
  const sellerView = await svc.getArrivalView(db, { requestId: 'r1', user: seller });
  assert.equal(sellerView.handshakeCode, goodCode());
  assert.equal((await svc.getArrivalView(db, { requestId: 'r1', user: inspector })).handshakeCode, null);
  assert.equal((await svc.getArrivalView(db, { requestId: 'r1', user: buyer })).handshakeCode, null);
  assert.equal((await svc.getArrivalView(db, { requestId: 'r1', user: admin })).handshakeCode, null);
  await assert.rejects(svc.getArrivalView(db, { requestId: 'r1', user: { id: 'stranger', roles: ['BUYER'] } }), (e) => e.statusCode === 403);
});

test('the code is hidden once locked or once arrival is already decided', async () => {
  const locked = makeDb({ request: baseRequest({ arrivalCodeFailedAttempts: 5 }) });
  const v = await svc.getArrivalView(locked, { requestId: 'r1', user: seller });
  assert.equal(v.handshakeCode, null);
  assert.equal(v.codeLocked, true);
  const pending = makeDb({ arrival: pendingArrival() });
  assert.equal((await svc.getArrivalView(pending, { requestId: 'r1', user: seller })).handshakeCode, null);
});

test('view: viewerCan and coordinates are role-scoped', async () => {
  const db = makeDb({ arrival: pendingArrival({ latitude: 9.1, longitude: 38.9 }) });
  const s = await svc.getArrivalView(db, { requestId: 'r1', user: seller });
  assert.equal(s.viewerCan.confirm, true);
  assert.equal(s.viewerCan.checkIn, false);
  assert.equal(s.arrival.latitude, undefined);           // seller does not get raw coordinates
  const a = await svc.getArrivalView(db, { requestId: 'r1', user: admin });
  assert.equal(a.arrival.latitude, 9.1);
  const fresh = await svc.getArrivalView(makeDb(), { requestId: 'r1', user: inspector });
  assert.equal(fresh.viewerCan.checkIn, true);
});

// ── Report acceptance ───────────────────────────────────────────────────────

test('buyer accepts the report: fee is released early; guards apply', async () => {
  log.length = 0;
  const done = baseRequest({ status: 'COMPLETED', report: { id: 'rep1' } });
  const db = makeDb({ request: done });
  const out = await svc.acceptReport(db, { requestId: 'r1', user: buyer, now: NOW });
  assert.equal(out.accepted, true);
  assert.equal(db.state.request.reportAcceptedAt.getTime(), NOW.getTime());
  assert.ok(log.some((l) => l[0] === 'releasePayouts'));
  await assert.rejects(svc.acceptReport(db, { requestId: 'r1', user: buyer }), (e) => e.code === 'ALREADY_ACCEPTED');
  await assert.rejects(svc.acceptReport(makeDb({ request: done }), { requestId: 'r1', user: seller }), (e) => e.statusCode === 403);
  await assert.rejects(svc.acceptReport(makeDb({ request: baseRequest() }), { requestId: 'r1', user: buyer }), (e) => e.code === 'NO_REPORT');
});

// ── Reliability + reminders ─────────────────────────────────────────────────

test('report turnaround is recorded in minutes', async () => {
  const db = makeDb();
  await svc.recordReportSubmitted(db, { inspectorId: 'insp1', from: new Date(NOW.getTime() - 90 * 60000), to: NOW });
  assert.equal(db.state.reliability.insp1.reportsSubmitted, 1);
  assert.equal(db.state.reliability.insp1.totalReportMinutes, 90);
});

test('reminder stages: 12h then 2h, nothing outside the horizon or after the deadline', () => {
  const H = 3600 * 1000;
  assert.equal(svc.reminderStage(13 * H), null);
  assert.deepEqual(svc.reminderStage(11 * H), { stage: '12H', hoursLeft: 12 });
  assert.deepEqual(svc.reminderStage(2.5 * H), { stage: '12H', hoursLeft: 12 });
  assert.deepEqual(svc.reminderStage(1.5 * H), { stage: '2H', hoursLeft: 2 });
  assert.equal(svc.reminderStage(-1), null);
});

test('reminder phase tells the right people the right thing', () => {
  const base = baseRequest();
  assert.deepEqual(svc.reminderPhase({ ...base, sellerConfirmedAt: null }, null), { phase: 'SELLER_CONFIRMATION', audience: 'SELLER' });
  assert.deepEqual(svc.reminderPhase(base, null), { phase: 'INSPECTOR_ARRIVAL', audience: 'INSPECTOR_AND_SELLER' });
  assert.equal(svc.reminderPhase(base, { status: 'PENDING_SELLER' }), null);
  assert.deepEqual(svc.reminderPhase({ ...base, inspectorOnSiteConfirmedAt: NOW }, null), { phase: 'PAYMENT', audience: 'PAYERS' });
  assert.equal(svc.reminderPhase({ ...base, status: 'COMPLETED' }, null), null);
});

test('sendDeadlineReminders sends one notice per stage and deduplicates', async () => {
  log.length = 0;
  seenDedupe.clear();
  const due = new Date(NOW.getTime() + 11 * 3600 * 1000);
  const db = makeDb({ request: baseRequest({ workflowDueAt: due }) });
  db.inspectionRequest.findMany = async () => [{ ...db.state.request, arrival: null }];
  db.orderEvent.findFirst = async ({ where }) => (seenDedupe.has(where.metadata.equals) ? { id: 'x' } : null);

  assert.equal((await svc.sendDeadlineReminders(db, NOW)).sent, 1);
  assert.equal((await svc.sendDeadlineReminders(db, NOW)).sent, 0);              // same stage, same deadline
  const later = new Date(due.getTime() - 90 * 60000);                             // now inside the 2h stage
  assert.equal((await svc.sendDeadlineReminders(db, later)).sent, 1);

  const reminders = log.filter((l) => l[1] === 'INSPECTION_DEADLINE_REMINDER');
  assert.deepEqual(reminders.map((r) => r[2].stage), ['12H', '2H']);
  assert.equal(reminders[0][2].phase, 'INSPECTOR_ARRIVAL');
  assert.equal(reminders[0][2].audience, 'INSPECTOR_AND_SELLER');
});

test('reliability map gives neutral NEW summaries to inspectors without history', async () => {
  const db = makeDb();
  db.state.reliability.insp1 = { noShows: 2, lateArrivals: 0, onTimeArrivals: 1, reportsSubmitted: 0, totalReportMinutes: 0 };
  const map = await svc.reliabilityFor(db, ['insp1', 'fresh']);
  assert.equal(map.get('fresh').tier, 'NEW');
  assert.equal(map.get('fresh').score, 90);
  assert.equal(map.get('insp1').noShows, 2);
  assert.ok(map.get('insp1').score < 90);
});
