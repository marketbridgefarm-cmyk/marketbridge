'use strict';

const prisma = require('../config/db');
const { recordAuditEvent } = require('../utils/audit');
const { syncOrderPaymentObligations, findPaymentObligation } = require('./paymentObligationService');
const { recordOrderEvent } = require('./orderEventService');
const { createReconciliationIssue } = require('./paymentReconciliationService');
const { assertTransition } = require('./paymentStateMachine');

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_STATUSES = ['PENDING', 'PAID', 'RECONCILIATION_REQUIRED'];
const TERMINAL_STATUSES = ['PAID', 'REFUNDED'];

// ============================================================================
// MONEY HELPERS
// ============================================================================

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

// ============================================================================
// COMMISSION CONFIGURATION
// ============================================================================

function envRate(name) {
  const number = Number(process.env[name] ?? 0);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > 100
  ) {
    return 0;
  }

  return number;
}

function commissionRateFor(type) {
  const rates = {
    MARKETPLACE: envRate('MARKETPLACE_COMMISSION_RATE'),
    TRANSPORT: envRate('TRANSPORT_COMMISSION_RATE'),
    INSPECTOR: envRate('INSPECTION_COMMISSION_RATE'),
    ADVERTISING: envRate('ADVERTISING_COMMISSION_RATE'),
    DIGITAL: envRate('DIGITAL_COMMISSION_RATE'),
  };

  return rates[type] ?? 0;
}

function commissionAmount(amount, rate) {
  return roundMoney(
    Number(amount) * Number(rate) / 100
  );
}

// ============================================================================
// CREATE PAYMENT
// ============================================================================

async function createPayment(data) {
  const amount = Number(data.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(
      new Error('Payment amount must be greater than zero'),
      { status: 400 }
    );
  }

  const rate =
    data.commissionRate ??
    commissionRateFor(data.type);

  const commission = commissionAmount(
    amount,
    rate
  );

  const netAmount = roundMoney(
    Math.max(0, amount - commission)
  );

  return prisma.$transaction(async (tx) => {
    let payment;
    let obligation = null;

    if (data.orderId) {
      await syncOrderPaymentObligations(tx, data.orderId);
      obligation = await findPaymentObligation(tx, data);
      if (obligation) {
        if (obligation.status === 'PAID') {
          throw Object.assign(new Error('This payment obligation is already paid'), { status: 409 });
        }
        if (!moneyEqual(amount, obligation.amount)) {
          throw Object.assign(new Error('Payment amount does not match the payment obligation'), { status: 409 });
        }
      }
    }

    try {
      payment = await tx.payment.create({
        data: {
          ...data,
          obligationId: obligation?.id || null,

          amount,

          currency:
            data.currency ||
            'ETB',

          commissionRate:
            rate,

          commissionAmount:
            commission,

          netAmount,

          status:
            'PENDING',
        },
      });
    } catch (error) {
      // Idempotency-Key race: two requests carrying the same key both got
      // past the route's pre-check and reached the create call at the same
      // time. The unique constraint on Payment.idempotencyKey lets exactly
      // one of them win; the loser returns the winner's row instead of
      // erroring, so the caller sees one consistent payment either way.
      if (error.code === 'P2002' && data.idempotencyKey) {
        const existing = await tx.payment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
        });
        if (existing) return existing;
      }
      throw error;
    }

    await recordAuditEvent(tx, {
      actorId: data.createdById || null,
      action: 'PAYMENT_CREATED',
      resourceType: 'Payment',
      resourceId: payment.id,
      metadata: {
        type: payment.type,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        orderId: payment.orderId,
        transportJobId: payment.transportJobId,
        digitalProductId: payment.digitalProductId,
        advertisementId: payment.advertisementId,
        inspectionRequestId: payment.inspectionRequestId,
      },
    });

    return payment;
  });
}

// ============================================================================
// LEDGER HELPERS
// ============================================================================

async function ledgerEntryExists(
  tx,
  paymentId,
  type
) {
  const existing =
    await tx.paymentLedgerEntry.findFirst({
      where: {
        paymentId,
        type,
      },
      select: {
        id: true,
      },
    });

  return !!existing;
}

async function createLedgerEntryOnce(
  tx,
  data
) {
  const exists =
    await ledgerEntryExists(
      tx,
      data.paymentId,
      data.type
    );

  if (exists) {
    return null;
  }

  return tx.paymentLedgerEntry.create({
    data,
  });
}

// ============================================================================
// WRITE FINANCIAL LEDGER
// ============================================================================

async function writeLedger(
  tx,
  payment,
  status
) {
  // --------------------------------------------------------------------------
  // PAID
  // --------------------------------------------------------------------------

  if (status === 'PAID') {
    const amount =
      Number(payment.amount);

    const commission =
      roundMoney(
        Number(payment.commissionAmount || 0)
      );

    const net =
      roundMoney(
        Math.max(
          0,
          amount - commission
        )
      );

    // ------------------------------------------------------------------------
    // MARKETPLACE
    // ------------------------------------------------------------------------

    if (
      payment.type === 'MARKETPLACE' &&
      payment.order
    ) {
      if (net > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId: payment.order.sellerId,
          type: 'SELLER_EARNING',
          amount: net,
          currency: payment.currency,
          description:
            'Seller earning from buyer marketplace payment',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description:
            'Marketplace seller transaction commission',
        });
      }

      return;
    }

    // ------------------------------------------------------------------------
    // TRANSPORT
    // ------------------------------------------------------------------------

    if (payment.type === 'TRANSPORT') {
      const job =
        payment.transportJob;

      // OWN_TRUCK has no transporter-hiring commission.
      if (
        job &&
        job.method === 'OWN_TRUCK'
      ) {
        return;
      }

      if (
        job &&
        job.method === 'HIRE_TRANSPORTER' &&
        job.truckOwnerId
      ) {
        if (net > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId: payment.id,
            userId: job.truckOwnerId,
            type: 'TRANSPORTER_EARNING',
            amount: net,
            currency: payment.currency,
            description:
              'Transporter earning from hired transport payment',
          });
        }

        if (commission > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId: payment.id,
            type: 'PLATFORM_COMMISSION',
            amount: commission,
            currency: payment.currency,
            description:
              'Hired transporter marketplace commission',
          });
        }
      }

      return;
    }

    // ------------------------------------------------------------------------
    // INSPECTOR
    // ------------------------------------------------------------------------

    if (
      payment.type === 'INSPECTOR' &&
      payment.inspectionRequest &&
      payment.inspectionRequest.inspectorId
    ) {
      if (net > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId:
            payment.inspectionRequest.inspectorId,
          type: 'INSPECTOR_EARNING',
          amount: net,
          currency: payment.currency,
          description:
            'Inspector service earning',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description:
            'Inspection marketplace commission',
        });
      }

      return;
    }

    // ------------------------------------------------------------------------
    // ADVERTISING
    // ------------------------------------------------------------------------

    if (
      payment.type === 'ADVERTISING'
    ) {
      await createLedgerEntryOnce(tx, {
        paymentId: payment.id,
        type: 'PLATFORM_REVENUE',
        amount,
        currency: payment.currency,
        description:
          'Advertising revenue',
      });

      return;
    }

    // ------------------------------------------------------------------------
    // DIGITAL
    // ------------------------------------------------------------------------

    if (
      payment.type === 'DIGITAL'
    ) {
      if (
        payment.digitalProduct &&
        payment.digitalProduct.sellerId &&
        net > 0
      ) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId:
            payment.digitalProduct.sellerId,
          type: 'SELLER_EARNING',
          amount: net,
          currency: payment.currency,
          description:
            'Digital seller earning',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description:
            'Digital marketplace commission',
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // REFUND
  // --------------------------------------------------------------------------

  if (status === 'REFUNDED') {
    await createLedgerEntryOnce(tx, {
      paymentId: payment.id,
      type: 'REFUND',
      amount: -Number(payment.amount),
      currency: payment.currency,
      description:
        'Payment refund record',
    });
  }
}

// ============================================================================
// SETTLE PAYMENT
// ============================================================================

async function settlePayment({
  paymentId,
  status,
  provider,
  providerTransactionId,
  reference,
  eventId,
  payload = {},
}) {
  return prisma.$transaction(async (tx) => {
    const payment =
      await tx.payment.findUnique({
        where: {
          id: paymentId,
        },

        include: {
          order: true,
          transportJob: true,
          inspectionRequest: true,
          advertisement: true,
          digitalPurchase: true,
          digitalProduct: true,
        },
      });

    if (!payment) {
      throw Object.assign(
        new Error('Payment not found'),
        { status: 404 }
      );
    }

    // ------------------------------------------------------------------------
    // AMOUNT VALIDATION
    // ------------------------------------------------------------------------

    if (
      payload.amount != null &&
      !moneyEqual(payment.amount, payload.amount)
    ) {
      await createReconciliationIssue(tx, {
        paymentId: payment.id, provider: provider || payment.provider || 'UNKNOWN',
        observedStatus: status, expectedAmount: payment.amount, observedAmount: payload.amount,
        expectedCurrency: payment.currency, observedCurrency: payload.currency || null,
        reason: 'PROVIDER_AMOUNT_MISMATCH', payload,
      });
      const flagged = await tx.payment.update({ where: { id: payment.id }, data: { status: 'RECONCILIATION_REQUIRED', provider: provider || payment.provider || null, providerTransactionId: providerTransactionId || payment.providerTransactionId || null, reference: reference || payment.reference || null } });
      await recordAuditEvent(tx, { actorId: null, action: 'PAYMENT_RECONCILIATION_REQUIRED', resourceType: 'Payment', resourceId: payment.id, metadata: { reason: 'PROVIDER_AMOUNT_MISMATCH', observedAmount: payload.amount, expectedAmount: payment.amount, eventId: eventId || null } });
      return flagged;
    }

    // ------------------------------------------------------------------------
    // CURRENCY VALIDATION
    // ------------------------------------------------------------------------

    if (payload.currency && String(payload.currency).toUpperCase() !== String(payment.currency).toUpperCase()) {
      await createReconciliationIssue(tx, {
        paymentId: payment.id, provider: provider || payment.provider || 'UNKNOWN', observedStatus: status,
        expectedAmount: payment.amount, observedAmount: payload.amount ?? null, expectedCurrency: payment.currency,
        observedCurrency: payload.currency, reason: 'PROVIDER_CURRENCY_MISMATCH', payload,
      });
      const flagged = await tx.payment.update({ where: { id: payment.id }, data: { status: 'RECONCILIATION_REQUIRED', provider: provider || payment.provider || null, providerTransactionId: providerTransactionId || payment.providerTransactionId || null, reference: reference || payment.reference || null } });
      await recordAuditEvent(tx, { actorId: null, action: 'PAYMENT_RECONCILIATION_REQUIRED', resourceType: 'Payment', resourceId: payment.id, metadata: { reason: 'PROVIDER_CURRENCY_MISMATCH', observedCurrency: payload.currency, expectedCurrency: payment.currency, eventId: eventId || null } });
      return flagged;
    }

    // ------------------------------------------------------------------------
    // IDEMPOTENT EVENT LOGGING
    // ------------------------------------------------------------------------

    if (eventId) {
      try {
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            provider:
              provider ||
              payment.provider ||
              'UNKNOWN',
            eventId,
            status,
            payload,
          },
        });
      } catch (error) {
        if (error.code === 'P2002') {
          return payment;
        }

        throw error;
      }
    }

    // Never reopen a refunded payment.
    if (
      payment.status === 'REFUNDED' &&
      status !== 'REFUNDED'
    ) {
      return payment;
    }

    // Never move PAID backwards to FAILED or reconciliation-required.
    if (
      payment.status === 'PAID' &&
      ['FAILED', 'RECONCILIATION_REQUIRED'].includes(status)
    ) {
      return payment;
    }

    // A reconciliation-required payment may only be resolved by an
    // authoritative settlement result, never by a client-created payment.
    if (
      payment.status === 'RECONCILIATION_REQUIRED' &&
      !['PAID', 'FAILED', 'REFUNDED', 'RECONCILIATION_REQUIRED'].includes(status)
    ) {
      return payment;
    }

    // ------------------------------------------------------------------------
    // STRICT PAYMENT STATE MACHINE
    // ------------------------------------------------------------------------
    // A verified provider success is allowed to advance PENDING -> PROCESSING
    // -> PAID in one database transaction. Clients/providers cannot skip the
    // lifecycle in any other direction.
    if (status === 'PAID' && payment.status === 'PENDING') {
      assertTransition(payment.status, 'PROCESSING');
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PROCESSING',
          provider: provider || payment.provider,
          providerTransactionId: providerTransactionId || payment.providerTransactionId,
          reference: reference || payment.reference,
        },
      });
    }

    const effectiveFromStatus = status === 'PAID' && payment.status === 'PENDING'
      ? 'PROCESSING'
      : payment.status;

    if (effectiveFromStatus !== status) {
      assertTransition(effectiveFromStatus, status);
    }

    // ------------------------------------------------------------------------
    // UPDATE PAYMENT
    // ------------------------------------------------------------------------

    const updated =
      await tx.payment.update({
        where: {
          id: payment.id,
        },

        data: {
          status,

          provider:
            provider ||
            payment.provider,

          providerTransactionId:
            providerTransactionId ||
            payment.providerTransactionId,

          reference:
            reference ||
            payment.reference,
        },
      });

    if (updated.obligationId) {
      await tx.paymentObligation.update({
        where: { id: updated.obligationId },
        data: {
          status: status === 'PAID'
            ? 'PAID'
            : status === 'REFUNDED'
              ? 'CANCELLED'
              : undefined,
        },
      });
    }

    if (updated.orderId) {
      await recordOrderEvent(tx, {
        orderId: updated.orderId,
        type: 'PAYMENT_STATUS_CHANGED',
        metadata: {
          paymentId: updated.id,
          paymentType: updated.type,
          fromStatus: effectiveFromStatus,
          toStatus: status,
          obligationId: updated.obligationId || null,
          amount: String(updated.amount),
        },
      });
    }

    await recordAuditEvent(tx, {
      actorId: null,
      action: 'PAYMENT_STATUS_CHANGED',
      resourceType: 'Payment',
      resourceId: payment.id,
      metadata: {
        fromStatus: effectiveFromStatus,
        toStatus: status,
        provider: provider || payment.provider || null,
        providerTransactionId: providerTransactionId || payment.providerTransactionId || null,
        reference: reference || payment.reference || null,
        eventId: eventId || null,
      },
    });

    // ------------------------------------------------------------------------
    // PAID BUSINESS EFFECTS
    // ------------------------------------------------------------------------

    if (status === 'PAID') {

      // Marketplace order
      if (
        payment.type === 'MARKETPLACE' &&
        payment.orderId
      ) {
        const orderClaim = await tx.order.updateMany({
          where: {
            id: payment.orderId,
            status: 'PENDING_PAYMENT',
          },

          data: {
            status: 'CONFIRMED',
          },
        });

        // orderClaim.count === 0 means the order was not in PENDING_PAYMENT
        // when this payment settled. That's harmless if it's already
        // CONFIRMED (an idempotent replay of the same PAID event, or a
        // second webhook for the same payment). It is NOT harmless if the
        // order is CANCELLED: that means the automatic unpaid-order expiry
        // (maintenanceService.expireUnpaidOrders) or a manual cancel raced
        // ahead of this payment and already released the reserved
        // quantity — possibly to another buyer. Money has now arrived for
        // an order marketplace considers dead, which is exactly the "money
        // received but state disagrees" case a strict state machine must
        // surface rather than silently swallow.
        if (orderClaim.count === 0) {
          const currentOrder = await tx.order.findUnique({
            where: { id: payment.orderId },
            select: { status: true },
          });

          if (currentOrder?.status === 'CANCELLED') {
            await createReconciliationIssue(tx, {
              paymentId: payment.id,
              provider: provider || payment.provider || 'UNKNOWN',
              observedStatus: status,
              expectedAmount: payment.amount,
              observedAmount: payload.amount ?? payment.amount,
              expectedCurrency: payment.currency,
              observedCurrency: payload.currency || payment.currency,
              reason: 'PAYMENT_RECEIVED_FOR_CANCELLED_ORDER',
              payload,
            });
            await recordAuditEvent(tx, {
              actorId: null,
              action: 'PAYMENT_RECONCILIATION_REQUIRED',
              resourceType: 'Payment',
              resourceId: payment.id,
              metadata: {
                reason: 'PAYMENT_RECEIVED_FOR_CANCELLED_ORDER',
                orderId: payment.orderId,
                eventId: eventId || null,
              },
            });
          }
        }
      }

      // Digital purchase
      if (
        payment.type === 'DIGITAL' &&
        payment.digitalPurchase
      ) {
        await tx.digitalPurchase.update({
          where: {
            id:
              payment.digitalPurchase.id,
          },

          data: {
            status: 'COMPLETED',
          },
        });
      }

      // Advertising
      if (
        payment.type === 'ADVERTISING' &&
        payment.advertisement
      ) {
        // BANNER campaigns carry free-form advertiser-uploaded creative
        // (image + headline) shown unmoderated on the public homepage —
        // unlike the other ad types, which only boost an already-existing,
        // already-moderated listing. Payment alone shouldn't be enough to
        // put arbitrary content on the site, so leave it PENDING for an
        // admin to actually look at and approve via PATCH /ads/:id/status.
        // Every other ad type keeps activating immediately on payment.
        const requiresModeration = ['BANNER', 'TELEGRAM_PROMOTION'].includes(payment.advertisement.type);
        const startsInFuture = new Date(payment.advertisement.startDate) > new Date();

        // Payment completion is not the same as publication. Listing-linked
        // placements can publish/schedule automatically after payment; Banner
        // and Telegram campaigns remain paid-but-unreviewed until an admin
        // approves them. This prevents paid arbitrary creative from becoming
        // public without moderation.
        const nextStatus = requiresModeration
          ? 'PAID_PENDING_REVIEW'
          : (startsInFuture ? 'SCHEDULED' : 'PUBLISHED');

        await tx.advertisement.update({
          where: {
            id: payment.advertisement.id,
          },

          data: {
            amountPaid: payment.amount,
            status: nextStatus,
            ...(nextStatus === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
          },
        });
      }

      // Financial allocation
      await writeLedger(
        tx,
        payment,
        'PAID'
      );
    }

    // ------------------------------------------------------------------------
    // REFUND BUSINESS EFFECTS
    // ------------------------------------------------------------------------

    if (status === 'REFUNDED') {
      if (payment.digitalPurchase) {
        await tx.digitalPurchase.update({
          where: {
            id:
              payment.digitalPurchase.id,
          },

          data: {
            status: 'REFUNDED',
          },
        });
      }

      await writeLedger(
        tx,
        payment,
        'REFUNDED'
      );
    }

    return updated;
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  moneyEqual,
  commissionRateFor,
  createPayment,
  settlePayment,
};
