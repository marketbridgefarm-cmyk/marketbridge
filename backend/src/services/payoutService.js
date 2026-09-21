'use strict';

// ============================================================================
// PAYOUT SERVICE
// ============================================================================
//
// MarketBridge has no automated payout rail today — money for any of its
// three paid roles (seller, hired transporter, inspector) settles through
// Chapa into the platform's own merchant account, and getting it to that
// person's bank/mobile-money account has always been a fully manual,
// out-of-band step with nothing in the app tracking it. This service adds
// the smallest useful piece of an escrow-like workflow, without pretending
// to integrate a real payout provider, for all three roles paymentService.js
// pays: SELLER_EARNING, TRANSPORTER_EARNING, and INSPECTOR_EARNING.
//
//   HELD             -> created the moment the relevant payment settles
//                        PAID (buyer's MARKETPLACE payment for a seller,
//                        a hired-transport payment for a truck owner, an
//                        inspection payment for an inspector). A cool-off
//                        window (default 3 days, SELLER_PAYOUT_HOLD_DAYS —
//                        the env var name predates this generalization but
//                        governs the hold for all three roles) gives the
//                        paying party time to raise a dispute before money
//                        is confirmed releasable.
//   ON_HOLD_DISPUTE  -> a dispute was raised on the order while one or more
//                        of its payouts were still HELD or RELEASED (not
//                        yet paid out). Since a dispute is raised against
//                        the order as a whole, it freezes every payout tied
//                        to that order, not just the seller's. The
//                        auto-release job skips these; an admin has to look
//                        at the dispute outcome.
//   RELEASED         -> the hold window passed with no open dispute. This
//                        is a signal to MarketBridge's ops team that it is
//                        now safe to actually send this person their money
//                        (bank transfer, Telebirr, etc.) outside this
//                        system.
//   PAID_OUT         -> an admin has confirmed the out-of-band transfer
//                        happened and recorded a reference for it.
//   CANCELLED        -> an admin resolved a dispute against this payee and
//                        the held payout must never be released.
//
// This intentionally does NOT move money. It is a durable, auditable record
// of "is this person owed a payout, and is it safe to send it yet" — the
// same role paymentObligations plays for money coming IN, mirrored for
// money going OUT.
//
// One order can carry up to three Payout rows (its MARKETPLACE payment for
// the seller, its TRANSPORT payment for a hired truck owner, its INSPECTOR
// payment for an inspector) — see schema.prisma's Payout model for why
// orderId is not unique the way it was when this only covered sellers.
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
 * Create the payout hold for a payee (seller, transporter, or inspector)
 * once their payment has settled PAID. Must be called from inside the same
 * transaction as the settlement so the two can never disagree (a payment
 * can't exist as PAID without a corresponding hold, and vice versa).
 *
 * orderId is optional — an inspector payment on a pre-order inspection has
 * no order yet — but payeeRole/payeeId/payment are required.
 *
 * Idempotent: settlePayment can in principle be invoked more than once for
 * the same payment (retried webhook, etc.) — the unique constraint on
 * Payout.paymentId means a second attempt would violate it, so this checks
 * first rather than relying on the DB to throw.
 */
async function createPayoutHold(tx, { orderId, payeeRole, payeeId, payment }) {
  if (!payeeRole || !payeeId || !payment) return null;

  const existing = await tx.payout.findUnique({ where: { paymentId: payment.id } });
  if (existing) return existing;

  const amount = payment.netAmount != null ? payment.netAmount : payment.amount;

  return tx.payout.create({
    data: {
      orderId: orderId || null,
      payeeRole,
      payeeId,
      paymentId: payment.id,
      amount,
      currency: payment.currency || 'ETB',
      status: 'HELD',
      releaseAt: daysFromNow(holdDays()),
    },
  });
}

/**
 * Called when a dispute is raised on an order. A dispute targets the order
 * as a whole (not one specific payment), so it freezes every payout tied to
 * that order regardless of payee role or where each was in the
 * HELD -> RELEASED timeline. Payouts that are already PAID_OUT are left
 * alone — money is gone, and a dispute at that point is an operational
 * matter, not something this record can still gate. No-op if the order has
 * no payouts yet.
 */
async function holdForDispute(tx, { orderId, actorId }) {
  const payouts = await tx.payout.findMany({
    where: {
      orderId,
      status: { in: ['HELD', 'RELEASED'] },
    },
  });

  const updated = [];
  for (const payout of payouts) {
    const result = await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'ON_HOLD_DISPUTE' },
    });
    updated.push(result);

    await recordAuditEvent(tx, {
      actorId: actorId || null,
      action: 'PAYOUT_HELD_FOR_DISPUTE',
      resourceType: 'Payout',
      resourceId: payout.id,
      metadata: { orderId, payeeRole: payout.payeeRole, previousStatus: payout.status },
    });
  }

  return updated;
}

/**
 * Called when a dispute against an order resolves in a payee's favor.
 * Restarts the hold window for every payout on that order still frozen
 * from the dispute, rather than releasing immediately — the point of a
 * dispute-resolution restart is to give a very recently contested order a
 * fresh cool-off period, not to treat "resolved" as "immediately safe to
 * pay out".
 */
async function resumeAfterDispute(tx, { orderId, actorId }) {
  const payouts = await tx.payout.findMany({
    where: { orderId, status: 'ON_HOLD_DISPUTE' },
  });

  const updated = [];
  for (const payout of payouts) {
    const result = await tx.payout.update({
      where: { id: payout.id },
      data: {
        status: 'HELD',
        releaseAt: daysFromNow(holdDays()),
        releasedAt: null,
        paidOutAt: null,
        payoutReference: null,
      },
    });
    updated.push(result);

    await recordAuditEvent(tx, {
      actorId: actorId || null,
      action: 'PAYOUT_RESUMED_AFTER_DISPUTE',
      resourceType: 'Payout',
      resourceId: payout.id,
      metadata: { orderId, payeeRole: payout.payeeRole, holdDays: holdDays() },
    });
  }

  return updated;
}

/**
 * Cancel every disputed payout on an order when an admin resolves the
 * dispute against that payee. Keeping a terminal CANCELLED state is safer
 * than silently leaving a disputed payout frozen forever or accidentally
 * releasing it later.
 *
 * Note: a dispute resolution is a single admin decision made against the
 * order (see routes/disputes.js), so today this cancels every payout still
 * ON_HOLD_DISPUTE on the order together — there is no per-role dispute
 * outcome. If a dispute ever needs to clear a transporter but not the
 * seller (or vice versa), this is the place that assumption would need to
 * change.
 */
async function cancelAfterDispute(tx, { orderId, actorId }) {
  const payouts = await tx.payout.findMany({
    where: { orderId, status: 'ON_HOLD_DISPUTE' },
  });

  const updated = [];
  for (const payout of payouts) {
    const result = await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'CANCELLED' },
    });
    updated.push(result);

    await recordAuditEvent(tx, {
      actorId: actorId || null,
      action: 'PAYOUT_CANCELLED_AFTER_DISPUTE',
      resourceType: 'Payout',
      resourceId: payout.id,
      metadata: { orderId, payeeRole: payout.payeeRole },
    });
  }

  return updated;
}

/**
 * Called when an order is cancelled. Cancelling an order refunds the buyer,
 * so every payout on it that has not actually been paid out must be
 * cancelled too — otherwise releaseDuePayouts would later flip the still
 * HELD payout to RELEASED and ops could pay the seller for an order the
 * buyer was refunded for.
 *
 * PAID_OUT payouts are left alone (the money already left the platform;
 * recovering it is an operational matter this record can't gate), and so
 * are payouts that are already CANCELLED. Returns the payouts it cancelled.
 */
async function cancelPayoutsForOrder(tx, { orderId, actorId, reason }) {
  const payouts = await tx.payout.findMany({
    where: {
      orderId,
      status: { in: ['HELD', 'RELEASED', 'ON_HOLD_DISPUTE'] },
    },
  });

  const cancelled = [];
  for (const payout of payouts) {
    const result = await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'CANCELLED' },
    });
    cancelled.push(result);

    await recordAuditEvent(tx, {
      actorId: actorId || null,
      action: 'PAYOUT_CANCELLED_ORDER_CANCELLED',
      resourceType: 'Payout',
      resourceId: payout.id,
      metadata: {
        orderId,
        payeeRole: payout.payeeRole,
        previousStatus: payout.status,
        reason: reason || null,
      },
    });
  }

  return cancelled;
}

/**
 * Maintenance-cycle job: flip HELD -> RELEASED for anything past its
 * releaseAt with no open dispute. Does not touch ON_HOLD_DISPUTE or
 * PAID_OUT records. Role-agnostic by design — a seller, transporter, and
 * inspector payout all release on the same rule.
 */
async function releaseDuePayouts(prisma, now = new Date()) {
  const result = await prisma.payout.updateMany({
    where: { status: 'HELD', releaseAt: { lte: now } },
    data: { status: 'RELEASED', releasedAt: now },
  });
  return { released: result.count };
}

/**
 * Admin action: record that the actual out-of-band transfer to the payee
 * happened. Only valid from RELEASED — an admin should not be able to mark
 * a still-held or disputed payout as paid, since that's exactly the
 * premature-release scenario this whole feature exists to prevent. Works
 * the same regardless of payeeRole.
 */
async function markPaidOut(tx, { payoutId, actorId, payoutReference }) {
  const payout = await tx.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw Object.assign(new Error('Payout record not found'), { status: 404 });
  if (payout.status !== 'RELEASED') {
    throw Object.assign(
      new Error(`Payout is ${payout.status}; only a RELEASED payout can be marked paid out`),
      { status: 409 }
    );
  }

  const updated = await tx.payout.update({
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
    action: 'PAYOUT_PAID_OUT',
    resourceType: 'Payout',
    resourceId: payout.id,
    metadata: {
      orderId: payout.orderId,
      payeeRole: payout.payeeRole,
      payeeId: payout.payeeId,
      amount: payout.amount,
      payoutReference: payoutReference || null,
    },
  });

  return updated;
}

module.exports = {
  holdDays,
  createPayoutHold,
  holdForDispute,
  resumeAfterDispute,
  cancelAfterDispute,
  cancelPayoutsForOrder,
  releaseDuePayouts,
  markPaidOut,
};
