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
//   • Visible once the transport job reaches ACCEPTED (commercially agreed; payment may still be pending).
//   • NEVER visible to the buyer, even though the buyer pays the transport fee.
//   • Admin override for support, always audited.
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
const OPEN_STATUSES = new Set(['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED']);

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
 * Marks the coordination row (if any) as superseded. Called inside the
 * transaction that reassigns a transporter, so the row is closed atomically
 * with the reassignment.
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
    data: { supersededAt: new Date() },
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
      },
    });
  }

  return tx.transportCoordination.create({
    data: { transportJobId },
  });
}

module.exports = {
  OPEN_STATUSES,
  assertCoordinationStage,
  viewerRoleFor,
  canViewCoordination,
  closeCoordination,
  ensureOpenCoordination,
};
