'use strict';

// ============================================================================
// SELLER PAYOUT SERVICE
// ============================================================================
//
// MarketBridge has no automated payout rail today — the buyer's MARKETPLACE
// payment settles through Chapa into the platform's own merchant account,
// and getting that money to the seller's bank/mobile-money account has
// always been a fully manual, out-of-band step with nothing in the app
// tracking it. This service adds the smallest useful piece of an escrow-like
// workflow without pretending to integrate a real payout provider:
//
//   HELD             -> created the moment the buyer's MARKETPLACE payment
//                        settles PAID. A cool-off window (default 3 days,
//                        SELLER_PAYOUT_HOLD_DAYS) gives a buyer time to raise
//                        a dispute before money is confirmed releasable.
//   ON_HOLD_DISPUTE  -> a dispute was raised on the order while the payout
//                        was still HELD or RELEASED (not yet paid out).
//                        The auto-release job skips these; an admin has to
//                        look at the dispute outcome.
//   RELEASED         -> the hold window passed with no open dispute. This
//                        is a signal to MarketBridge's ops team that it is
//                        now safe to actually send the seller their money
//                        (bank transfer, Telebirr, etc.) outside this system.
//   PAID_OUT         -> an admin has confirmed the out-of-band transfer
//                        happened and recorded a reference for it.
//
// This intentionally does NOT move money. It is a durable, auditable record
// of "is this seller owed a payout, and is it safe to send it yet" — the
// same role paymentObligations plays for money coming IN, mirrored for
// money going OUT.
// ============================================================================

const { recordAuditEvent } = require('../utils/audit');

const DEFAULT_HOLD_DAYS = 3;

function holdDays() {
  const raw = Number(process.env.SELLER_PAYOUT_HOLD_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_HOLD_DAYS;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Create the payout hold for a seller once their MARKETPLACE payment has
 * settled PAID. Must be called from inside the same transaction as the
 * settlement so the two can never disagree (a payment can't exist as PAID
 * without a corresponding hold, and vice versa).
 *
 * Idempotent: settlePayment can in principle be invoked more than once for
 * the same payment (retried webhook, etc.) — obligationId/id uniqueness on
 * Payment.payout means a second attempt would violate the unique
 * constraint, so this checks first rather than relying on the DB to throw.
 */
async function createPayoutHold(tx, { order, payment }) {
  if (!order || !payment) return null;

  const existing = await tx.sellerPayout.findUnique({ where: { paymentId: payment.id } });
  if (existing) return existing;

  const amount = payment.netAmount != null ? payment.netAmount : payment.amount;

  return tx.sellerPayout.create({
    data: {
      orderId: order.id,
      sellerId: order.sellerId,
      paymentId: payment.id,
      amount,
      currency: payment.currency || 'ETB',
      status: 'HELD',
      releaseAt: daysFromNow(holdDays()),
    },
  });
}

/**
 * Called when a dispute is raised on an order that already has a payout
 * record. Freezes it so the auto-release job leaves it alone regardless of
 * where it was in the HELD -> RELEASED timeline. No-op if there is no
 * payout yet (order not paid) or it is already PAID_OUT (money is gone;
 * a dispute at that point is an operational matter, not something this
 * record can still gate).
 */
async function holdForDispute(tx, { orderId, actorId }) {
  const payout = await tx.sellerPayout.findUnique({ where: { orderId } });
  if (!payout || payout.status === 'PAID_OUT' || payout.status === 'ON_HOLD_DISPUTE') return payout;

  const updated = await tx.sellerPayout.update({
    where: { id: payout.id },
    data: { status: 'ON_HOLD_DISPUTE' },
  });

  await recordAuditEvent(tx, {
    actorId: actorId || null,
    action: 'SELLER_PAYOUT_HELD_FOR_DISPUTE',
    resourceType: 'SellerPayout',
    resourceId: payout.id,
    metadata: { orderId, previousStatus: payout.status },
  });

  return updated;
}

/**
 * Called when a dispute against an order with a held payout resolves.
 * Restarts the hold window rather than releasing immediately — the point
 * of a dispute-resolution restart is to give a very recently contested
 * order a fresh cool-off period, not to treat "resolved" as "immediately
 * safe to pay out".
 */
async function resumeAfterDispute(tx, { orderId, actorId }) {
  const payout = await tx.sellerPayout.findUnique({ where: { orderId } });
  if (!payout || payout.status !== 'ON_HOLD_DISPUTE') return payout;

  const updated = await tx.sellerPayout.update({
    where: { id: payout.id },
    data: { status: 'HELD', releaseAt: daysFromNow(holdDays()) },
  });

  await recordAuditEvent(tx, {
    actorId: actorId || null,
    action: 'SELLER_PAYOUT_RESUMED_AFTER_DISPUTE',
    resourceType: 'SellerPayout',
    resourceId: payout.id,
    metadata: { orderId },
  });

  return updated;
}

/**
 * Maintenance-cycle job: flip HELD -> RELEASED for anything past its
 * releaseAt with no open dispute. Does not touch ON_HOLD_DISPUTE or
 * PAID_OUT records.
 */
async function releaseDuePayouts(prisma, now = new Date()) {
  const result = await prisma.sellerPayout.updateMany({
    where: { status: 'HELD', releaseAt: { lte: now } },
    data: { status: 'RELEASED', releasedAt: now },
  });
  return { released: result.count };
}

/**
 * Admin action: record that the actual out-of-band transfer to the seller
 * happened. Only valid from RELEASED — an admin should not be able to mark
 * a still-held or disputed payout as paid, since that's exactly the
 * premature-release scenario this whole feature exists to prevent.
 */
async function markPaidOut(tx, { payoutId, actorId, payoutReference }) {
  const payout = await tx.sellerPayout.findUnique({ where: { id: payoutId } });
  if (!payout) throw Object.assign(new Error('Payout record not found'), { status: 404 });
  if (payout.status !== 'RELEASED') {
    throw Object.assign(
      new Error(`Payout is ${payout.status}; only a RELEASED payout can be marked paid out`),
      { status: 409 }
    );
  }

  const updated = await tx.sellerPayout.update({
    where: { id: payout.id },
    data: {
      status: 'PAID_OUT',
      paidOutAt: new Date(),
      paidOutById: actorId,
      payoutReference: payoutReference || null,
    },
  });

  await recordAuditEvent(tx, {
    actorId,
    action: 'SELLER_PAYOUT_PAID_OUT',
    resourceType: 'SellerPayout',
    resourceId: payout.id,
    metadata: { orderId: payout.orderId, sellerId: payout.sellerId, amount: payout.amount, payoutReference: payoutReference || null },
  });

  return updated;
}

module.exports = {
  holdDays,
  createPayoutHold,
  holdForDispute,
  resumeAfterDispute,
  releaseDuePayouts,
  markPaidOut,
};
