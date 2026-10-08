'use strict';

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');

/**
 * Standard workflow timeout/fault event envelope.
 * Existing event types remain stable for notifications/backward compatibility;
 * the metadata shape is now consistent for reporting, disputes and recovery.
 */
async function recordWorkflowTimeout(tx, {
  orderId,
  actorId = null,
  eventType,
  auditAction = eventType,
  resourceType,
  resourceId,
  workflowPhase,
  deadline,
  faultParty,
  consequence,
  metadata = {},
  fromStatus = null,
  toStatus = null,
}) {
  const normalizedDeadline = deadline instanceof Date ? deadline.toISOString() : deadline || null;
  const envelope = {
    eventVersion: 1,
    workflowPhase,
    deadline: normalizedDeadline,
    faultParty,
    consequence,
    automatic: true,
    ...metadata,
  };

  if (orderId) {
    await recordOrderEvent(tx, {
      orderId,
      actorId,
      type: eventType,
      fromStatus,
      toStatus,
      metadata: envelope,
    });
  }

  if (resourceType && resourceId) {
    await recordAuditEvent(tx, {
      actorId,
      action: auditAction,
      resourceType,
      resourceId,
      metadata: { orderId, ...envelope },
    });
  }
}

module.exports = { recordWorkflowTimeout };
