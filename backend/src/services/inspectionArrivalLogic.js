'use strict';

// ============================================================================
// INSPECTION ARRIVAL — PURE LOGIC (no database, no network)
// ============================================================================
//
// Everything here is deterministic so it can be unit tested without Prisma:
//   * the 4-digit handshake code the seller reads to the inspector
//   * distance between the check-in GPS fix and the listing
//   * the agreed visit window and whether an arrival was late
//   * the inspector reliability score used to rank bids
// ============================================================================

const crypto = require('crypto');

// Ethiopia has a single fixed offset (no daylight saving).
const LOCAL_OFFSET = '+03:00';

function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

const config = {
  // Seller's window to dispute a check-in before it auto-confirms.
  disputeWindowHours: () => envNumber('INSPECTION_ARRIVAL_DISPUTE_WINDOW_HOURS', 2, { min: 0.05 }),
  // How long the inspector has to check in after the seller accepts inspector + fee.
  arrivalWindowHours: () => envNumber('INSPECTION_ARRIVAL_WINDOW_HOURS', 72, { min: 1 }),
  // Wrong handshake codes allowed before the code path is locked.
  codeMaxAttempts: () => Math.floor(envNumber('INSPECTION_ARRIVAL_CODE_MAX_ATTEMPTS', 5, { min: 1 })),
  // Check-ins further than this from the listing are flagged for admin (never blocked).
  maxDistanceKm: () => envNumber('INSPECTION_ARRIVAL_MAX_DISTANCE_KM', 5, { min: 0.1 }),
  // Minutes after the agreed window that still count as on time.
  lateGraceMinutes: () => envNumber('INSPECTION_ARRIVAL_LATE_GRACE_MINUTES', 60, { min: 0 }),
  // No agreed window on file: arriving later than this after acceptance is "late".
  lateFallbackHours: () => envNumber('INSPECTION_ARRIVAL_LATE_FALLBACK_HOURS', 24, { min: 1 }),
  // After the report is submitted the buyer can accept it (instant release) or the
  // review window passes (automatic release).
  reportReviewHours: () => envNumber('INSPECTION_REPORT_REVIEW_HOURS', 48, { min: 0 }),
  // Reminder stages, hours before a deadline.
  reminderHours: () => [12, 2],
};

// ── Handshake code ──────────────────────────────────────────────────────────

function codeSecret() {
  const secret = process.env.ARRIVAL_CODE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('ARRIVAL_CODE_SECRET (or JWT_SECRET) must be set to use arrival codes');
  return secret;
}

/** Fresh random salt; rotating it invalidates the previous code. */
function newCodeSalt() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Deterministic 4-digit code bound to this request, this inspector and a salt.
 * Nothing secret is stored: the seller's screen derives it, and a check-in
 * recomputes it. A different inspector (reassignment) gets a different code.
 */
function deriveArrivalCode({ requestId, inspectorId, salt }) {
  if (!requestId || !inspectorId || !salt) return null;
  const digest = crypto
    .createHmac('sha256', codeSecret())
    .update(`arrival:${requestId}:${inspectorId}:${salt}`)
    .digest();
  return String(digest.readUInt32BE(0) % 10000).padStart(4, '0');
}

function codesMatch(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  if (!/^\d{4}$/.test(expected) || !/^\d{4}$/.test(supplied)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

// ── Geography ───────────────────────────────────────────────────────────────

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function validCoordinate(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── Agreed visit window and lateness ────────────────────────────────────────

function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function minutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function hhmm(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

/**
 * Earliest date where the seller's and the inspector's availability overlap.
 * Returns { date: 'YYYY-MM-DD', startTime, endTime } or null.
 */
function scheduledWindow(availability = []) {
  const sellers = availability.filter((a) => a.party === 'SELLER');
  const inspectors = availability.filter((a) => a.party === 'INSPECTOR');
  let best = null;
  for (const s of sellers) {
    for (const i of inspectors) {
      const date = isoDate(s.date);
      if (!date || date !== isoDate(i.date)) continue;
      const start = Math.max(minutes(s.startTime) ?? -1, minutes(i.startTime) ?? -1);
      const end = Math.min(minutes(s.endTime) ?? -1, minutes(i.endTime) ?? -1);
      if (start < 0 || end <= start) continue;
      const candidate = { date, startTime: hhmm(start), endTime: hhmm(end) };
      if (!best || `${candidate.date}T${candidate.startTime}` < `${best.date}T${best.startTime}`) best = candidate;
    }
  }
  return best;
}

/** Instant when the agreed window ends (local Ethiopian time). */
function windowEnd(window) {
  if (!window) return null;
  const d = new Date(`${window.date}T${window.endTime}:00${LOCAL_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isLateArrival({ checkedInAt, window, acceptedAt }) {
  const at = new Date(checkedInAt).getTime();
  if (!Number.isFinite(at)) return false;
  const graceMs = config.lateGraceMinutes() * 60 * 1000;
  const end = windowEnd(window);
  if (end) return at > end.getTime() + graceMs;
  if (acceptedAt) {
    return at > new Date(acceptedAt).getTime() + config.lateFallbackHours() * 3600 * 1000;
  }
  return false;
}

// ── Reliability ─────────────────────────────────────────────────────────────

/**
 * 0–100 score. Attendance (70%) uses a prior of three 90% visits so one bad
 * day does not wreck a new inspector and one good day does not make one
 * look perfect. Report speed (30%) is target hours / average hours, clamped.
 */
function reliabilityScore(stats = {}, { targetReportHours = 24 } = {}) {
  const onTime = Number(stats.onTimeArrivals) || 0;
  const late = Number(stats.lateArrivals) || 0;
  const noShows = Number(stats.noShows) || 0;
  const reports = Number(stats.reportsSubmitted) || 0;
  const totalMinutes = Number(stats.totalReportMinutes) || 0;

  const arrivals = onTime + late + noShows;
  const attendance = (onTime + 0.5 * late + 2.7) / (arrivals + 3);
  let speed = 0.9;
  if (reports > 0 && totalMinutes > 0) {
    const avgHours = totalMinutes / reports / 60;
    speed = Math.min(1, Math.max(0.5, targetReportHours / avgHours));
  }
  return Math.round(100 * (0.7 * attendance + 0.3 * speed));
}

function reliabilitySummary(stats) {
  const s = stats || {};
  const reports = Number(s.reportsSubmitted) || 0;
  const arrivals = (Number(s.onTimeArrivals) || 0) + (Number(s.lateArrivals) || 0) + (Number(s.noShows) || 0);
  const score = reliabilityScore(s);
  let tier = 'RELIABLE';
  if (arrivals + reports < 3) tier = 'NEW';
  else if (score >= 85) tier = 'HIGHLY_RELIABLE';
  else if (score < 70) tier = 'NEEDS_IMPROVEMENT';
  return {
    score,
    tier,
    noShows: Number(s.noShows) || 0,
    lateArrivals: Number(s.lateArrivals) || 0,
    onTimeArrivals: Number(s.onTimeArrivals) || 0,
    reportsSubmitted: reports,
    avgReportHours: reports > 0 && Number(s.totalReportMinutes) > 0
      ? Math.round((Number(s.totalReportMinutes) / reports / 60) * 10) / 10
      : null,
  };
}

/** Best first: higher score, then lower fee, then earlier bid. */
function compareBids(a, b) {
  const byScore = (b.reliability?.score ?? 0) - (a.reliability?.score ?? 0);
  if (byScore) return byScore;
  const byFee = Number(a.amount ?? 0) - Number(b.amount ?? 0);
  if (byFee) return byFee;
  return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
}

module.exports = {
  LOCAL_OFFSET,
  config,
  newCodeSalt,
  deriveArrivalCode,
  codesMatch,
  validCoordinate,
  haversineKm,
  scheduledWindow,
  windowEnd,
  isLateArrival,
  reliabilityScore,
  reliabilitySummary,
  compareBids,
};
