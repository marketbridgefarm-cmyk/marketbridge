'use strict';

const { createNotificationsForOrderEvent } = require('./notificationService');

async function recordOrderEvent(tx, {
  orderId,
  actorId = null,
  type,
  fromStatus = null,
  toStatus = null,
  metadata = null,
}) {
  if (!orderId || !type) return null;
  const event = await tx.orderEvent.create({
    data: {
      orderId,
      actorId,
      type,
      fromStatus: fromStatus == null ? null : String(fromStatus),
      toStatus: toStatus == null ? null : String(toStatus),
      metadata: metadata || undefined,
    },
  });

  // Notifications are generated in the same transaction as the workflow
  // event, so the user inbox cannot drift away from durable OrderEvent data.
  await createNotificationsForOrderEvent(tx, event);

  return event;
}

async function listOrderEvents(tx, orderId, limit = 100) {
  return tx.orderEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    include: { actor: { select: { id: true, name: true } } },
  });
}

module.exports = { recordOrderEvent, listOrderEvents };
