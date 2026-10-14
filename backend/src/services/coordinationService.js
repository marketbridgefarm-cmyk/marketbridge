'use strict';

// ============================================================================
// COORDINATION SERVICE (unified)
// ============================================================================
//
// Both coordination flows — seller <-> transporter, seller <-> inspector —
// follow the exact same shape:
//
//   • A single row per job/request holds each party's contact + handoff info.
//   • Access is scoped to the seller of the listing and the assigned provider.
//   • Coordination only opens at (or after) commercial agreement.
//   • The buyer NEVER sees any of it.
//   • Admin can view but not write.
//   • Reassignment supersedes the existing row so the previous provider's
//     phone number does not leak to the next one.
//
// The only per-flow differences are the six values in each config object
// below. This file turns those differences into two namespace objects —
// `transport` and `inspection` — that the two legacy service files re-export.
// ============================================================================

function makeCoordinationService(config) {
  const {
    OPEN_STATUSES,
    modelKey,
    foreignKey,
    notFoundMessage,
    closedMessage,
    sellerIdFor,          // (item) => string | null
    providerIdKey,        // field name on the item
    providerRole,         // 'TRANSPORTER' | 'INSPECTOR'
    resetFields,          // object of fields to clear on reuse
  } = config;

  function assertCoordinationStage(item) {
    if (!item) {
      const err = new Error(notFoundMessage);
      err.statusCode = 404;
      throw err;
    }
    if (!OPEN_STATUSES.has(item.status)) {
      const err = new Error(closedMessage);
      err.statusCode = 409;
      err.code = 'COORDINATION_NOT_OPEN';
      throw err;
    }
  }

  function viewerRoleFor(item, user) {
    if (!item || !user) return { allowed: false, role: null };
    if (Array.isArray(user.roles) && user.roles.includes('ADMIN')) {
      return { allowed: true, role: 'ADMIN' };
    }
    const sellerId = sellerIdFor(item);
    if (sellerId && user.id === sellerId) return { allowed: true, role: 'SELLER' };
    if (item[providerIdKey] && user.id === item[providerIdKey]) {
      return { allowed: true, role: providerRole };
    }
    return { allowed: false, role: null };
  }

  function canViewCoordination(item, user) {
    const { allowed, role } = viewerRoleFor(item, user);
    if (!allowed) return { allowed: false, role: null, stageOpen: false };
    if (role === 'ADMIN') return { allowed: true, role, stageOpen: true };
    return { allowed: true, role, stageOpen: OPEN_STATUSES.has(item.status) };
  }

  async function closeCoordination(tx, foreignId, reason = null) {
    if (!foreignId) return null;
    const model = tx[modelKey];
    const existing = await model.findUnique({ where: { [foreignKey]: foreignId } });
    if (!existing) return null;
    if (existing.supersededAt) return existing;
    return model.update({
      where: { [foreignKey]: foreignId },
      data: { supersededAt: new Date() },
    });
  }

  async function ensureOpenCoordination(tx, foreignId) {
    const model = tx[modelKey];
    const existing = await model.findUnique({ where: { [foreignKey]: foreignId } });

    if (existing && !existing.supersededAt) return existing;

    if (existing && existing.supersededAt) {
      // A superseded row blocks re-creation via the @unique constraint, so
      // clear its content instead of creating a second row.
      return model.update({
        where: { [foreignKey]: foreignId },
        data: { ...resetFields, supersededAt: null },
      });
    }

    return model.create({ data: { [foreignKey]: foreignId } });
  }

  return {
    OPEN_STATUSES,
    assertCoordinationStage,
    viewerRoleFor,
    canViewCoordination,
    closeCoordination,
    ensureOpenCoordination,
  };
}

// ============================================================================
// TRANSPORT CONFIGURATION
// ============================================================================

const TRANSPORT_OPEN_STATUSES = new Set(['ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED']);

const transport = makeCoordinationService({
  OPEN_STATUSES: TRANSPORT_OPEN_STATUSES,
  modelKey: 'transportCoordination',
  foreignKey: 'transportJobId',
  notFoundMessage: 'Transport job not found',
  closedMessage:
    'Coordination is available only after the transport arrangement has been commercially agreed; payment may still be pending',
  sellerIdFor: (job) => job.order?.sellerId || null,
  providerIdKey: 'truckOwnerId',
  providerRole: 'TRANSPORTER',
  resetFields: {
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
  },
});

// ============================================================================
// INSPECTION CONFIGURATION
// ============================================================================

const INSPECTION_OPEN_STATUSES = new Set(['ACCEPTED', 'IN_PROGRESS', 'COMPLETED']);

const inspection = makeCoordinationService({
  OPEN_STATUSES: INSPECTION_OPEN_STATUSES,
  modelKey: 'inspectionCoordination',
  foreignKey: 'inspectionRequestId',
  notFoundMessage: 'Inspection request not found',
  closedMessage:
    'Coordination is available only after the inspection agreement is accepted',
  sellerIdFor: (request) => request.listing?.sellerId || null,
  providerIdKey: 'inspectorId',
  providerRole: 'INSPECTOR',
  resetFields: {
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
  },
});

module.exports = {
  transport,
  inspection,
};
