'use strict';

// ============================================================================
// INSPECTION ARRIVAL SERVICE
// ============================================================================
//
// Flow (see also routes/inspections.js seller-confirm):
//
//   1. Seller taps "Accept inspector and fee"   -> terms locked, handshake salt
//                                                  created, arrival window opens.
//   2. Inspector checks in on site              -> GPS + timestamp + photo (+ optional
//                                                  4-digit handshake code).
//        * valid code  -> arrival CONFIRMED immediately (the seller was physically
//                         there to read it out).
//        * no code     -> PENDING_SELLER: seller gets a short window to answer.
//   3. Seller taps "Yes, they're here"          -> CONFIRMED
//      or does nothing                          -> AUTO_CONFIRMED when the window ends
//      or says it is wrong                      -> DISPUTED, goes to the admin queue
//                                                  with the GPS + photo.
//   4. Admin rules ARRIVED (arrival confirmed) or NO_SHOW (counted against the
//      inspector, bidding reopens, standing penalty applies).
//
// Confirming an arrival sets inspectorOnSiteConfirmedAt, which is exactly the
// gate the payment, start and report code already use. Nothing downstream
// changes: only HOW that timestamp is earned.
//
// Functions take `db` (a Prisma client or transaction) so they can be unit
// tested with stubs; the ones that open their own transaction need the root
// client and say so.
// ============================================================================

const logic = require('./inspectionArrivalLogic');
const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { syncOrderPaymentObligations } = require('./paymentObligationService');
const { lockOrderAndAssertNotClosed } = require('./orderStateMachine');
const { computeInspectionPaymentDueAt } = require('./inspectionLapseService');
const { computeInspectionWorkflowDueAt } = require('../utils/orderTiming');
const { closeCoordination } = require('./inspectionCoordinationService');
const { applyProviderCancellation } = require('./providerStandingService');
const { noticeInspectionWaitingUnlocked } = require('./waitingListService');
const { releaseInspectorPayoutsForRequest } = require('./payoutService');

const DISPUTE_REASONS = ['NOT_PRESENT', 'WRONG_PERSON', 'WRONG_PLACE'];
const OPEN_ARRIVAL_STATUSES = ['PENDING_SELLER', 'DISPUTED'];
const TX_OPTIONS = { maxWait: 10000, timeout: 15000 };

function fail(message, statusCode = 400, code = null, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}), ...extra });
}

// ── Reliability counters ────────────────────────────────────────────────────

async function bumpReliability(tx, inspectorId, counters) {
  if (!inspectorId) return null;
  const create = { inspectorId, ...counters };
  const update = {};
  for (const [key, value] of Object.entries(counters)) update[key] = { increment: value };
  return tx.inspectorReliability.upsert({ where: { inspectorId }, create, update });
}

const recordArrival = (tx, inspectorId, { late }) =>
  bumpReliability(tx, inspectorId, late ? { lateArrivals: 1 } : { onTimeArrivals: 1 });

const recordNoShow = (tx, inspectorId) => bumpReliability(tx, inspectorId, { noShows: 1 });

/** Report turnaround = start of the visit (or on-site confirmation) to report submitted. */
function recordReportSubmitted(tx, { inspectorId, from, to = new Date() }) {
  const start = from ? new Date(from).getTime() : null;
  const minutes = start ? Math.max(1, Math.round((new Date(to).getTime() - start) / 60000)) : 0;
  return bumpReliability(tx, inspectorId, { reportsSubmitted: 1, totalReportMinutes: minutes });
}

/** Map<inspectorId, summary>. Inspectors without history get the neutral "NEW" summary. */
async function reliabilityFor(db, inspectorIds = []) {
  const ids = [...new Set(inspectorIds.filter(Boolean))];
  const rows = ids.length
    ? await db.inspectorReliability.findMany({ where: { inspectorId: { in: ids } } })
    : [];
  const byId = new Map(rows.map((r) => [r.inspectorId, r]));
  const out = new Map();
  for (const id of ids) out.set(id, logic.reliabilitySummary(byId.get(id)));
  return out;
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadRequest(db, requestId) {
  const request = await db.inspectionRequest.findUnique({
    where: { id: requestId },
    include: {
      order: { select: { id: true, sellerId: true, buyerId: true, status: true } },
      listing: { select: { latitude: true, longitude: true, sellerId: true } },
      availability: true,
      arrival: true,
    },
  });
  if (!request) throw fail('Inspection request not found', 404);
  return request;
}

function sellerIdOf(request) {
  return request.order?.sellerId || request.listing?.sellerId || null;
}

/** An arrival row only counts if it belongs to the CURRENT inspector. */
function currentArrival(request) {
  const a = request.arrival;
  return a && a.inspectorId === request.inspectorId ? a : null;
}

function awaitingArrival(request) {
  return request.status === 'ACCEPTED'
    && Boolean(request.inspectorId)
    && Boolean(request.sellerConfirmedAt)
    && !request.inspectorOnSiteConfirmedAt;
}

// ── View (what each party may see) ──────────────────────────────────────────

async function getArrivalView(db, { requestId, user }) {
  const request = await loadRequest(db, requestId);
  const roles = user.roles || [];
  const isAdmin = roles.includes('ADMIN');
  const isSeller = sellerIdOf(request) === user.id;
  const isBuyer = request.order?.buyerId === user.id;
  const isInspector = request.inspectorId === user.id;
  const isRequester = request.requestedById === user.id;
  if (!(isAdmin || isSeller || isBuyer || isInspector || isRequester)) {
    throw fail('You do not have access to this inspection', 403);
  }

  const arrival = currentArrival(request);
  const waiting = awaitingArrival(request);
  const expired = Boolean(request.workflowDueAt && request.workflowDueAt <= new Date());
  const attempts = request.arrivalCodeFailedAttempts || 0;
  const codeLocked = attempts >= logic.config.codeMaxAttempts();

  let inspector = null;
  if (request.inspectorId) {
    const [user_, rel] = await Promise.all([
      db.user.findUnique({ where: { id: request.inspectorId }, select: { id: true, name: true, rating: true } }),
      reliabilityFor(db, [request.inspectorId]),
    ]);
    inspector = user_ ? { ...user_, reliability: rel.get(request.inspectorId) } : null;
  }

  let handshakeCode = null;
  if (isSeller && waiting && request.arrivalCodeSalt && !codeLocked && !(arrival && OPEN_ARRIVAL_STATUSES.includes(arrival.status))) {
    handshakeCode = logic.deriveArrivalCode({
      requestId: request.id,
      inspectorId: request.inspectorId,
      salt: request.arrivalCodeSalt,
    });
  }

  const pending = arrival?.status === 'PENDING_SELLER';
  const canCheckIn = isInspector && waiting && !expired
    && !(arrival && ['PENDING_SELLER', 'DISPUTED', 'RESOLVED_NO_SHOW'].includes(arrival.status));

  const fullDetail = isAdmin || isInspector;

  return {
    inspectionRequestId: request.id,
    status: request.status,
    fee: request.lockedFee ?? request.fee,
    feePayer: request.lockedFeePayer || request.feePayer,
    inspector,
    scheduled: logic.scheduledWindow(request.availability || []),
    sellerAccepted: Boolean(request.sellerConfirmedAt),
    onSiteConfirmedAt: request.inspectorOnSiteConfirmedAt || null,
    arrivalDueAt: waiting ? request.workflowDueAt : null,
    awaitingArrival: waiting,
    codeLocked: waiting ? codeLocked : false,
    codeAttemptsLeft: waiting ? Math.max(0, logic.config.codeMaxAttempts() - attempts) : null,
    handshakeCode,
    reportAcceptedAt: request.reportAcceptedAt || null,
    arrival: arrival
      ? {
          id: arrival.id,
          status: arrival.status,
          checkedInAt: arrival.checkedInAt,
          codeVerified: arrival.codeVerified,
          late: arrival.late,
          flagged: arrival.flagged,
          distanceKm: arrival.distanceKm != null ? Math.round(arrival.distanceKm * 10) / 10 : null,
          photoCount: (arrival.photoKeys || []).length,
          disputeWindowEndsAt: arrival.disputeWindowEndsAt,
          disputeReason: arrival.disputeReason,
          disputedAt: arrival.disputedAt,
          resolvedAt: arrival.resolvedAt,
          ...(fullDetail ? { latitude: arrival.latitude, longitude: arrival.longitude, accuracyMeters: arrival.accuracyMeters } : {}),
        }
      : null,
    viewerCan: {
      checkIn: canCheckIn,
      confirm: isSeller && pending,
      dispute: isSeller && pending,
    },
  };
}

// ── Confirming an arrival (shared by every path) ────────────────────────────

/**
 * Sets inspectorOnSiteConfirmedAt and opens the fee-payment clock. Returns
 * false (changing nothing) if the request moved on in the meantime.
 */
async function applyArrivalConfirmed(tx, { request, arrival, actorId = null, via, now = new Date() }) {
  const updated = await tx.inspectionRequest.updateMany({
    where: {
      id: request.id,
      status: 'ACCEPTED',
      inspectorId: request.inspectorId,
      sellerConfirmedAt: { not: null },
      inspectorOnSiteConfirmedAt: null,
    },
    data: {
      inspectorOnSiteConfirmedAt: now,
      inspectorOnSiteConfirmedBy: actorId,
      workflowDueAt: computeInspectionPaymentDueAt(),
    },
  });
  if (!updated.count) return false;

  if (request.orderId) await syncOrderPaymentObligations(tx, request.orderId);
  await recordArrival(tx, request.inspectorId, { late: Boolean(arrival?.late) });

  if (request.orderId) {
    await recordOrderEvent(tx, {
      orderId: request.orderId,
      actorId,
      type: 'INSPECTION_INSPECTOR_ARRIVED',
      metadata: { inspectionRequestId: request.id, via, late: Boolean(arrival?.late) },
    });
  }
  await recordAuditEvent(tx, {
    actorId,
    action: 'INSPECTION_ARRIVAL_CONFIRMED',
    resourceType: 'InspectionRequest',
    resourceId: request.id,
    metadata: { inspectorId: request.inspectorId, via, arrivalId: arrival?.id || null, late: Boolean(arrival?.late) },
  });
  return true;
}

// ── Inspector check-in ──────────────────────────────────────────────────────

/**
 * Needs the root Prisma client (opens its own transaction).
 * Returns { ok: true, confirmed, arrival } or { ok: false, code, ... } for a
 * wrong handshake code (the failed attempt is persisted, so no throw).
 */
async function checkIn(prisma, { requestId, user, latitude, longitude, accuracyMeters = null, photoKeys = [], code = null, now = new Date() }) {
  if (!logic.validCoordinate(latitude, longitude)) {
    throw fail('A valid GPS location is required to check in. Turn on location and try again.', 400, 'GPS_REQUIRED');
  }
  if (!Array.isArray(photoKeys) || !photoKeys.length) {
    throw fail('Take a photo of the goods or the site to check in.', 400, 'PHOTO_REQUIRED');
  }
  if (code != null && code !== '' && !/^\d{4}$/.test(String(code))) {
    throw fail('The handshake code is 4 digits.', 400, 'CODE_FORMAT');
  }

  return prisma.$transaction(async (tx) => {
    const request = await loadRequest(tx, requestId);
    if (request.orderId) {
      await lockOrderAndAssertNotClosed(tx, request.orderId, 'the inspector cannot check in until that is resolved');
    }
    if (request.inspectorId !== user.id) throw fail('Only the assigned inspector can check in', 403);
    if (!awaitingArrival(request)) {
      throw fail('Check-in is only available after the seller has accepted the inspector and fee, and before arrival is confirmed.', 409, 'NOT_AWAITING_ARRIVAL');
    }
    if (request.workflowDueAt && request.workflowDueAt <= now) {
      throw fail('The arrival window has expired.', 409, 'ARRIVAL_WINDOW_EXPIRED');
    }

    const existing = currentArrival(request);
    if (existing && ['PENDING_SELLER', 'DISPUTED'].includes(existing.status)) {
      throw fail('You have already checked in. Waiting for the seller or admin.', 409, 'ALREADY_CHECKED_IN');
    }
    if (existing && existing.status === 'RESOLVED_NO_SHOW') {
      throw fail('This arrival was ruled a no-show.', 409, 'RULED_NO_SHOW');
    }

    // Handshake code (optional, strongest proof).
    let codeVerified = false;
    if (code != null && code !== '') {
      const max = logic.config.codeMaxAttempts();
      if ((request.arrivalCodeFailedAttempts || 0) >= max) {
        throw fail('Too many wrong codes. Check in without a code and the seller will be asked to confirm.', 423, 'CODE_LOCKED');
      }
      if (request.arrivalCodeSalt) {
        const expected = logic.deriveArrivalCode({ requestId: request.id, inspectorId: request.inspectorId, salt: request.arrivalCodeSalt });
        if (logic.codesMatch(expected, String(code))) {
          codeVerified = true;
        } else {
          await tx.inspectionRequest.updateMany({
            where: { id: request.id, arrivalCodeFailedAttempts: { lt: max } },
            data: { arrivalCodeFailedAttempts: { increment: 1 } },
          });
          const used = (request.arrivalCodeFailedAttempts || 0) + 1;
          await recordAuditEvent(tx, {
            actorId: user.id,
            action: 'INSPECTION_ARRIVAL_CODE_FAILED',
            resourceType: 'InspectionRequest',
            resourceId: request.id,
            metadata: { attempts: used },
          });
          return { ok: false, code: 'WRONG_CODE', attemptsLeft: Math.max(0, max - used) };
        }
      }
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    let distanceKm = null;
    let flagged = false;
    if (logic.validCoordinate(request.listing?.latitude, request.listing?.longitude)) {
      distanceKm = logic.haversineKm(lat, lng, request.listing.latitude, request.listing.longitude);
      flagged = distanceKm > logic.config.maxDistanceKm();
    }
    const late = logic.isLateArrival({
      checkedInAt: now,
      window: logic.scheduledWindow(request.availability || []),
      acceptedAt: request.sellerConfirmedAt,
    });

    const data = {
      inspectorId: user.id,
      status: codeVerified ? 'CONFIRMED' : 'PENDING_SELLER',
      checkedInAt: now,
      latitude: lat,
      longitude: lng,
      accuracyMeters: Number.isFinite(Number(accuracyMeters)) ? Number(accuracyMeters) : null,
      photoKeys,
      codeVerified,
      distanceKm,
      flagged,
      late,
      disputeWindowEndsAt: codeVerified ? null : new Date(now.getTime() + logic.config.disputeWindowHours() * 3600 * 1000),
      sellerRespondedAt: codeVerified ? now : null,
      sellerRespondedById: null,
      disputeReason: null,
      disputedAt: null,
      resolvedAt: null,
      resolvedById: null,
      adminNote: null,
    };
    const arrival = await tx.inspectionArrival.upsert({
      where: { inspectionRequestId: request.id },
      create: { inspectionRequestId: request.id, ...data },
      update: data,
    });

    await recordAuditEvent(tx, {
      actorId: user.id,
      action: 'INSPECTION_ARRIVAL_CHECKED_IN',
      resourceType: 'InspectionRequest',
      resourceId: request.id,
      metadata: { arrivalId: arrival.id, codeVerified, distanceKm, flagged, late, photos: photoKeys.length },
    });

    if (codeVerified) {
      await applyArrivalConfirmed(tx, { request, arrival, actorId: user.id, via: 'CODE', now });
      return { ok: true, confirmed: true, arrival };
    }

    if (request.orderId) {
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: user.id,
        type: 'INSPECTION_ARRIVAL_CHECKED_IN',
        metadata: {
          inspectionRequestId: request.id,
          windowEndsAt: arrival.disputeWindowEndsAt.toISOString(),
          flagged,
        },
      });
    }
    return { ok: true, confirmed: false, arrival };
  }, TX_OPTIONS);
}

// ── Seller response ─────────────────────────────────────────────────────────

async function sellerConfirm(prisma, { requestId, user, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const request = await loadRequest(tx, requestId);
    if (request.orderId) await lockOrderAndAssertNotClosed(tx, request.orderId, 'the arrival cannot be confirmed until that is resolved');
    if (sellerIdOf(request) !== user.id) throw fail('Only the seller can confirm the arrival', 403);
    const arrival = currentArrival(request);
    if (!arrival || arrival.status !== 'PENDING_SELLER') throw fail('There is no arrival waiting for your answer.', 409, 'NO_PENDING_ARRIVAL');

    const claimed = await tx.inspectionArrival.updateMany({
      where: { id: arrival.id, status: 'PENDING_SELLER' },
      data: { status: 'CONFIRMED', sellerRespondedAt: now, sellerRespondedById: user.id },
    });
    if (!claimed.count) throw fail('This arrival was already answered.', 409, 'ALREADY_ANSWERED');

    const applied = await applyArrivalConfirmed(tx, { request, arrival, actorId: user.id, via: 'SELLER', now });
    if (!applied) throw fail('The inspection changed. Refresh and try again.', 409);
    return { confirmed: true };
  }, TX_OPTIONS);
}

async function sellerDispute(prisma, { requestId, user, reason, now = new Date() }) {
  if (!DISPUTE_REASONS.includes(reason)) throw fail('Choose one of the listed reasons.', 400, 'INVALID_REASON');
  return prisma.$transaction(async (tx) => {
    const request = await loadRequest(tx, requestId);
    if (request.orderId) await lockOrderAndAssertNotClosed(tx, request.orderId, 'the arrival cannot be disputed until that is resolved');
    if (sellerIdOf(request) !== user.id) throw fail('Only the seller can dispute the arrival', 403);
    const arrival = currentArrival(request);
    if (!arrival || arrival.status !== 'PENDING_SELLER') throw fail('There is no arrival waiting for your answer.', 409, 'NO_PENDING_ARRIVAL');

    const claimed = await tx.inspectionArrival.updateMany({
      where: { id: arrival.id, status: 'PENDING_SELLER' },
      data: { status: 'DISPUTED', disputeReason: reason, disputedAt: now, sellerRespondedAt: now, sellerRespondedById: user.id },
    });
    if (!claimed.count) throw fail('This arrival was already answered.', 409, 'ALREADY_ANSWERED');

    if (request.orderId) {
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: user.id,
        type: 'INSPECTION_ARRIVAL_DISPUTED',
        metadata: { inspectionRequestId: request.id, reason },
      });
    }
    await recordAuditEvent(tx, {
      actorId: user.id,
      action: 'INSPECTION_ARRIVAL_DISPUTED',
      resourceType: 'InspectionRequest',
      resourceId: request.id,
      metadata: { arrivalId: arrival.id, reason, inspectorId: request.inspectorId },
    });
    return { disputed: true };
  }, TX_OPTIONS);
}

// ── Auto-confirm (maintenance) ──────────────────────────────────────────────

/** Seller did not answer in time: confirm rather than block the inspection. */
async function autoConfirmDueArrivals(prisma, now = new Date()) {
  const due = await prisma.inspectionArrival.findMany({
    where: { status: 'PENDING_SELLER', disputeWindowEndsAt: { lte: now } },
    select: { id: true, inspectionRequestId: true },
    take: 200,
  });
  let confirmed = 0;
  for (const row of due) {
    try {
      const ok = await prisma.$transaction(async (tx) => {
        const request = await loadRequest(tx, row.inspectionRequestId);
        const arrival = currentArrival(request);
        if (!arrival || arrival.id !== row.id || arrival.status !== 'PENDING_SELLER') return false;
        const claimed = await tx.inspectionArrival.updateMany({
          where: { id: arrival.id, status: 'PENDING_SELLER' },
          data: { status: 'AUTO_CONFIRMED' },
        });
        if (!claimed.count) return false;
        return applyArrivalConfirmed(tx, { request, arrival, actorId: null, via: 'AUTO', now });
      }, TX_OPTIONS);
      if (ok) confirmed += 1;
    } catch (error) {
      // One bad row must not stop the sweep; it is retried next cycle.
      if (typeof console !== 'undefined') console.error('autoConfirmDueArrivals failed', row.id, error.message);
    }
  }
  return { confirmed };
}

// ── No-show: reopen bidding ─────────────────────────────────────────────────

/**
 * Return the request to the bidding pool WITHOUT cancelling the buyer's order
 * (nobody who is not the inspector is at fault). Mirrors the accepted-quote
 * provider release in routes/inspectionQuotes.js.
 */
async function reopenAfterNoShow(tx, request, { actorId = null, reason }) {
  const inspectorId = request.inspectorId;
  await tx.inspectionQuote.updateMany({
    where: { inspectionRequestId: request.id, inspectorId, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } },
    data: { status: 'WITHDRAWN' },
  });
  await tx.inspectionRequest.update({
    where: { id: request.id },
    data: {
      inspectorId: null,
      fee: null,
      feeTermsLockedAt: null,
      lockedFee: null,
      lockedFeePayer: null,
      lockedBuyerFeeAmount: null,
      lockedSellerFeeAmount: null,
      buyerFeeAmount: null,
      sellerFeeAmount: null,
      sellerConfirmedAt: null,
      inspectorOnSiteConfirmedAt: null,
      inspectorOnSiteConfirmedBy: null,
      arrivalCodeSalt: null,
      arrivalCodeFailedAttempts: 0,
      status: 'REQUESTED',
      workflowDueAt: computeInspectionWorkflowDueAt(),
      coordinationDueAt: null,
      startDueAt: null,
    },
  });
  await tx.paymentObligation.updateMany({
    where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'OPEN' },
    data: { status: 'CANCELLED' },
  });
  await closeCoordination(tx, request.id, 'INSPECTOR_NO_SHOW');
  await recordNoShow(tx, inspectorId);

  const standing = await applyProviderCancellation(tx, { userId: inspectorId, orderId: request.orderId, reason: 'NO_SHOW' });

  if (request.orderId) {
    await recordOrderEvent(tx, {
      orderId: request.orderId,
      actorId,
      type: 'INSPECTION_NO_SHOW',
      metadata: { inspectionRequestId: request.id, inspectorId, reason },
    });
  }
  await recordAuditEvent(tx, {
    actorId,
    action: 'INSPECTION_INSPECTOR_NO_SHOW',
    resourceType: 'InspectionRequest',
    resourceId: request.id,
    metadata: { inspectorId, reason, standing: standing?.action || null },
  });
  return standing;
}

/**
 * Maintenance: the inspector never checked in before the arrival window ended.
 * Skipped while a check-in is waiting on the seller or on an admin.
 */
async function lapseMissedArrivals(prisma, now = new Date()) {
  const candidates = await prisma.inspectionRequest.findMany({
    where: {
      status: 'ACCEPTED',
      sellerConfirmedAt: { not: null },
      inspectorOnSiteConfirmedAt: null,
      inspectorId: { not: null },
      workflowDueAt: { lte: now },
    },
    select: { id: true, listingId: true },
    take: 100,
  });
  let lapsed = 0;
  for (const c of candidates) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        const request = await loadRequest(tx, c.id);
        if (!awaitingArrival(request) || !request.workflowDueAt || request.workflowDueAt > now) return false;
        const arrival = currentArrival(request);
        if (arrival && OPEN_ARRIVAL_STATUSES.includes(arrival.status)) return false; // being decided
        await reopenAfterNoShow(tx, request, { actorId: null, reason: 'ARRIVAL_WINDOW_EXPIRED' });
        return true;
      }, TX_OPTIONS);
      if (done) {
        lapsed += 1;
        await noticeInspectionWaitingUnlocked(prisma, { inspectionRequestId: c.id, reason: 'INSPECTOR_NO_SHOW' }).catch(() => null);
      }
    } catch (error) {
      if (typeof console !== 'undefined') console.error('lapseMissedArrivals failed', c.id, error.message);
    }
  }
  return { lapsed };
}

// ── Admin ───────────────────────────────────────────────────────────────────

async function adminListArrivals(db, { status = 'DISPUTED', limit = 50 } = {}) {
  const rows = await db.inspectionArrival.findMany({
    where: status ? { status } : {},
    orderBy: { updatedAt: 'desc' },
    take: Math.min(200, Math.max(1, limit)),
    include: {
      inspector: { select: { id: true, name: true, rating: true } },
      inspectionRequest: {
        select: {
          id: true, orderId: true, status: true, lockedFee: true, fee: true,
          listing: { select: { id: true, title: true, location: true, latitude: true, longitude: true } },
          order: { select: { id: true, seller: { select: { id: true, name: true } }, buyer: { select: { id: true, name: true } } } },
        },
      },
    },
  });
  const rel = await reliabilityFor(db, rows.map((r) => r.inspectorId));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    inspectionRequestId: r.inspectionRequestId,
    orderId: r.inspectionRequest?.orderId || null,
    inspector: { ...r.inspector, reliability: rel.get(r.inspectorId) },
    seller: r.inspectionRequest?.order?.seller || null,
    buyer: r.inspectionRequest?.order?.buyer || null,
    listing: r.inspectionRequest?.listing || null,
    checkedInAt: r.checkedInAt,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracyMeters: r.accuracyMeters,
    distanceKm: r.distanceKm,
    flagged: r.flagged,
    late: r.late,
    codeVerified: r.codeVerified,
    photoCount: (r.photoKeys || []).length,
    disputeReason: r.disputeReason,
    disputedAt: r.disputedAt,
    resolvedAt: r.resolvedAt,
    adminNote: r.adminNote,
  }));
}

async function adminResolve(prisma, { arrivalId, adminId, outcome, note = null, now = new Date() }) {
  if (!['ARRIVED', 'NO_SHOW'].includes(outcome)) throw fail('Outcome must be ARRIVED or NO_SHOW', 400, 'INVALID_OUTCOME');
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 1000) || null : null;

  const result = await prisma.$transaction(async (tx) => {
    const arrival = await tx.inspectionArrival.findUnique({ where: { id: arrivalId } });
    if (!arrival) throw fail('Arrival record not found', 404);
    if (arrival.status !== 'DISPUTED') throw fail('Only a disputed arrival can be resolved.', 409, 'NOT_DISPUTED');
    const request = await loadRequest(tx, arrival.inspectionRequestId);
    if (request.inspectorId !== arrival.inspectorId) {
      throw fail('This inspection has since been reassigned.', 409, 'REASSIGNED');
    }
    if (request.orderId) await lockOrderAndAssertNotClosed(tx, request.orderId, 'the arrival cannot be resolved until that is resolved');

    const claimed = await tx.inspectionArrival.updateMany({
      where: { id: arrival.id, status: 'DISPUTED' },
      data: {
        status: outcome === 'ARRIVED' ? 'RESOLVED_ARRIVED' : 'RESOLVED_NO_SHOW',
        resolvedAt: now,
        resolvedById: adminId,
        adminNote: cleanNote,
      },
    });
    if (!claimed.count) throw fail('This arrival was already resolved.', 409);

    if (request.orderId) {
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: adminId,
        type: 'INSPECTION_ARRIVAL_RESOLVED',
        metadata: { inspectionRequestId: request.id, outcome },
      });
    }
    await recordAuditEvent(tx, {
      actorId: adminId,
      action: 'INSPECTION_ARRIVAL_RESOLVED',
      resourceType: 'InspectionArrival',
      resourceId: arrival.id,
      metadata: { inspectionRequestId: request.id, outcome, note: cleanNote },
    });

    if (outcome === 'ARRIVED') {
      const applied = await applyArrivalConfirmed(tx, { request, arrival, actorId: adminId, via: 'ADMIN', now });
      if (!applied) throw fail('The inspection changed. Refresh and try again.', 409);
      return { outcome, requestId: request.id };
    }
    await reopenAfterNoShow(tx, request, { actorId: adminId, reason: 'ADMIN_RULED_NO_SHOW' });
    return { outcome, requestId: request.id };
  }, TX_OPTIONS);

  if (result.outcome === 'NO_SHOW') {
    await noticeInspectionWaitingUnlocked(prisma, { inspectionRequestId: result.requestId, reason: 'INSPECTOR_NO_SHOW' }).catch(() => null);
  }
  return result;
}

// ── Report acceptance (instant fee release) ─────────────────────────────────

async function acceptReport(prisma, { requestId, user, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.inspectionRequest.findUnique({
      where: { id: requestId },
      include: { report: { select: { id: true } }, order: { select: { id: true, buyerId: true, sellerId: true } } },
    });
    if (!request) throw fail('Inspection request not found', 404);
    const isBuyer = request.order?.buyerId === user.id;
    const isRequester = request.requestedById === user.id;
    if (!isBuyer && !isRequester) throw fail('Only the buyer who requested the inspection can accept the report', 403);
    if (request.status !== 'COMPLETED' || !request.report) throw fail('There is no submitted report to accept yet.', 409, 'NO_REPORT');
    if (request.reportAcceptedAt) throw fail('The report was already accepted.', 409, 'ALREADY_ACCEPTED');

    const claimed = await tx.inspectionRequest.updateMany({
      where: { id: request.id, reportAcceptedAt: null },
      data: { reportAcceptedAt: now, reportAcceptedById: user.id },
    });
    if (!claimed.count) throw fail('The report was already accepted.', 409, 'ALREADY_ACCEPTED');

    const payouts = await releaseInspectorPayoutsForRequest(tx, { inspectionRequestId: request.id, now });

    if (request.orderId) {
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: user.id,
        type: 'INSPECTION_REPORT_ACCEPTED',
        metadata: { inspectionRequestId: request.id, inspectorId: request.inspectorId },
      });
    }
    await recordAuditEvent(tx, {
      actorId: user.id,
      action: 'INSPECTION_REPORT_ACCEPTED',
      resourceType: 'InspectionRequest',
      resourceId: request.id,
      metadata: { payoutsReleased: payouts.released },
    });
    return { accepted: true, payoutsReleased: payouts.released };
  }, TX_OPTIONS);
}

// ── Deadline reminders (12h and 2h) ─────────────────────────────────────────

function reminderStage(msLeft) {
  const [far, near] = logic.config.reminderHours();
  const hours = msLeft / 3600000;
  if (hours <= 0) return null;
  if (hours <= near) return { stage: `${near}H`, hoursLeft: near };
  if (hours <= far) return { stage: `${far}H`, hoursLeft: far };
  return null;
}

function reminderPhase(request, arrival) {
  if (request.status !== 'ACCEPTED' || !request.inspectorId) return null;
  if (!request.sellerConfirmedAt) return { phase: 'SELLER_CONFIRMATION', audience: 'SELLER' };
  if (!request.inspectorOnSiteConfirmedAt) {
    if (arrival && OPEN_ARRIVAL_STATUSES.includes(arrival.status)) return null; // answer pending; not a deadline surprise
    return { phase: 'INSPECTOR_ARRIVAL', audience: 'INSPECTOR_AND_SELLER' };
  }
  return { phase: 'PAYMENT', audience: 'PAYERS' };
}

/**
 * Notify before an inspection lapse so it is a last resort, not a surprise.
 * One notice per (request, deadline, stage); a moved deadline gets fresh ones.
 */
async function sendDeadlineReminders(prisma, now = new Date()) {
  const horizon = new Date(now.getTime() + Math.max(...logic.config.reminderHours()) * 3600 * 1000);
  const rows = await prisma.inspectionRequest.findMany({
    where: { status: 'ACCEPTED', orderId: { not: null }, workflowDueAt: { gt: now, lte: horizon } },
    include: { arrival: true },
    take: 500,
  });
  let sent = 0;
  for (const request of rows) {
    const phase = reminderPhase(request, currentArrival(request));
    const stage = reminderStage(request.workflowDueAt.getTime() - now.getTime());
    if (!phase || !stage) continue;
    if (phase.phase === 'PAYMENT') {
      const unpaid = await prisma.paymentObligation.count({
        where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'OPEN' },
      });
      if (!unpaid) continue;
    }
    const dedupe = `${request.id}:${request.workflowDueAt.toISOString()}:${stage.stage}`;
    const exists = await prisma.orderEvent.findFirst({
      where: { orderId: request.orderId, type: 'INSPECTION_DEADLINE_REMINDER', metadata: { path: ['dedupe'], equals: dedupe } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.$transaction(async (tx) => {
      await recordOrderEvent(tx, {
        orderId: request.orderId,
        actorId: null,
        type: 'INSPECTION_DEADLINE_REMINDER',
        metadata: {
          inspectionRequestId: request.id,
          inspectorId: request.inspectorId,
          phase: phase.phase,
          audience: phase.audience,
          stage: stage.stage,
          hoursLeft: stage.hoursLeft,
          deadline: request.workflowDueAt.toISOString(),
          dedupe,
        },
      });
    }, TX_OPTIONS);
    sent += 1;
  }
  return { sent };
}

module.exports = {
  DISPUTE_REASONS,
  // reliability
  recordArrival,
  recordNoShow,
  recordReportSubmitted,
  reliabilityFor,
  // arrival
  getArrivalView,
  checkIn,
  sellerConfirm,
  sellerDispute,
  autoConfirmDueArrivals,
  lapseMissedArrivals,
  adminListArrivals,
  adminResolve,
  // report + reminders
  acceptReport,
  sendDeadlineReminders,
  // exported for tests
  reminderStage,
  reminderPhase,
  awaitingArrival,
};
