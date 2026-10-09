'use strict';

// ============================================================================
// TRANSPORT COORDINATION SERVICE
// ============================================================================
//
// Seller <-> transporter operational handoff.
//
// Access rule (single source of truth, enforced here and called by every
// coordination route):
//   • Visible only to the seller of the listing and the assigned transporter.
//   • Visible once the transport job reaches ACCEPTED (commercially agreed;
//     payment may still be pending).
//   • NEVER visible to the buyer, even though the buyer pays the transport fee.
//   • Admin override for support, always audited. The route handler that
//     calls this service with an ADMIN viewer MUST write an audit log entry
//     (userId, transportJobId, timestamp, reason) before returning the data.
//
// Contact-sharing model:
//   Unlike the bidding phase (where free text is blocked to prevent off-platform
//   deals), coordination is the deliberate exchange of contact and site-access
//   details between two matched parties. Free text IS allowed here. The route
//   handlers are responsible for:
//     • Bounding length (max 500 chars per field).
//     • Rejecting embedded URLs (http/https/www) as defence-in-depth.
//     • Preserving the raw text so the seller/transporter see exactly what
//       the other party wrote (no stripping, since both are verified parties).
//
// Reassignment rule:
//   • quote WITHDRAW, admin reopen-bidding, and recovery-approve must call
//     closeCoordination(tx, jobId) inside their transaction, otherwise a
//     reassigned transport exposes the previous driver's phone number to the
//     next one.
// ============================================================================

// Coordination opens at ACCEPTED and remains open through the operational
// trip states. It never opens during REQUESTED / QUOTED, because the truck is
// not yet committed at those stages.
const OPEN_STATUSES = Object.freeze(
  new Set(['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'])
);

// Free-text fields the route handlers may write. Kept here so callers can
// share one list rather than duplicating string literals.
const FREE_TEXT_FIELDS = Object.freeze([
  'sellerContactName',
  'sellerPhone',
  'sellerAlternativePhone',
  'sellerEmail',
  'pickupSite',
  'meetingPoint',
  'accessInstructions',
  'sellerPrepNotes',
  'driverContactName',
  'driverPhone',
  'driverAlternativePhone',
  'driverEmail',
  'driverArrivalNotes',
  'driverNotes',
]);

// Simple URL detector used as defence-in-depth. Both parties are verified,
// but a seller could still paste a phishing link to a driver, or vice versa.
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

/**
 * Throws 409 unless the transport job is in a status where coordination is
 * allowed. Deliberately throws rather than returns a boolean, so a route
 * handler cannot accidentally proceed by ignoring a falsy return value.
 */
function assertCoordinationStage(job) {
  if (!job) {
    const err = new Error('Transport job not found');
    err.statusCode = 404;
    throw err;
  }
  if (!OPEN_STATUSES.has(job.status)) {
    const err = new Error(
      'Coordination is available only after the transport arrangement has been commercially agreed; payment may still be pending'
    );
    err.statusCode = 409;
    err.code = 'COORDINATION_NOT_OPEN';
    throw err;
  }
}

/**
 * Returns { allowed, role } for the given viewer.
 *   role = 'SELLER' | 'TRANSPORTER' | 'ADMIN' | null
 *
 * The seller of the listing and the assigned transporter are the only two
 * roles that see coordination. The buyer is intentionally excluded even
 * though they pay the transport fee.
 */
function viewerRoleFor(job, user) {
  if (!job || !user) return { allowed: false, role: null };

  if (Array.isArray(user.roles) && user.roles.includes('ADMIN')) {
    return { allowed: true, role: 'ADMIN' };
  }

  const sellerId = job.order?.sellerId || null;
  if (sellerId && user.id === sellerId) {
    return { allowed: true, role: 'SELLER' };
  }

  if (job.truckOwnerId && user.id === job.truckOwnerId) {
    return { allowed: true, role: 'TRANSPORTER' };
  }

  return { allowed: false, role: null };
}

/**
 * Combines role check with the stage gate. Returns the same shape, plus
 * a `stageOpen` boolean, so callers can decide whether to 403 or 409.
 */
function canViewCoordination(job, user) {
  const { allowed, role } = viewerRoleFor(job, user);
  if (!allowed) return { allowed: false, role: null, stageOpen: false };
  if (role === 'ADMIN') return { allowed: true, role, stageOpen: true };
  return { allowed: true, role, stageOpen: OPEN_STATUSES.has(job.status) };
}

/**
 * Validates and normalises the free-text fields a route handler is about to
 * write into a coordination row. Throws with a clear code so the route can
 * surface a 400 to the user.
 *
 *   input: { [field]: string | null | undefined }
 *   output: same shape, values trimmed; empty strings converted to null
 *
 * Rejects:
 *   • Any value longer than 500 characters.
 *   • Any value containing an http/https/www URL.
 *   • Unknown field names (protects against mass-assignment typos).
 */
function validateCoordinationText(input = {}) {
  const output = {};
  const knownFields = new Set(FREE_TEXT_FIELDS);

  for (const [field, rawValue] of Object.entries(input)) {
    if (!knownFields.has(field)) {
      const err = new Error(`Unknown coordination field: ${field}`);
      err.statusCode = 400;
      err.code = 'UNKNOWN_COORDINATION_FIELD';
      throw err;
    }
    if (rawValue === null || rawValue === undefined) {
      output[field] = null;
      continue;
    }
    const value = String(rawValue).trim();
    if (!value) {
      output[field] = null;
      continue;
    }
    if (value.length > 500) {
      const err = new Error(`${field} must be 500 characters or fewer`);
      err.statusCode = 400;
      err.code = 'COORDINATION_FIELD_TOO_LONG';
      throw err;
    }
    if (URL_PATTERN.test(value)) {
      const err = new Error(`${field} cannot contain a link`);
      err.statusCode = 400;
      err.code = 'COORDINATION_FIELD_CONTAINS_LINK';
      throw err;
    }
    output[field] = value;
  }

  return output;
}

/**
 * Marks the coordination row (if any) as superseded. Called inside the
 * transaction that reassigns a transporter, so the row is closed atomically
 * with the reassignment.
 *
 * The `reason` is persisted to `supersededReason` when the schema has that
 * column (see the migration note below). Passing it is optional; older rows
 * simply have a null reason.
 *
 * Returns the superseded row, or null if there was no coordination row.
 */
async function closeCoordination(tx, transportJobId, reason = null) {
  if (!transportJobId) return null;

  const existing = await tx.transportCoordination.findUnique({
    where: { transportJobId },
  });
  if (!existing) return null;
  if (existing.supersededAt) return existing;

  return tx.transportCoordination.update({
    where: { transportJobId },
    data: {
      supersededAt: new Date(),
      // Persist the reason if the schema supports it. If your schema does
      // not yet have `supersededReason`, drop this line and the migration
      // note below will guide you through adding it.
      supersededReason: reason ? String(reason).slice(0, 200) : null,
    },
  });
}

/**
 * Ensures exactly one OPEN coordination row exists for the job. Called when
 * a transport job transitions into ACCEPTED (commercial agreement) or when an
 * admin reopens bidding and the row needs to be cleared for the next driver.
 *
 * If the existing row was superseded, its content is cleared instead of
 * creating a second row, because the unique constraint on transportJobId
 * prevents duplication.
 *
 * NOTE: both halves (seller + driver) are cleared on reopen. This is
 * deliberate: the seller may have shared gate codes or access details that
 * should not leak to a replacement driver without the seller's knowledge.
 * The seller is expected to re-submit their side once the new driver is
 * confirmed.
 */
async function ensureOpenCoordination(tx, transportJobId) {
  const existing = await tx.transportCoordination.findUnique({
    where: { transportJobId },
  });

  if (existing && !existing.supersededAt) return existing;

  if (existing && existing.supersededAt) {
    return tx.transportCoordination.update({
      where: { transportJobId },
      data: {
        sellerContactName: null,
        sellerPhone: null,
        sellerAlternativePhone: null,
        sellerEmail: null,
        sellerPreferredContact: null,
        pickupSite: null,
        meetingPoint: null,
        accessInstructions: null,
        sellerPrepNotes: null,
        sellerSitePhotos: [],
        sellerPrepPhotos: [],
        sellerSubmittedAt: null,
        driverContactName: null,
        driverPhone: null,
        driverAlternativePhone: null,
        driverEmail: null,
        driverPreferredContact: null,
        driverArrivalEta: null,
        driverArrivalNotes: null,
        driverEquipment: [],
        driverNotes: null,
        driverSubmittedAt: null,
        supersededAt: null,
        supersededReason: null,
      },
    });
  }

  return tx.transportCoordination.create({
    data: { transportJobId },
  });
}

module.exports = {
  OPEN_STATUSES,
  FREE_TEXT_FIELDS,
  assertCoordinationStage,
  viewerRoleFor,
  canViewCoordination,
  validateCoordinationText,
  closeCoordination,
  ensureOpenCoordination,
};
