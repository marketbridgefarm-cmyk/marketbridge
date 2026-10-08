'use strict';

const { localizedTitle } = require('./notificationCopy');

const EVENT_COPY = {
  WORKFLOW_RECOVERY_REQUESTED: {
    type: 'ORDER',
    title: 'Service recovery requested',
    body: 'A request to recover the inspection or transport workflow was submitted for review. Your goods order remains separate from this service recovery.',
    action: 'order',
  },
  WORKFLOW_RECOVERY_APPROVED: {
    type: 'ORDER',
    title: 'Fresh service bidding is available',
    body: 'MarketBridge approved the affected service recovery and released a fresh form. Only that service competition was reset; other order workflows remain unchanged.',
    action: 'order',
  },
  WORKFLOW_RECOVERY_REJECTED: {
    type: 'ORDER',
    title: 'Service recovery request reviewed',
    body: 'MarketBridge reviewed the service recovery request. Open the order to see the decision and admin note.',
    action: 'order',
  },
  PICKUP_WINDOW_REMINDER: { type: 'ORDER', title: 'Pickup window approaching', body: 'The agricultural pickup window begins within 24 hours. Confirm transport and pickup readiness.', action: 'order' },
  ORDER_CREATED: {
    type: 'ORDER',
    title: 'New order created',
    body: 'A new order has been created and is ready for the next payment/workflow step.',
    action: 'order',
  },
  INSPECTION_QUOTE_EXPIRED: {
    type: 'INSPECTION',
    title: 'Inspection quote expired',
    body: 'An inspection quote reached its response deadline and is no longer available. Review the remaining quotes or request admin recovery if needed.',
    action: 'order',
  },
  TRANSPORT_QUOTE_EXPIRED: {
    type: 'TRANSPORT',
    title: 'Transport quote expired',
    body: 'A transport quote reached its response deadline and is no longer available. Review the remaining quotes or request admin recovery if needed.',
    action: 'order',
  },
  INSPECTION_ACCEPTED: {
    type: 'INSPECTION',
    title: 'Inspection accepted',
    body: 'An inspection quote has been accepted. Review the inspection details and complete any required payment or next step.',
    action: 'order',
  },
  INSPECTION_STARTED: {
    type: 'INSPECTION',
    title: 'Inspection started',
    body: 'The assigned inspector has started the inspection.',
    action: 'order',
  },
  INSPECTION_COMPLETED: {
    type: 'INSPECTION',
    title: 'Inspection completed',
    body: 'The inspection report is now available for review.',
    action: 'order',
  },
  BUYER_DECISION_MADE: {
    type: 'ORDER',
    title: 'Buyer decision recorded',
    body: 'The buyer has made the agricultural purchase decision. Review the order for the next step.',
    action: 'order',
  },
  BUYER_DECISION_TIMEOUT: {
    type: 'ORDER',
    title: 'Purchase closed: buyer decision expired',
    body: 'The buyer did not make the BUY/CANCEL decision before the deadline. The purchase has been closed.',
    action: 'order',
  },
  SELLER_TRANSPORT_PREPARATION_TIMEOUT: {
    type: 'TRANSPORT',
    title: 'Transport arrangement expired',
    body: 'The seller did not confirm transporter preparation before the deadline. The transport arrangement was cancelled; a new transporter can be arranged.',
    action: 'order',
  },
  BUYER_LOADING_APPROVAL_TIMEOUT: {
    type: 'TRANSPORT',
    title: 'Transport arrangement expired',
    body: 'The buyer did not approve the loading report before the deadline. The transport arrangement was cancelled; the seller payment remains separate and a new transporter can be arranged.',
    action: 'order',
  },
  PAYMENT_STATUS_CHANGED: {
    type: 'PAYMENT',
    title: 'Payment status updated',
    body: 'A payment connected to this order has changed status. Review the order for the next required action.',
    action: 'order',
  },
  TRANSPORT_STATUS_CHANGED: {
    type: 'TRANSPORT',
    title: 'Transport status updated',
    body: 'The transport job status has changed. Review the order for the latest delivery step.',
    action: 'order',
  },
  RECEIPT_CONFIRMED: {
    type: 'ORDER',
    title: 'Receipt confirmed',
    body: 'The buyer confirmed receipt. The order is now completed.',
    action: 'order',
  },
  ORDER_CANCELLED: {
    type: 'ORDER',
    title: 'Order cancelled',
    body: 'This order has been cancelled. Review the order for the latest details.',
    action: 'order',
  },
  PAYMENT_REFUND_REQUESTED: {
    type: 'PAYMENT',
    title: 'Refund requested',
    body: 'A refund has been requested for a payment connected to this order.',
    action: 'order',
  },
  PAYMENT_REFUNDED: {
    type: 'PAYMENT',
    title: 'Payment refunded',
    body: 'A payment connected to this order has been refunded.',
    action: 'order',
  },
  PAYMENT_REFUND_FAILED: {
    type: 'PAYMENT',
    title: 'Refund could not be completed',
    body: 'A requested refund could not be completed. Review the order for the latest financial status.',
    action: 'order',
  },
  PAYMENT_RECONCILIATION_REQUIRED: {
    type: 'PAYMENT',
    title: 'Payment requires review',
    body: 'A payment connected to this order requires financial reconciliation before it can be treated as settled.',
    action: 'order',
  },
  PROVIDER_AGREEMENT_RELEASED: {
    type: 'ORDER',
    title: 'Provider cancelled the agreement',
    body: 'The provider cancelled the provisional agreement before payment. Choose another provider from the available bids.',
    action: 'order',
  },
  REQUESTER_AGREEMENT_RELEASED: {
    type: 'ORDER',
    title: 'Agreement released',
    body: 'The requester released the provisional agreement. You are no longer assigned to this job.',
    action: 'order',
  },
  PROVIDER_STANDING_CHANGED: {
    type: 'ORDER',
    title: 'Your bidding standing changed',
    body: 'Your provider standing changed because of cancelled agreements. Open your dashboard for details.',
    action: 'order',
  },
  PAYMENT_RECONCILIATION_RESOLVED: {
    type: 'PAYMENT',
    title: 'Payment reconciliation resolved',
    body: 'A payment reconciliation issue connected to this order has been resolved.',
    action: 'order',
  },
};

const ACTIONABLE_EVENTS = new Set(Object.keys(EVENT_COPY));

function uniqueIds(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function buildCopy(type, metadata = {}) {
  const copy = EVENT_COPY[type] || {
    type: 'ORDER',
    title: 'Order update',
    body: 'There is a new update on an order you are involved in.',
    action: 'order',
  };

  let body = copy.body;

  if (type === 'PROVIDER_STANDING_CHANGED') {
    if (metadata.kind === 'WARNING') {
      body = 'Warning: one more cancellation of an accepted agreement will suspend your bidding. Cancellations also lower your rating.';
    } else if (metadata.kind === 'SUSPENDED') {
      body = metadata.until
        ? `Your bidding is suspended until ${new Date(metadata.until).toISOString().slice(0, 10)} because of repeated cancellations. You can appeal from your dashboard.`
        : 'Your bidding is suspended until MarketBridge admin reviews your account. You can appeal from your dashboard.';
    }
  }

  if (type === 'PROVIDER_AGREEMENT_RELEASED' && metadata.service) {
    const who = metadata.service === 'TRANSPORT' ? 'transporter' : 'inspector';
    body = `The ${who} cancelled the provisional agreement before payment. Choose another ${who} from the available bids.`;
  }

  if (type === 'REQUESTER_AGREEMENT_RELEASED' && metadata.service) {
    const what = metadata.service === 'TRANSPORT' ? 'transport' : 'inspection';
    body = `The requester released the provisional ${what} agreement. You are no longer assigned to this job.`;
  }

  if (type === 'TRANSPORT_STATUS_CHANGED' && metadata.toStatus) {
    body = `Transport status is now ${String(metadata.toStatus).replace(/_/g, ' ').toLowerCase()}. Review the order for the next step.`;
  }

  if (type === 'PAYMENT_STATUS_CHANGED' && metadata.toStatus) {
    body = `A payment connected to this order is now ${String(metadata.toStatus).replace(/_/g, ' ').toLowerCase()}. Review the order for the next step.`;
  }

  if (type === 'TRANSPORT_STATUS_CHANGED' && String(metadata.toStatus || '').toUpperCase() === 'DELIVERED') {
    body = 'Transport has been marked delivered. The buyer should review the delivery and confirm receipt when satisfied.';
  }

  return { ...copy, body };
}

async function resolveRecipients(tx, { orderId, actorId, type, metadata = {} }) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerId: true,
      sellerId: true,
      transportJob: { select: { truckOwnerId: true } },
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        select: { requestedById: true, inspectorId: true },
      },
    },
  });

  if (!order) return [];

  const buyerSeller = [order.buyerId, order.sellerId];
  const transportUsers = [order.transportJob?.truckOwnerId];
  const inspectionUsers = (order.inspectionRequests || []).flatMap((request) => [
    request.requestedById,
    request.inspectorId,
  ]);

  let recipients;

  switch (type) {
    case 'PICKUP_WINDOW_REMINDER':
      recipients = buyerSeller;
      break;
    case 'ORDER_CREATED':
      // Notify the participant who did not create/accept the order. This works
      // for both Buy Now (buyer creates it) and negotiated offer acceptance
      // (buyer or seller may be the actor).
      recipients = buyerSeller;
      break;
    case 'INSPECTION_ACCEPTED':
    case 'INSPECTION_STARTED':
    case 'INSPECTION_COMPLETED':
      recipients = [...buyerSeller, ...inspectionUsers];
      break;
    case 'PROVIDER_STANDING_CHANGED':
      recipients = [metadata.providerId];
      break;
    case 'PROVIDER_AGREEMENT_RELEASED':
      recipients = [...buyerSeller];
      break;
    case 'REQUESTER_AGREEMENT_RELEASED':
      // The released provider is no longer on the job, so the id travels in
      // the event metadata.
      recipients = [metadata.providerId];
      break;
    case 'BUYER_DECISION_MADE':
    case 'BUYER_DECISION_TIMEOUT':
      recipients = [...buyerSeller];
      break;
    case 'SELLER_TRANSPORT_PREPARATION_TIMEOUT':
    case 'BUYER_LOADING_APPROVAL_TIMEOUT':
      recipients = [...buyerSeller, ...transportUsers];
      break;
    case 'TRANSPORT_STATUS_CHANGED':
      recipients = [...buyerSeller, ...transportUsers];
      break;
    case 'PAYMENT_STATUS_CHANGED':
      // Payment events are relevant to both commercial parties and, when the
      // payment is for transport, the assigned transporter.
      recipients = [...buyerSeller];
      if (String(metadata.paymentType || '').toUpperCase() === 'TRANSPORT') {
        recipients.push(...transportUsers);
      }
      break;
    case 'RECEIPT_CONFIRMED':
      recipients = [order.sellerId];
      break;
    case 'ORDER_CANCELLED':
    case 'PAYMENT_REFUND_REQUESTED':
    case 'PAYMENT_REFUNDED':
    case 'PAYMENT_REFUND_FAILED':
    case 'PAYMENT_RECONCILIATION_REQUIRED':
    case 'PAYMENT_RECONCILIATION_RESOLVED':
      recipients = [...buyerSeller];
      if (String(metadata.paymentType || '').toUpperCase() === 'TRANSPORT') {
        recipients.push(...transportUsers);
      }
      break;
    default:
      recipients = buyerSeller;
      break;
  }

  // Never create a notification for the actor who caused the event. This
  // keeps the inbox actionable rather than echoing the user's own action.
  return uniqueIds(recipients).filter((id) => id !== actorId);
}

async function createNotificationsForOrderEvent(tx, event) {
  if (!event || !ACTIONABLE_EVENTS.has(event.type)) return [];

  const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const recipients = await resolveRecipients(tx, {
    orderId: event.orderId,
    actorId: event.actorId,
    type: event.type,
    metadata,
  });

  if (recipients.length === 0) return [];

  const copy = buildCopy(event.type, metadata);
  const action = copy.action === 'order' ? { path: `/orders/${event.orderId}` } : null;

  const data = recipients.map((userId) => ({
    userId,
    orderId: event.orderId,
    orderEventId: event.id,
    type: copy.type,
    title: copy.title,
    body: copy.body,
    action,
    metadata: {
      eventType: event.type,
      fromStatus: event.fromStatus || null,
      toStatus: event.toStatus || null,
    },
  }));

  await tx.notification.createMany({
    data,
    skipDuplicates: true,
  });

  await queueSmsForRecipients(tx, { recipients, copy, orderId: event.orderId, eventType: event.type });

  return data;
}

/**
 * Queue an SMS outbox row (same transaction, no network call here — see
 * services/smsService.js and maintenanceService.js's sendPendingSms for the
 * actual send) for any recipient who has opted in and has a phone number
 * on file. SMS is short and link-free by design: it's a nudge to open the
 * app, not the full notification body.
 */
async function queueSmsForRecipients(tx, { recipients, copy, orderId, eventType }) {
  const users = await tx.user.findMany({
    where: {
      id: { in: recipients },
      smsNotificationsEnabled: true,
      phone: { not: null },
    },
    select: { id: true, phone: true, preferredLanguage: true },
  });

  if (users.length === 0) return;

  await tx.smsOutboxEntry.createMany({
    data: users.map((u) => ({
      userId: u.id,
      phone: u.phone,
      body: `MarketBridge: ${localizedTitle(eventType, u.preferredLanguage)}.`.slice(0, 300),
    })),
  });
}

async function listNotifications(prisma, userId, { limit = 50, unreadOnly = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const where = {
    userId,
    ...(unreadOnly ? { readAt: null } : {}),
  };

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        orderId: true,
        orderEventId: true,
        type: true,
        title: true,
        body: true,
        action: true,
        metadata: true,
        readAt: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return { notifications, unreadCount };
}

module.exports = {
  createNotificationsForOrderEvent,
  listNotifications,
};
