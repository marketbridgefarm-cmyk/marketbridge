'use strict';

/**
 * Append an application audit event.
 *
 * Pass a Prisma transaction client when the audited action is transactional so
 * the audit record commits or rolls back with the state change.
 */
async function recordAuditEvent(tx, {
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  metadata = null,
  ipAddress = null,
  userAgent = null,
}) {
  if (!tx || typeof tx.auditEvent?.create !== 'function') {
    throw new Error('A Prisma client/transaction is required for audit events');
  }

  if (!action || !resourceType) {
    throw new Error('Audit action and resourceType are required');
  }

  return tx.auditEvent.create({
    data: {
      actorId,
      action,
      resourceType,
      resourceId,
      metadata,
      ipAddress,
      userAgent,
    },
  });
}

module.exports = {
  recordAuditEvent,
};
