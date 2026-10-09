'use strict';

const { localizedTitle } = require('./notificationCopy');

// ============================================================================
// EVENT COPY
// ============================================================================
// Keys are OrderEvent.type values. Every entry here is "actionable" — meaning
// the notification system fans out an in-app notification (and SMS, for opted
// -in recipients) whenever that event lands on an order.
// ============================================================================

const EVENT_COPY = {
  // ── Recovery ─────────────────────────────────────────────────────────────
  WORKFLOW_RECOVERY_REQUESTED: {
    type: 'ORDER',
    title: 'Service recovery requested',
    body: 'A request to recover the offer, inspection or transport workflow was submitted for review. Your goods order remains separate from this service recovery.',
    action: 'order',
  },
  WORKFLOW_RECOVERY_APPROVED: {
    type: 'ORDER',
    title: 'Fresh service bidding is available',
    body: 'MarketBridge approved the affected recovery and released a fresh form. Only that competition was reset; other order workflows remain unchanged.',
    action: 'order',
  },
  WORKFLOW_RECOVERY_REJECTED: {
    type: 'ORDER',
    title: 'Service recovery request reviewed',
    body: 'MarketBridge reviewed the recovery request. Open the order to see the decision and admin note.',
    action: 'order',
  },

  // ── Order lifecycle ──────────────────────────────────────────────────────
  ORDER_CREATED: {
    type: 'ORDER',
    title: 'New order created',
    body: 'A new order has been created and is ready for the next payment/workflow step.',
    action: 'order',
  },
  ORDER_CANCELLED: {
    type: 'ORDER',
    title: 'Order cancelled',
    body: 'This order has been cancelled. Review the order for the latest details.',
    action: 'order',
  },
  RECEIPT_CONFIRMED: {
    type: 'ORDER',
    title: 'Receipt confirmed',
    body: 'The buyer confirmed receipt. The order is now completed.',
    action: 'order',
  },
  PICKUP_WINDOW_REMINDER: {
    type: 'ORDER',
    title: 'Pickup window approaching',
    body: 'The agricultural pickup window begins within 24 hours. Confirm transport and pickup readiness.',
    action: 'order',
  },

  // ── Buyer decision ───────────────────────────────────────────────────────
  BUYER_DECISION_MADE: {
    type: 'ORDER',
    title: 'Buyer decision recorded',
    body: 'The buyer has made the purchase decision. Review the order for the next step.',
    action: 'order',
  },
  BUYER_DECISION_DEADLINE_APPROACHING: {
    type: 'ORDER',
    title: 'Purchase decision deadline approaching',
    body: 'The buyer must choose BUY or CANCEL within the next few hours. After the deadline, the purchase closes automatically.',
    action: 'order',
  },
  BUYER_DECISION_DEADLINE_EXPIRED: {
    type: 'ORDER',
    title: 'Purchase closed: decision deadline expired',
    body: 'The buyer did not make the BUY/CANCEL decision before the deadline. The purchase has been closed.',
    action: 'order',
  },
  // Legacy aliases (older rows in the DB may still carry these):
  BUYER_DECISION_TIMEOUT: {
    type: 'ORDER',
    title: 'Purchase closed: buyer decision expired',
    body: 'The buyer did not make the BUY/CANCEL decision before the deadline. The purchase has been closed.',
    action: 'order',
  },

  // ── Inspection ───────────────────────────────────────────────────────────
  INSPECTION_QUOTE_EXPIRED: {
    type: 'INSPECTION',
    title: 'Inspection quote expired',
    body: 'An inspection quote reached its response deadline and is no longer available. Review the remaining quotes or request admin recovery if needed.',
    action: 'order',
  },
  INSPECTION_ACCEPTED: {
    type: 'INSPECTION',
    title: 'Inspection accepted',
    body: 'An inspection quote has been accepted. Review the inspection details and complete any required payment or next step.',
    action: 'order',
  },
  INSPECTION_INSPECTOR_ARRIVED: {
    type: 'INSPECTION',
    title: 'Inspector confirmed on site',
    body: 'The seller confirmed the inspector has arrived on site. The inspection fee can now be paid.',
    action: 'order',
  },
  INSPECTION_PAYMENT_COMPLETE: {
    type: 'INSPECTION',
    title: 'Inspection fee paid',
    body: 'The inspection fee has been fully paid. The inspector can now start the work.',
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
  INSPECTION_REPORT_ADDENDUM_ADDED: {
    type: 'INSPECTION',
    title: 'Inspection report updated',
    body: 'A report addendum was added. The original report remains unchanged; review the addendum for the correction.',
    action: 'order',
  },
  INSPECTION_AGREEMENT_CLOSED: {
    type: 'INSPECTION',
    title: 'Inspection arrangement closed',
    body: 'The provisional inspection agreement was closed. Review the order — a fresh inspection request may be needed.',
    action: 'order',
  },
  INSPECTION_AGREEMENT_DECLINED: {
    type: 'INSPECTION',
    title: 'Inspection declined',
    body: 'The seller declined the provisional inspection agreement. The provisional purchase has been closed.',
    action: 'order',
  },
  INSPECTION_WORKFLOW_EXPIRED: {
    type: 'INSPECTION',
    title: 'Inspection competition expired',
    body: 'The inspection request expired without a confirmed inspector. Request a fresh inspection to continue.',
    action: 'order',
  },
  INSPECTION_STALLED: {
    type: 'INSPECTION',
    title: 'Inspection stalled',
    body: 'The inspection could not proceed within the allotted window. Review the order for the recovery options.',
    action: 'order',
  },
  INSPECTION_SELLER_CONFIRMATION_WAITING: {
    type: 'INSPECTION',
    title: 'Waiting for seller confirmation',
    body: 'The selected inspector is waiting for the seller to confirm the fee terms.',
    action: 'order',
  },
  INSPECTION_SELLER_CONFIRMATION_REMINDER: {
    type: 'INSPECTION',
    title: 'Inspection confirmation deadline approaching',
    body: 'The seller must confirm the selected inspector and agreed fee before the deadline, or the provisional purchase will close automatically.',
    action: 'order',
  },

  // ── Transport ────────────────────────────────────────────────────────────
  TRANSPORT_QUOTE_EXPIRED: {
    type: 'TRANSPORT',
    title: 'Transport quote expired',
    body: 'A transport quote reached its response deadline and is no longer available. Review the remaining quotes or request admin recovery if needed.',
    action: 'order',
  },
  TRANSPORT_COORDINATION_CLOSED: {
    type: 'TRANSPORT',
    title: 'Transport coordination closed',
    body: 'The transport arrangement was closed. Review the order — a fresh transport request may be needed.',
    action: 'order',
  },
  TRANSPORT_SELLER_PICKUP_CONFIRMED: {
    type: 'TRANSPORT',
    title: 'Seller confirmed transporter preparation',
    body: 'The seller confirmed the goods are ready for pickup. Next step: confirm the truck on site, then buyer transport payment.',
    action: 'order',
  },
  TRANSPORT_TRUCK_ARRIVED: {
    type: 'TRANSPORT',
    title: 'Truck on site',
    body: 'The truck has arrived at the pickup site. The buyer can now pay for transport.',
    action: 'order',
  },
  TRANSPORT_LOADING_REPORT_SUBMITTED: {
    type: 'TRANSPORT',
    title: 'Loading report submitted',
    body: 'The transporter submitted the pre-loading report. The buyer can review and approve it before physical loading begins.',
    action: 'order',
  },
  TRANSPORT_LOADING_CONFIRMED_BY_BUYER: {
    type: 'TRANSPORT',
    title: 'Loading report approved',
    body: 'The buyer approved the loading report. The transporter may now load and pick up the goods.',
    action: 'order',
  },
  TRANSPORT_STATUS_CHANGED: {
    type: 'TRANSPORT',
    title: 'Transport status updated',
    body: 'The transport job status has changed. Review the order for the latest delivery step.',
    action: 'order',
  },
  TRANSPORT_WORKFLOW_EXPIRED: {
    type: 'TRANSPORT',
    title: 'Transport competition expired',
    body: 'The transport request expired without a confirmed transporter. Request a fresh transport form to continue.',
    action: 'order',
  },
  SELLER_PREPARATION_DEADLINE_APPROACHING: {
    type: 'TRANSPORT',
    title: 'Transport preparation deadline approaching',
    body: 'The seller must confirm goods preparation before the deadline, or the transport arrangement will close.',
    action: 'order',
  },
  SELLER_PREPARATION_DEADLINE_EXPIRED: {
    type: 'TRANSPORT',
    title: 'Transport arrangement closed',
    body: 'The seller did not confirm transporter preparation before the deadline. The transport arrangement was cancelled; a new transporter can be arranged.',
    action: 'order',
  },
  BUYER_LOADING_DEADLINE_APPROACHING: {
    type: 'TRANSPORT',
    title: 'Loading approval deadline approaching',
    body: 'The buyer must review and approve the loading report before the deadline, or the transport arrangement will close.',
    action: 'order',
  },
  BUYER_LOADING_DEADLINE_EXPIRED: {
    type: 'TRANSPORT',
    title: 'Loading approval deadline expired',
    body: 'The buyer did not approve the loading report before the deadline. The transport arrangement was cancelled; the seller payment remains separate and a new transporter can be arranged.',
    action: 'order',
  },
  // Legacy aliases:
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

  // ── Price review ─────────────────────────────────────────────────────────
  PRICE_REVIEW_PROPOSED: {
    type: 'ORDER',
    title: 'Price review proposed',
    body: 'The other party proposed a revised price after the inspection. Open the order to accept, counter, or reject.',
    action: 'order',
  },
  PRICE_REVIEW_COUNTER: {
    type: 'ORDER',
    title: 'Price review countered',
    body: 'A counter-proposal was submitted. Open the order to respond.',
    action: 'order',
  },
  PRICE_REVIEW_ACCEPT: {
    type: 'ORDER',
    title: 'Revised price accepted',
    body: 'The revised price was accepted by both parties. Goods payment is now available.',
    action: 'order',
  },
  PRICE_REVIEW_REJECT: {
    type: 'ORDER',
    title: 'Price review rejected',
    body: 'The price review proposal was rejected. The order continues at the previously agreed price.',
    action: 'order',
  },

  // ── Payments ─────────────────────────────────────────────────────────────
  PAYMENT_STATUS_CHANGED: {
    type: 'PAYMENT',
    title: 'Payment status updated',
    body: 'A payment connected to this order has changed status. Review the order for the next required action.',
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
  PAYMENT_RECONCILIATION_RESOLVED: {
    type: 'PAYMENT',
    title: 'Payment reconciliation resolved',
    body: 'A payment reconciliation issue connected to this order has been resolved.',
    action: 'order',
  },

  // ── Provider agreements ──────────────────────────────────────────────────
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
};

const ACTIONABLE_EVENTS = new Set(Object.keys(EVENT_COPY));

// ============================================================================
// HELPERS
// ============================================================================

// Which flow an event belongs to. Recovery events carry it as
// metadata.service (preferred) or metadata.type. Anything other than the
// three known values is treated as "unknown" and the generic copy is used.
function normalizeService(metadata = {}) {
  const raw = String(metadata.service || metadata.type || '').toUpperCase();
  if (raw === 'OFFER' || raw === 'INSPECTION' || raw === 'TRANSPORT') return raw;
  return null;
}

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
  let title = copy.title;

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
    const service = normalizeService(metadata);
    const who =
      service === 'TRANSPORT' ? 'transporter'
      : service === 'OFFER' ? 'buyer'
      : 'inspector';
    body = service === 'OFFER'
      ? 'The buyer cancelled the provisional agreement before payment. Choose another buyer from the available bids.'
      : `The ${who} cancelled the provisional agreement before payment. Choose another ${who} from the available bids.`;
  }

  if (type === 'REQUESTER_AGREEMENT_RELEASED' && metadata.service) {
    const service = normalizeService(metadata);
    const what =
      service === 'TRANSPORT' ? 'transport'
      : service === 'OFFER' ? 'offer'
      : 'inspection';
    body = service === 'OFFER'
      ? 'The seller released the provisional offer agreement. You are no longer the selected buyer.'
      : `The requester released the provisional ${what} agreement. You are no longer assigned to this job.`;
  }

  if (type === 'WORKFLOW_RECOVERY_REQUESTED' || type === 'WORKFLOW_RECOVERY_APPROVED' || type === 'WORKFLOW_RECOVERY_REJECTED') {
    const service = normalizeService(metadata);
    if (service) {
      const label =
        service === 'OFFER' ? 'offer negotiation'
        : service === 'TRANSPORT' ? 'transport'
        : 'inspection';
      if (type === 'WORKFLOW_RECOVERY_REQUESTED') {
        title = `${label.charAt(0).toUpperCase()}${label.slice(1)} recovery requested`;
        body = `A request to recover the ${label} workflow was submitted for review. Your goods order remains separate from this recovery.`;
      } else if (type === 'WORKFLOW_RECOVERY_APPROVED') {
        title = `Fresh ${label} bidding is available`;
        body = `MarketBridge approved the ${label} recovery and released a fresh form. Only the ${label} competition was reset; other order workflows remain unchanged.`;
      } else {
        title = `${label.charAt(0).toUpperCase()}${label.slice(1)} recovery request reviewed`;
        body = `MarketBridge reviewed the ${label} recovery request. Open the order to see the decision and admin note.`;
      }
    }
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

  return { ...copy, title, body };
}

// ============================================================================
// RECIPIENT RESOLUTION
// ============================================================================

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
    // ── Recovery ───────────────────────────────────────────────────────────
    case 'WORKFLOW_RECOVERY_REQUESTED':
    case 'WORKFLOW_RECOVERY_APPROVED':
    case 'WORKFLOW_RECOVERY_REJECTED':
      recipients = buyerSeller;
      break;

    // ── Order lifecycle ────────────────────────────────────────────────────
    case 'PICKUP_WINDOW_REMINDER':
      recipients = buyerSeller;
      break;
    case 'ORDER_CREATED':
      recipients = buyerSeller;
      break;
    case 'ORDER_CANCELLED':
    case 'RECEIPT_CONFIRMED':
      recipients = buyerSeller;
      break;

    // ── Buyer decision ─────────────────────────────────────────────────────
    case 'BUYER_DECISION_MADE':
    case 'BUYER_DECISION_DEADLINE_APPROACHING':
    case 'BUYER_DECISION_DEADLINE_EXPIRED':
    case 'BUYER_DECISION_TIMEOUT':
      recipients = buyerSeller;
      break;

    // ── Inspection ─────────────────────────────────────────────────────────
    case 'INSPECTION_ACCEPTED':
    case 'INSPECTION_STARTED':
    case 'INSPECTION_COMPLETED':
    case 'INSPECTION_INSPECTOR_ARRIVED':
    case 'INSPECTION_PAYMENT_COMPLETE':
    case 'INSPECTION_REPORT_ADDENDUM_ADDED':
    case 'INSPECTION_AGREEMENT_CLOSED':
    case 'INSPECTION_AGREEMENT_DECLINED':
    case 'INSPECTION_WORKFLOW_EXPIRED':
    case 'INSPECTION_STALLED':
      recipients = [...buyerSeller, ...inspectionUsers];
      break;
    case 'INSPECTION_SELLER_CONFIRMATION_WAITING':
    case 'INSPECTION_SELLER_CONFIRMATION_REMINDER':
      // Only the seller acts on this; notifying anyone else is noise.
      recipients = [order.sellerId];
      break;

    // ── Transport ──────────────────────────────────────────────────────────
    case 'TRANSPORT_COORDINATION_CLOSED':
    case 'TRANSPORT_STATUS_CHANGED':
    case 'TRANSPORT_WORKFLOW_EXPIRED':
    case 'TRANSPORT_SELLER_PICKUP_CONFIRMED':
    case 'TRANSPORT_TRUCK_ARRIVED':
    case 'TRANSPORT_LOADING_REPORT_SUBMITTED':
    case 'TRANSPORT_LOADING_CONFIRMED_BY_BUYER':
    case 'SELLER_PREPARATION_DEADLINE_APPROACHING':
    case 'SELLER_PREPARATION_DEADLINE_EXPIRED':
    case 'BUYER_LOADING_DEADLINE_APPROACHING':
    case 'BUYER_LOADING_DEADLINE_EXPIRED':
    case 'SELLER_TRANSPORT_PREPARATION_TIMEOUT':
    case 'BUYER_LOADING_APPROVAL_TIMEOUT':
      recipients = [...buyerSeller, ...transportUsers];
      break;

    // ── Price review ───────────────────────────────────────────────────────
    case 'PRICE_REVIEW_PROPOSED':
    case 'PRICE_REVIEW_COUNTER':
    case 'PRICE_REVIEW_ACCEPT':
    case 'PRICE_REVIEW_REJECT':
      recipients = buyerSeller;
      break;

    // ── Provider agreements ────────────────────────────────────────────────
    case 'PROVIDER_STANDING_CHANGED':
      recipients = [metadata.providerId];
      break;
    case 'PROVIDER_AGREEMENT_RELEASED':
      recipients = [...buyerSeller];
      break;
    case 'REQUESTER_AGREEMENT_RELEASED':
      recipients = [metadata.providerId];
      break;

    // ── Payments ───────────────────────────────────────────────────────────
    case 'PAYMENT_STATUS_CHANGED':
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

// ============================================================================
// FAN-OUT
// ============================================================================

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

// ============================================================================
// SMS OUTBOX
// ============================================================================

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

// ============================================================================
// LIST (used by GET /notifications)
// ============================================================================

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
