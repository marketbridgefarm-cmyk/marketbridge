'use strict';

/**
 * Inspection agreement lifecycle deadlines and closure.
 *
 * A provisional inspector agreement (InspectionRequest.status = ACCEPTED) must
 * never stay open forever. Two windows apply while it is ACCEPTED, with the current deadline stored
 * in InspectionRequest.workflowDueAt:
 *
 *   1. before seller confirmation  -> SELLER_CONFIRM window
 *   2. after seller confirmation, until the inspection fee is fully paid
 *                                  -> PAYMENT window
 *
 * startDueAt (inspector must start) only begins once the fee is fully paid,
 * because the inspector cannot legally start before that.
 *
 * When a window lapses, or the seller declines, the agreement is closed for
 * everyone: coordination messages are closed, open obligations cancelled, the
 * quotes expired, the provisional order cancelled (so the listing is freed) and
 * the buyer receives a notice.
 */

const { recordAuditEvent } = require('../utils/audit');
const { recordOrderEvent } = require('./orderEventService');
const { cancelOrderInTransaction } = require('./orderCancellationService');
const { closeCoordination } = require('./inspectionCoordinationService');

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function envHours(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function computeSellerConfirmationDueAt() {
  return hoursFromNow(envHours('INSPECTION_SELLER_CONFIRM_HOURS', 24));
}

function computeInspectionPaymentDueAt() {
  return hoursFromNow(envHours('INSPECTION_PAYMENT_HOURS', 24));
}

const REASONS = {
  SELLER_DECLINED: {
    order: 'The seller declined the selected inspector or agreed inspection fee',
    notice: 'The seller declined the provisional inspection arrangement, so this purchase has been closed. The listing is available again.',
  },
  SELLER_CONFIRMATION_EXPIRED: {
    order: 'The seller did not confirm the selected inspector in time',
    notice: 'The seller did not confirm the inspection arrangement in time, so this purchase has been closed. You have not been charged.',
  },
  INSPECTION_PAYMENT_EXPIRED: {
    order: 'The inspection fee was not paid in time',
    notice: 'The inspection fee was not fully paid in time, so this purchase has been closed.',
  },
};

/**
 * Close a provisional (ACCEPTED) inspection agreement. Must run inside a
 * transaction. Returns { lapsed: boolean, skipped?: string }.
 *
 * It refuses to close anything that has money in flight: those cases need the
 * refund workflow, so the caller should route them to STALLED/manual handling.
 */
async function lapseInspectionAgreement(tx, { inspectionRequestId, code, actorId = null, actorRole = 'SYSTEM' }) {
  const meta = REASONS[code];
  if (!meta) throw new Error(`Unknown lapse code: ${code}`);

  const request = await tx.inspectionRequest.findUnique({
    where: { id: inspectionRequestId },
    include: { payments: { select: { id: true, status: true, type: true } } },
  });
  if (!request || request.status !== 'ACCEPTED') return { lapsed: false, skipped: 'NOT_ACCEPTED' };

  const moneyMoved = (request.payments || []).some(
    (p) => p.type === 'INSPECTOR' && ['PAID', 'PROCESSING', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'].includes(p.status)
  );
  if (moneyMoved) return { lapsed: false, skipped: 'PAYMENT_IN_FLIGHT' };

  await tx.inspectionRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED', workflowDueAt: null, startDueAt: null, completionDueAt: null },
  });
  await tx.inspectionQuote.updateMany({
    where: { inspectionRequestId: request.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'ACCEPTED'] } },
    data: { status: 'EXPIRED' },
  });
  await tx.paymentObligation.updateMany({
    where: { inspectionRequestId: request.id, type: 'INSPECTOR', status: 'OPEN' },
    data: { status: 'CANCELLED' },
  });
  await closeCoordination(tx, request.id, code);

  await recordAuditEvent(tx, {
    actorId,
    action: `INSPECTION_AGREEMENT_${code}`,
    resourceType: 'InspectionRequest',
    resourceId: request.id,
    metadata: {
      orderId: request.orderId,
      eventVersion: 1,
      workflowPhase: code === 'SELLER_CONFIRMATION_EXPIRED' ? 'INSPECTION_SELLER_CONFIRMATION' : 'INSPECTION_PAYMENT',
      deadline: request.workflowDueAt ? request.workflowDueAt.toISOString() : null,
      automatic: code === 'SELLER_CONFIRMATION_EXPIRED' || code === 'INSPECTION_PAYMENT_EXPIRED',
      actorRole,
      faultParty: code === 'SELLER_CONFIRMATION_EXPIRED' || code === 'SELLER_DECLINED' ? 'SELLER' : 'INSPECTION_PAYER',
      consequence: 'ORDER_CANCELLED',
    },
  });

  if (request.orderId) {
    await recordOrderEvent(tx, {
      orderId: request.orderId,
      actorId,
      type: 'INSPECTION_AGREEMENT_CLOSED',
      fromStatus: 'ACCEPTED',
      toStatus: 'CANCELLED',
      metadata: {
        inspectionRequestId: request.id,
        code,
        eventVersion: 1,
        workflowPhase: code === 'SELLER_CONFIRMATION_EXPIRED' ? 'INSPECTION_SELLER_CONFIRMATION' : 'INSPECTION_PAYMENT',
        deadline: request.workflowDueAt ? request.workflowDueAt.toISOString() : null,
        automatic: code === 'SELLER_CONFIRMATION_EXPIRED' || code === 'INSPECTION_PAYMENT_EXPIRED',
        actorRole,
        inspectorId: request.inspectorId,
        reason: meta.notice,
        faultParty: code === 'SELLER_CONFIRMATION_EXPIRED' || code === 'SELLER_DECLINED' ? 'SELLER' : 'INSPECTION_PAYER',
        consequence: 'ORDER_CANCELLED',
      },
    });

    const order = await tx.order.findUnique({
      where: { id: request.orderId },
      include: { transportJob: true, payments: true, listing: { select: { category: true } } },
    });

    const orderOpen = order && !['CANCELLED', 'COMPLETED', 'DISPUTED'].includes(order.status);
    const nothingPaid = order && !(order.payments || []).some((p) => ['PAID', 'PROCESSING'].includes(p.status));
    if (orderOpen && nothingPaid && !order.buyerDecision) {
      await cancelOrderInTransaction(tx, {
        order,
        actorId,
        reason: meta.order,
        cancelledByRole: actorRole,
      });
      await tx.offerNotification.create({
        data: {
          userId: order.buyerId,
          listingId: order.listingId,
          offerId: order.agreedOfferId || null,
          type: 'ORDER_CLOSED',
          title: 'Purchase closed',
          body: meta.notice,
          metadata: { orderId: order.id, inspectionRequestId: request.id, code },
        },
      });
    }
  }

  return { lapsed: true };
}

module.exports = {
  computeSellerConfirmationDueAt,
  computeInspectionPaymentDueAt,
  lapseInspectionAgreement,
};
