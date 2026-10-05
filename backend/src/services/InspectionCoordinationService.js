'use strict';

// ============================================================================
// INSPECTION COORDINATION SERVICE
// ============================================================================
//
// Seller <-> inspector operational handoff.
//
// Access rule (single source of truth, enforced here and called by every
// coordination route):
//   • Visible only to the seller of the listing and the assigned inspector.
//   • Visible only once the inspection request is ACCEPTED or later.
//   • NEVER visible to the buyer, even though the buyer may pay the fee.
//   • Admin override for support, always audited.
//
// Reassignment rule:
//   • withdraw / reopen-bidding / recovery-approve must call
//     closeCoordination(tx, requestId) inside their transaction, otherwise a
//     reassigned inspection exposes the previous inspector's phone number to
//     the next one.
// ============================================================================

const OPEN_STATUSES = new Set(['ACCEPTED', 'IN_PROGRESS', 'COMPLETED']);

/**
 * Throws 409 unless the inspection request is in a status where coordination
 * is allowed. Deliberately throws rather than returns a boolean so a route
 * handler cannot accidentally proceed by ignoring a falsy return value.
 */
function assertCoordinationStage(request) {
  if (!request) {
    const err = new Error('Inspection request not found');
    err.statusCode = 404;
    throw err;
  }
  if (!OPEN_STATUSES.has(request.status)) {
    const err = new Error(
      'Coordination is available only after the inspection agreement is accepted'
    );
    err.statusCode = 409;
    err.code = 'COORDINATION_NOT_OPEN';
    throw err;
  }
}

/**
 * Returns { allowed, role } for the given viewer.
 *   role = 'SELLER' | 'INSPECTOR' | 'ADMIN' | null
 * Never returns 'BUYER' — the buyer is intentionally excluded even when the
 * buyer is the one who originally opened the inspection request.
 */
function viewerRoleFor(request, user) {
  if (!request || !user) return { allowed: false, role: null };
  if (Array.isArray(user.roles) && user.roles.includes('ADMIN')) {
    return { allowed: true, role: 'ADMIN' };
  }
  const sellerId = request.listing?.sellerId || null;
  if (sellerId && user.id === sellerId) return { allowed: true, role: 'SELLER' };
  if (request.inspectorId && user.id === request.inspectorId) {
    return { allowed: true, role: 'INSPECTOR' };
  }
  return { allowed: false, role: null };
}

/**
 * Returns the coordination row only when the caller may see it.
 * Non-participants and pre-ACCEPTED stages both produce null (routes turn
 * that into the correct 403 / 409).
 */
function canViewCoordination(request, user) {
  const { allowed, role } = viewerRoleFor(request, user);
  if (!allowed) return { allowed: false, role: null };
  if (role === 'ADMIN') return { allowed: true, role };
  return { allowed: OPEN_STATUSES.has(request.status), role };
}

/**
 * Marks the coordination row (if any) as superseded. Called inside the
 * transaction that reassigns an inspector, so the row is closed atomically
 * with the reassignment.
 */
async function closeCoordination(tx, inspectionRequestId, reason = null) {
  if (!inspectionRequestId) return null;
  const existing = await tx.inspectionCoordination.findUnique({
    where: { inspectionRequestId },
  });
  if (!existing) return null;
  if (existing.supersededAt) return existing;

  return tx.inspectionCoordination.update({
    where: { inspectionRequestId },
    data: { supersededAt: new Date() },
  });
}

/**
 * Ensures exactly one OPEN coordination row exists for the request.
 * If the existing row is superseded, a fresh blank one is created so the new
 * inspector starts from an empty sheet.
 */
async function ensureOpenCoordination(tx, inspectionRequestId) {
  const existing = await tx.inspectionCoordination.findUnique({
    where: { inspectionRequestId },
  });
  if (existing && !existing.supersededAt) return existing;
  if (existing && existing.supersededAt) {
    // A superseded row blocks re-creation via the @unique constraint, so
    // clear its content instead of creating a second row.
    return tx.inspectionCoordination.update({
      where: { inspectionRequestId },
      data: {
        sellerContactName: null,
        sellerPhone: null,
        sellerAlternativePhone: null,
        sellerEmail: null,
        sellerPreferredContact: null,
        inspectionSite: null,
        meetingPoint: null,
        accessInstructions: null,
        sellerNotes: null,
        sellerSubmittedAt: null,
        inspectorContactName: null,
        inspectorPhone: null,
        inspectorAlternativePhone: null,
        inspectorEmail: null,
        inspectorPreferredContact: null,
        inspectorArrivalNotes: null,
        inspectorNotes: null,
        inspectorSubmittedAt: null,
        supersededAt: null,
      },
    });
  }
  return tx.inspectionCoordination.create({
    data: { inspectionRequestId },
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
