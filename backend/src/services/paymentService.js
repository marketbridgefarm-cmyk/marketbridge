'use strict';

const prisma = require('../config/db');
const { Prisma } = require('@prisma/client');
const logger = require('../utils/logger');
const { recordAuditEvent } = require('../utils/audit');
const {
  syncOrderPaymentObligations,
  findPaymentObligation,
} = require('./paymentObligationService');
const { recordOrderEvent } = require('./orderEventService');
const {
  createReconciliationIssue,
} = require('./paymentReconciliationService');
const { transitionOrderStatus } = require('./orderStateMachine');
const { assertTransition: assertPaymentTransition } = require('./paymentStateMachine');
const { commitListingQuantity } = require('./inventoryService');
const payoutService = require('./payoutService');
const { releaseWaitingBidders } = require('./waitingListService');

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_STATUSES = [
  'PENDING',
  'PAID',
  'RECONCILIATION_REQUIRED',
];

const TERMINAL_STATUSES = [
  'PAID',
  'REFUNDED',
];

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

  // --------------------------------------------------------------------------
  // FAST IDEMPOTENCY LOOKUP
  // --------------------------------------------------------------------------

  if (data.idempotencyKey) {
    const existing = await prisma.payment.findUnique({
      where: {
        idempotencyKey: data.idempotencyKey,
      },
    });

    if (existing) {
      if (
        data.type === 'TRANSPORT' &&
        data.transportQuoteId &&
        existing.transportQuoteId !== data.transportQuoteId
      ) {
        throw Object.assign(
          new Error('This idempotency key is already bound to a different transport quote'),
          { status: 409 }
        );
      }
      return existing;
    }
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        let obligation = null;

        // --------------------------------------------------------------------
        // HIRED TRANSPORT PAYMENT INVARIANT
        // --------------------------------------------------------------------
        // Serialize payment creation with quote selection/replacement. The
        // transport job row is the shared lock for both workflows.
        if (data.type === 'TRANSPORT' && data.transportJobId) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "TransportJob" WHERE "id" = ${data.transportJobId} FOR UPDATE`
          );

          if (!data.transportQuoteId) {
            throw Object.assign(
              new Error('Hired transport payment must be bound to the accepted transport quote'),
              { status: 409 }
            );
          }

          const quote = await tx.transportQuote.findUnique({
            where: { id: data.transportQuoteId },
            select: {
              id: true,
              transportJobId: true,
              truckOwnerId: true,
              truckId: true,
              amount: true,
              status: true,
            },
          });

          const job = await tx.transportJob.findUnique({
            where: { id: data.transportJobId },
            select: {
              id: true,
              method: true,
              status: true,
              truckOwnerId: true,
              truckId: true,
              agreedAmount: true,
              buyerLoadingConfirmedAt: true,
              sellerPickupConfirmedAt: true,
              truckArrivedAt: true,
            },
          });

          if (!job || job.method !== 'HIRE_TRANSPORTER') {
            throw Object.assign(
              new Error('Transport payment requires a hired-transporter job'),
              { status: 409 }
            );
          }

          if (!quote || quote.transportJobId !== job.id || quote.status !== 'ACCEPTED') {
            throw Object.assign(
              new Error('The transport quote is no longer the accepted commercial quote'),
              { status: 409 }
            );
          }

          if (job.status !== 'ACCEPTED') {
            throw Object.assign(
              new Error('The transport arrangement is no longer ready for payment'),
              { status: 409, code: 'TRANSPORT_NOT_READY_FOR_PAYMENT' }
            );
          }

          // Physical-arrival gates: the seller must have confirmed goods
          // preparation and the truck must be on site. Loading and its buyer
          // approval come AFTER payment, not before.
          if (!job.sellerPickupConfirmedAt) {
            throw Object.assign(
              new Error('The seller must confirm loading preparation before transport payment can begin'),
              { status: 409, code: 'SELLER_LOADING_PREPARATION_REQUIRED' }
            );
          }

          if (!job.truckArrivedAt) {
            throw Object.assign(
              new Error('The truck must be physically on site before transport payment can begin'),
              { status: 409, code: 'TRUCK_ARRIVAL_REQUIRED' }
            );
          }

          if (
            job.truckOwnerId !== quote.truckOwnerId ||
            job.truckId !== quote.truckId ||
            !moneyEqual(job.agreedAmount, quote.amount) ||
            !moneyEqual(amount, quote.amount)
          ) {
            throw Object.assign(
              new Error('Transport payment amount or assignment does not match the accepted quote'),
              { status: 409 }
            );
          }
        }

        // --------------------------------------------------------------------
        // INSPECTION PAYMENT INVARIANT
        // --------------------------------------------------------------------
        // The seller must have confirmed the selected inspector and agreed
        // fee, AND confirmed the inspector physically arrived on site. The
        // reader-side gate lives in the workflow model; this is the
        // authoritative check.
        if (data.type === 'INSPECTOR' && data.inspectionRequestId) {
          const inspection = await tx.inspectionRequest.findUnique({
            where: { id: data.inspectionRequestId },
            select: {
              id: true,
              sellerConfirmedAt: true,
              inspectorOnSiteConfirmedAt: true,
              inspectorId: true,
            },
          });

          if (!inspection) {
            throw Object.assign(
              new Error('Inspection request not found'),
              { status: 404 }
            );
          }

          if (!inspection.sellerConfirmedAt) {
            throw Object.assign(
              new Error('The seller must confirm the selected inspector and agreed fee before inspection payment can begin'),
              { status: 409, code: 'INSPECTION_SELLER_CONFIRMATION_REQUIRED' }
            );
          }

          if (!inspection.inspectorOnSiteConfirmedAt) {
            throw Object.assign(
              new Error('The seller must confirm the inspector is on site and ready to start before inspection payment can begin'),
              { status: 409, code: 'INSPECTOR_ARRIVAL_CONFIRMATION_REQUIRED' }
            );
          }
        }

        // --------------------------------------------------------------------
        // PAYMENT OBLIGATION
        // --------------------------------------------------------------------

        if (data.orderId) {
          await syncOrderPaymentObligations(
            tx,
            data.orderId
          );

          obligation = await findPaymentObligation(
            tx,
            { ...data, payerId: data.createdById }
          );

          if (obligation) {
            if (obligation.status === 'PAID') {
              throw Object.assign(
                new Error(
                  'This payment obligation is already paid'
                ),
                { status: 409 }
              );
            }

            if (
              !moneyEqual(
                amount,
                obligation.amount
              )
            ) {
              throw Object.assign(
                new Error(
                  'Payment amount does not match the payment obligation'
                ),
                { status: 409 }
              );
            }
          }
        }

        // --------------------------------------------------------------------
        // CREATE PAYMENT
        //
        // IMPORTANT:
        // Do NOT catch P2002 inside this transaction.
        //
        // PostgreSQL marks the transaction as aborted after a unique
        // constraint violation. Any query after that produces:
        //
        // "current transaction is aborted, commands ignored until end
        //  of transaction block"
        //
        // The P2002 is handled AFTER Prisma rolls the transaction back.
        // --------------------------------------------------------------------

        const payment = await tx.payment.create({
          data: {
            ...data,

            obligationId:
              obligation?.id || null,

            amount,

            currency:
              data.currency || 'ETB',

            commissionRate:
              rate,

            commissionAmount:
              commission,

            netAmount,

            status:
              'PENDING',
          },
        });

        // --------------------------------------------------------------------
        // AUDIT
        // --------------------------------------------------------------------

        await recordAuditEvent(tx, {
          actorId:
            data.createdById || null,

          action:
            'PAYMENT_CREATED',

          resourceType:
            'Payment',

          resourceId:
            payment.id,

          metadata: {
            type:
              payment.type,

            amount:
              payment.amount,

            currency:
              payment.currency,

            method:
              payment.method,

            orderId:
              payment.orderId,

            transportJobId:
              payment.transportJobId,

            digitalProductId:
              payment.digitalProductId,

            advertisementId:
              payment.advertisementId,

            inspectionRequestId:
              payment.inspectionRequestId,
          },
        });

        return payment;
      },
      {
        maxWait: 10000,
        timeout: 20000,
      }
    );
  } catch (error) {
    // ------------------------------------------------------------------------
    // IDEMPOTENCY RACE
    // ------------------------------------------------------------------------

    const target = error?.meta?.target;

    const isTransportActivePaymentConflict =
      error?.code === 'P2002' &&
      data.type === 'TRANSPORT' &&
      data.transportJobId &&
      String(target || '').includes('Payment_transportJob_active_unique');

    if (isTransportActivePaymentConflict) {
      const existingTransportPayment = await prisma.payment.findFirst({
        where: {
          transportJobId: data.transportJobId,
          type: 'TRANSPORT',
          status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
        },
      });

      if (existingTransportPayment) {
        if (
          data.transportQuoteId &&
          existingTransportPayment.transportQuoteId === data.transportQuoteId
        ) {
          return existingTransportPayment;
        }

        throw Object.assign(
          new Error('An active transport payment already exists for a different transporter quote'),
          { status: 409 }
        );
      }
    }

    const isIdempotencyConflict =
      error?.code === 'P2002' &&
      data.idempotencyKey &&
      (
        !target ||
        (
          Array.isArray(target) &&
          target.includes('idempotencyKey')
        ) ||
        target === 'idempotencyKey'
      );

    if (isIdempotencyConflict) {
      const existing =
        await prisma.payment.findUnique({
          where: {
            idempotencyKey:
              data.idempotencyKey,
          },
        });

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
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
        Number(
          payment.commissionAmount || 0
        )
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
          paymentId:
            payment.id,

          userId:
            payment.order.sellerId,

          type:
            'SELLER_EARNING',

          amount:
            net,

          currency:
            payment.currency,

          description:
            'Seller earning from buyer marketplace payment',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId:
            payment.id,

          type:
            'PLATFORM_COMMISSION',

          amount:
            commission,

          currency:
            payment.currency,

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

      // Own truck does not generate transporter-hiring commission.
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
        const transportPayeeId = payment.transportQuote?.truckOwnerId || job.truckOwnerId;

        if (net > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId:
              payment.id,

            userId:
              transportPayeeId,

            type:
              'TRANSPORTER_EARNING',

            amount:
              net,

            currency:
              payment.currency,

            description:
              'Transporter earning from hired transport payment',
          });
        }

        if (commission > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId:
              payment.id,

            type:
              'PLATFORM_COMMISSION',

            amount:
              commission,

            currency:
              payment.currency,

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
          paymentId:
            payment.id,

          userId:
            payment.inspectionRequest.inspectorId,

          type:
            'INSPECTOR_EARNING',

          amount:
            net,

          currency:
            payment.currency,

          description:
            'Inspector service earning',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId:
            payment.id,

          type:
            'PLATFORM_COMMISSION',

          amount:
            commission,

          currency:
            payment.currency,

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
        paymentId:
          payment.id,

        type:
          'PLATFORM_REVENUE',

        amount,

        currency:
          payment.currency,

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
          paymentId:
            payment.id,

          userId:
            payment.digitalProduct.sellerId,

          type:
            'SELLER_EARNING',

          amount:
            net,

          currency:
            payment.currency,

          description:
            'Digital seller earning',
        });
      }

      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId:
            payment.id,

          type:
            'PLATFORM_COMMISSION',

          amount:
            commission,

          currency:
            payment.currency,

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
      paymentId:
        payment.id,

      type:
        'REFUND',

      amount:
        -Number(payment.amount),

      currency:
        payment.currency,

      description:
        'Payment refund record',
    });
  }
}

// ============================================================================
// SETTLE PAYMENT CORE
// ============================================================================

async function settlePaymentCore({
  paymentId,
  status,
  provider,
  providerTransactionId,
  reference,
  eventId,
  payload = {},
}) {
  return prisma.$transaction(
    async (tx) => {
      const payment =
        await tx.payment.findUnique({
          where: {
            id: paymentId,
          },

          include: {
            order: true,
            transportJob: true,
            transportQuote: true,
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

      // ----------------------------------------------------------------------
      // PROVIDER AMOUNT VALIDATION
      // ----------------------------------------------------------------------
      if (status === 'PAID' && payload.amount == null) {
        await createReconciliationIssue(tx, {
          paymentId: payment.id,
          provider: provider || payment.provider || 'UNKNOWN',
          observedStatus: status,
          expectedAmount: payment.amount,
          observedAmount: null,
          expectedCurrency: payment.currency,
          observedCurrency: payload.currency || null,
          reason: 'PROVIDER_AMOUNT_MISSING',
          payload,
        });

        try {
          assertPaymentTransition(payment.status, 'RECONCILIATION_REQUIRED');
        } catch (_) {
          return payment;
        }

        return tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'RECONCILIATION_REQUIRED',
            provider: provider || payment.provider || null,
            providerTransactionId: providerTransactionId || payment.providerTransactionId || null,
            reference: reference || payment.reference || null,
          },
        });
      }

      if (
        status === 'PAID' &&
        payload.amount != null &&
        !moneyEqual(
          payment.amount,
          payload.amount
        )
      ) {
        await createReconciliationIssue(tx, {
          paymentId:
            payment.id,

          provider:
            provider ||
            payment.provider ||
            'UNKNOWN',

          observedStatus:
            status,

          expectedAmount:
            payment.amount,

          observedAmount:
            payload.amount,

          expectedCurrency:
            payment.currency,

          observedCurrency:
            payload.currency ||
            null,

          reason:
            'PROVIDER_AMOUNT_MISMATCH',

          payload,
        });

        try {
          assertPaymentTransition(payment.status, 'RECONCILIATION_REQUIRED');
        } catch (_) {
          return payment;
        }

        const flagged =
          await tx.payment.update({
            where: {
              id:
                payment.id,
            },

            data: {
              status:
                'RECONCILIATION_REQUIRED',

              provider:
                provider ||
                payment.provider ||
                null,

              providerTransactionId:
                providerTransactionId ||
                payment.providerTransactionId ||
                null,

              reference:
                reference ||
                payment.reference ||
                null,
            },
          });

        await recordAuditEvent(tx, {
          actorId:
            null,

          action:
            'PAYMENT_RECONCILIATION_REQUIRED',

          resourceType:
            'Payment',

          resourceId:
            payment.id,

          metadata: {
            reason:
              'PROVIDER_AMOUNT_MISMATCH',

            observedAmount:
              payload.amount,

            expectedAmount:
              payment.amount,

            eventId:
              eventId ||
              null,
          },
        });

        return flagged;
      }

      // ----------------------------------------------------------------------
      // PROVIDER CURRENCY VALIDATION
      // ----------------------------------------------------------------------

      if (
        payload.currency &&
        String(payload.currency).toUpperCase() !==
          String(payment.currency).toUpperCase()
      ) {
        await createReconciliationIssue(tx, {
          paymentId:
            payment.id,

          provider:
            provider ||
            payment.provider ||
            'UNKNOWN',

          observedStatus:
            status,

          expectedAmount:
            payment.amount,

          observedAmount:
            payload.amount ??
            null,

          expectedCurrency:
            payment.currency,

          observedCurrency:
            payload.currency,

          reason:
            'PROVIDER_CURRENCY_MISMATCH',

          payload,
        });

        try {
          assertPaymentTransition(payment.status, 'RECONCILIATION_REQUIRED');
        } catch (_) {
          return payment;
        }

        const flagged =
          await tx.payment.update({
            where: {
              id:
                payment.id,
            },

            data: {
              status:
                'RECONCILIATION_REQUIRED',

              provider:
                provider ||
                payment.provider ||
                null,

              providerTransactionId:
                providerTransactionId ||
                payment.providerTransactionId ||
                null,

              reference:
                reference ||
                payment.reference ||
                null,
            },
          });

        await recordAuditEvent(tx, {
          actorId:
            null,

          action:
            'PAYMENT_RECONCILIATION_REQUIRED',

          resourceType:
            'Payment',

          resourceId:
            payment.id,

          metadata: {
            reason:
              'PROVIDER_CURRENCY_MISMATCH',

            observedCurrency:
              payload.currency,

            expectedCurrency:
              payment.currency,

            eventId:
              eventId ||
              null,
          },
        });

        return flagged;
      }

      // ----------------------------------------------------------------------
      // IDEMPOTENT PROVIDER EVENT
      // ----------------------------------------------------------------------

      if (eventId) {
        const existingEvent =
          await tx.paymentEvent.findFirst({
            where: {
              eventId,
            },

            select: {
              id: true,
              paymentId: true,
            },
          });

        if (existingEvent) {
          if (
            existingEvent.paymentId ===
            payment.id
          ) {
            return payment;
          }

          throw Object.assign(
            new Error(
              'Payment provider event is already associated with another payment'
            ),
            {
              status: 409,
              code: 'PAYMENT_EVENT_CONFLICT',
            }
          );
        }

        const eventInsert =
          await tx.paymentEvent.createMany({
            data: [
              {
                paymentId:
                  payment.id,

                provider:
                  provider ||
                  payment.provider ||
                  'UNKNOWN',

                eventId,

                status,

                payload,
              },
            ],

            skipDuplicates: true,
          });

        if (eventInsert.count === 0) {
          const concurrentEvent =
            await tx.paymentEvent.findFirst({
              where: {
                eventId,
              },

              select: {
                id: true,
                paymentId: true,
              },
            });

          if (
            concurrentEvent &&
            concurrentEvent.paymentId ===
              payment.id
          ) {
            return payment;
          }

          if (concurrentEvent) {
            throw Object.assign(
              new Error(
                'Payment provider event is already associated with another payment'
              ),
              {
                status: 409,
                code:
                  'PAYMENT_EVENT_CONFLICT',
              }
            );
          }
        }
      }

      // ----------------------------------------------------------------------
      // PAYMENT STATE GUARDS
      // ----------------------------------------------------------------------

      if (
        payment.status === 'REFUNDED' &&
        status !== 'REFUNDED'
      ) {
        return payment;
      }

      if (
        payment.status === 'PAID' &&
        [
          'FAILED',
          'RECONCILIATION_REQUIRED',
        ].includes(status)
      ) {
        return payment;
      }

      if (
        payment.status ===
          'RECONCILIATION_REQUIRED' &&
        ![
          'PAID',
          'FAILED',
          'REFUNDED',
          'RECONCILIATION_REQUIRED',
        ].includes(status)
      ) {
        return payment;
      }

      // ----------------------------------------------------------------------
      // UPDATE PAYMENT
      // ----------------------------------------------------------------------

      const updated =
        await tx.payment.update({
          where: {
            id:
              payment.id,
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

      // ----------------------------------------------------------------------
      // PAYMENT OBLIGATION
      // ----------------------------------------------------------------------

      if (updated.obligationId) {
        const currentObligationId = updated.obligationId;
        if (status === 'FAILED') {
          await tx.paymentObligation.update({
            where: { id: currentObligationId },
            data: { status: 'OPEN' },
          });
          await tx.payment.update({
            where: { id: updated.id },
            data: { obligationId: null },
          });
          updated.obligationId = null;
        } else {
          await tx.paymentObligation.update({
            where: { id: currentObligationId },
            data: {
              status:
                status === 'PAID'
                  ? 'PAID'
                  : status === 'REFUNDED'
                    ? 'CANCELLED'
                    : undefined,
            },
          });
        }
      }

      // ----------------------------------------------------------------------
      // ORDER EVENT
      // ----------------------------------------------------------------------

      if (updated.orderId) {
        try {
          await recordOrderEvent(tx, {
            orderId:
              updated.orderId,

            type:
              'PAYMENT_STATUS_CHANGED',

            metadata: {
              paymentId:
                updated.id,

              paymentType:
                updated.type,

              fromStatus:
                payment.status,

              toStatus:
                status,

              obligationId:
                updated.obligationId ||
                null,

              amount:
                String(updated.amount),
            },
          });
        } catch (error) {
          logger.error(
            {
              err:
                error,

              paymentId:
                updated.id,

              orderId:
                updated.orderId,
            },
            'settlePayment: recordOrderEvent/notification side effect failed; continuing with payment settlement'
          );
        }
      }

      // ----------------------------------------------------------------------
      // AUDIT
      // ----------------------------------------------------------------------

      await recordAuditEvent(tx, {
        actorId:
          null,

        action:
          'PAYMENT_STATUS_CHANGED',

        resourceType:
          'Payment',

        resourceId:
          payment.id,

        metadata: {
          fromStatus:
            payment.status,

          toStatus:
            status,

          provider:
            provider ||
            payment.provider ||
            null,

          providerTransactionId:
            providerTransactionId ||
            payment.providerTransactionId ||
            null,

          reference:
            reference ||
            payment.reference ||
            null,

          eventId:
            eventId ||
            null,
        },
      });

      // ----------------------------------------------------------------------
      // PAID BUSINESS EFFECTS
      // ----------------------------------------------------------------------

      if (status === 'PAID' && payment.orderId && payment.order?.status === 'DISPUTED') {
        await writeLedger(tx, payment, 'PAID');
        await createReconciliationIssue(tx, {
          paymentId: payment.id,
          provider: provider || payment.provider || 'UNKNOWN',
          observedStatus: status,
          expectedAmount: payment.amount,
          observedAmount: payload.amount,
          expectedCurrency: payment.currency,
          observedCurrency: payload.currency || null,
          reason: 'PAYMENT_RECEIVED_WHILE_ORDER_DISPUTED',
          payload,
        });
        return updated;
      }

      if (status === 'PAID') {
        // --------------------------------------------------------------------
        // MARKETPLACE ORDER
        // --------------------------------------------------------------------

        if (
          payment.type === 'MARKETPLACE' &&
          payment.orderId
        ) {
          let orderClaim = {
            count: 0,
          };

          const currentOrder =
            await tx.order.findUnique({
              where: {
                id:
                  payment.orderId,
              },

              select: {
                status:
                  true,
              },
            });

          if (
            currentOrder?.status ===
            'PENDING_PAYMENT'
          ) {
            if (payment.order?.listingId) {
              const listing = await tx.listing.findUnique({
                where: { id: payment.order.listingId },
                select: { id: true, category: true },
              });
              if (['AGRICULTURAL', 'PRODUCT'].includes(listing?.category)) {
                await commitListingQuantity(
                  tx,
                  payment.order.listingId,
                  payment.order.quantity
                );
              }
            }

            await transitionOrderStatus(
              tx,
              payment.orderId,
              'PENDING_PAYMENT',
              'CONFIRMED'
            );

            orderClaim = {
              count: 1,
            };

            await payoutService.createPayoutHold(tx, {
              orderId: payment.order.id,
              payeeRole: 'SELLER',
              payeeId: payment.order.sellerId,
              payment,
            });
          }

          if (orderClaim.count === 0) {
            const orderAfterAttempt =
              await tx.order.findUnique({
                where: {
                  id:
                    payment.orderId,
                },

                select: {
                  status:
                    true,
                },
              });

            if (
              orderAfterAttempt?.status ===
              'CANCELLED'
            ) {
              await createReconciliationIssue(
                tx,
                {
                  paymentId:
                    payment.id,

                  provider:
                    provider ||
                    payment.provider ||
                    'UNKNOWN',

                  observedStatus:
                    status,

                  expectedAmount:
                    payment.amount,

                  observedAmount:
                    payload.amount ??
                    payment.amount,

                  expectedCurrency:
                    payment.currency,

                  observedCurrency:
                    payload.currency ||
                    payment.currency,

                  reason:
                    'PAYMENT_RECEIVED_FOR_CANCELLED_ORDER',

                  payload,
                }
              );

              await recordAuditEvent(
                tx,
                {
                  actorId:
                    null,

                  action:
                    'PAYMENT_RECONCILIATION_REQUIRED',

                  resourceType:
                    'Payment',

                  resourceId:
                    payment.id,

                  metadata: {
                    reason:
                      'PAYMENT_RECEIVED_FOR_CANCELLED_ORDER',

                    orderId:
                      payment.orderId,

                    eventId:
                      eventId ||
                      null,
                  },
                }
              );
            }
          }
        }

        // --------------------------------------------------------------------
        // HIRED TRANSPORT COMMITMENT
        // --------------------------------------------------------------------
        if (
          payment.type === 'TRANSPORT' &&
          payment.transportJob &&
          payment.transportJob.method === 'HIRE_TRANSPORTER' &&
          payment.transportJob.truckId &&
          payment.transportJob.truckOwnerId &&
          payment.transportQuote
        ) {
          const job = await tx.transportJob.findUnique({
            where: { id: payment.transportJob.id },
            select: { id: true, status: true, truckId: true, truckOwnerId: true, agreedAmount: true, orderId: true },
          });

          if (!job || !['REQUESTED', 'QUOTED', 'ACCEPTED'].includes(job.status)) {
            throw Object.assign(new Error('Transport job is no longer available for payment commitment'), { status: 409 });
          }

          if (
            payment.transportQuote.transportJobId !== job.id ||
            payment.transportQuote.status !== 'ACCEPTED' ||
            payment.transportQuote.truckId !== job.truckId ||
            payment.transportQuote.truckOwnerId !== job.truckOwnerId ||
            !moneyEqual(payment.transportQuote.amount, job.agreedAmount) ||
            !moneyEqual(payment.amount, payment.transportQuote.amount)
          ) {
            throw Object.assign(
              new Error('Transport payment is no longer aligned with its accepted quote'),
              { status: 409 }
            );
          }

          if (job.status !== 'ACCEPTED') {
            const truckClaim = await tx.truck.updateMany({
              where: { id: job.truckId, availability: 'AVAILABLE' },
              data: { availability: 'BUSY' },
            });
            if (truckClaim.count !== 1) {
              throw Object.assign(new Error('The selected truck is no longer available'), { status: 409 });
            }
          } else {
            const truck = await tx.truck.findUnique({
              where: { id: job.truckId },
              select: { id: true, availability: true },
            });
            if (!truck) {
              throw Object.assign(new Error('The selected truck no longer exists'), { status: 409 });
            }
            if (truck.availability === 'AVAILABLE') {
              await tx.truck.update({ where: { id: truck.id }, data: { availability: 'BUSY' } });
            } else if (truck.availability === 'BUSY') {
              const conflictingJob = await tx.transportJob.findFirst({
                where: {
                  id: { not: job.id },
                  truckId: job.truckId,
                  status: { in: ['ACCEPTED', 'PICKUP', 'IN_TRANSIT'] },
                },
                select: { id: true },
              });
              if (conflictingJob) {
                throw Object.assign(new Error('The selected truck is committed to another active transport job'), { status: 409 });
              }
            } else {
              throw Object.assign(new Error('The selected truck is no longer available'), { status: 409 });
            }
          }

          await tx.transportJob.update({
            where: { id: job.id },
            data: { status: 'ACCEPTED' },
          });

          await tx.transportQuote.updateMany({
            where: {
              transportJobId: job.id,
              status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] },
            },
            data: { status: 'REJECTED' },
          });

          const order = await tx.order.findUnique({ where: { id: job.orderId }, select: { id: true, status: true } });
          if (order?.status === 'CONFIRMED') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'TRANSPORT_ARRANGED' } });
          }
        }

        // --------------------------------------------------------------------
        // INSPECTION COMMITMENT
        // --------------------------------------------------------------------
        if (
          payment.type === 'INSPECTOR' &&
          payment.inspectionRequest &&
          payment.inspectionRequest.inspectorId
        ) {
          const request = await tx.inspectionRequest.findUnique({
            where: { id: payment.inspectionRequest.id },
            select: { id: true, status: true, inspectorId: true },
          });
          if (!request || !['REQUESTED', 'ACCEPTED'].includes(request.status)) {
            throw Object.assign(new Error('Inspection is no longer available for payment commitment'), { status: 409 });
          }

          await tx.inspectionRequest.update({
            where: { id: request.id },
            data: { status: 'ACCEPTED' },
          });

          await tx.inspectionQuote.updateMany({
            where: {
              inspectionRequestId: request.id,
              status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] },
            },
            data: { status: 'REJECTED' },
          });
        }

        // --------------------------------------------------------------------
        // HIRED TRANSPORT PAYOUT HOLD
        // --------------------------------------------------------------------

        if (
          payment.type === 'TRANSPORT' &&
          payment.transportJob &&
          payment.transportJob.method === 'HIRE_TRANSPORTER' &&
          payment.transportJob.truckOwnerId
        ) {
          await payoutService.createPayoutHold(tx, {
            orderId: payment.transportJob.orderId,
            payeeRole: 'TRANSPORTER',
            payeeId: payment.transportQuote?.truckOwnerId || payment.transportJob.truckOwnerId,
            payment,
          });
        }

        // --------------------------------------------------------------------
        // INSPECTION PAYOUT HOLD
        // --------------------------------------------------------------------

        if (
          payment.type === 'INSPECTOR' &&
          payment.inspectionRequest &&
          payment.inspectionRequest.inspectorId
        ) {
          await payoutService.createPayoutHold(tx, {
            orderId: payment.inspectionRequest.orderId,
            payeeRole: 'INSPECTOR',
            payeeId: payment.inspectionRequest.inspectorId,
            payment,
          });
        }

        // --------------------------------------------------------------------
        // DIGITAL PURCHASE
        // --------------------------------------------------------------------

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
              status:
                'COMPLETED',
            },
          });
        }

        // --------------------------------------------------------------------
        // ADVERTISING
        // --------------------------------------------------------------------

        if (
          payment.type === 'ADVERTISING' &&
          payment.advertisement
        ) {
          const requiresModeration =
            [
              'BANNER',
              'TELEGRAM_PROMOTION',
            ].includes(
              payment.advertisement.type
            );

          const startsInFuture =
            new Date(
              payment.advertisement.startDate
            ) > new Date();

          const nextStatus =
            requiresModeration
              ? 'PAID_PENDING_REVIEW'
              : (
                  startsInFuture
                    ? 'SCHEDULED'
                    : 'PUBLISHED'
                );

          await tx.advertisement.update({
            where: {
              id:
                payment.advertisement.id,
            },

            data: {
              amountPaid:
                payment.amount,

              status:
                nextStatus,

              ...(nextStatus === 'PUBLISHED'
                ? {
                    publishedAt:
                      new Date(),
                  }
                : {}),
            },
          });
        }

        // --------------------------------------------------------------------
        // FINANCIAL LEDGER
        // --------------------------------------------------------------------

        await writeLedger(
          tx,
          payment,
          'PAID'
        );
      }

      // ----------------------------------------------------------------------
      // REFUND BUSINESS EFFECTS
      // ----------------------------------------------------------------------

      if (status === 'REFUNDED') {
        if (payment.digitalPurchase) {
          await tx.digitalPurchase.update({
            where: {
              id:
                payment.digitalPurchase.id,
            },

            data: {
              status:
                'REFUNDED',
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
    },
    {
      maxWait: 10000,
      timeout: 20000,
    }
  );
}

// ============================================================================
// REPLAY DISPUTED PAID PAYMENT
// ============================================================================

async function replayDisputedPaidPayment(tx, paymentId) {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: true,
      transportJob: true,
      transportQuote: true,
      inspectionRequest: true,
    },
  });
  if (!payment || payment.status !== 'PAID') return payment;
  if (!payment.orderId || !payment.order) return payment;

  if (payment.type === 'MARKETPLACE') {
    if (payment.order.status === 'PENDING_PAYMENT') {
      if (payment.order.listingId) {
        const listing = await tx.listing.findUnique({
          where: { id: payment.order.listingId },
          select: { id: true, category: true },
        });
        if (['AGRICULTURAL', 'PRODUCT'].includes(listing?.category)) {
          await commitListingQuantity(tx, listing.id, payment.order.quantity);
        }
      }

      await transitionOrderStatus(tx, payment.orderId, 'PENDING_PAYMENT', 'CONFIRMED');
    }

    await payoutService.createPayoutHold(tx, {
      orderId: payment.order.id,
      payeeRole: 'SELLER',
      payeeId: payment.order.sellerId,
      payment,
    });
  }

  if (
    payment.type === 'TRANSPORT' &&
    payment.transportJob?.method === 'HIRE_TRANSPORTER' &&
    payment.transportJob.truckOwnerId
  ) {
    const job = await tx.transportJob.findUnique({
      where: { id: payment.transportJob.id },
      select: { id: true, status: true, truckId: true, truckOwnerId: true, agreedAmount: true, orderId: true },
    });
    if (job && ['REQUESTED', 'QUOTED', 'ACCEPTED'].includes(job.status)) {
      const quote = payment.transportQuote;
      if (quote?.status === 'ACCEPTED' && quote.truckId === job.truckId && quote.truckOwnerId === job.truckOwnerId) {
        if (job.truckId) {
          await tx.truck.updateMany({
            where: { id: job.truckId, availability: 'AVAILABLE' },
            data: { availability: 'BUSY' },
          });
        }
        await tx.transportJob.update({
          where: { id: job.id },
          data: { status: 'ACCEPTED' },
        });
        await tx.transportQuote.updateMany({
          where: { transportJobId: job.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } },
          data: { status: 'REJECTED' },
        });
        const order = await tx.order.findUnique({ where: { id: job.orderId }, select: { id: true, status: true } });
        if (order?.status === 'CONFIRMED') {
          await transitionOrderStatus(tx, order.id, 'CONFIRMED', 'TRANSPORT_ARRANGED');
        }
      }
    }

    await payoutService.createPayoutHold(tx, {
      orderId: payment.transportJob.orderId,
      payeeRole: 'TRANSPORTER',
      payeeId: payment.transportQuote?.truckOwnerId || payment.transportJob.truckOwnerId,
      payment,
    });
  }

  if (
    payment.type === 'INSPECTOR' &&
    payment.inspectionRequest?.inspectorId
  ) {
    const request = await tx.inspectionRequest.findUnique({
      where: { id: payment.inspectionRequest.id },
      select: { id: true, status: true, inspectorId: true },
    });
    if (request && ['REQUESTED', 'ACCEPTED'].includes(request.status)) {
      await tx.inspectionRequest.update({
        where: { id: request.id },
        data: { status: 'ACCEPTED' },
      });
      await tx.inspectionQuote.updateMany({
        where: { inspectionRequestId: request.id, status: { in: ['PENDING', 'SELECTED', 'COUNTERED'] } },
        data: { status: 'REJECTED' },
      });
    }
    await payoutService.createPayoutHold(tx, {
      orderId: payment.inspectionRequest.orderId,
      payeeRole: 'INSPECTOR',
      payeeId: payment.inspectionRequest.inspectorId,
      payment,
    });
  }

  return payment;
}

// ============================================================================
// SETTLE PAYMENT (public entry point)
// ============================================================================

async function settlePayment(args) {
  let result;
  try {
    result = await settlePaymentCore(args);
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_INVENTORY' && args?.status === 'PAID' && args?.paymentId) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const payment = await tx.payment.findUnique({ where: { id: args.paymentId } });
          if (!payment) throw error;

          if (payment.status !== 'RECONCILIATION_REQUIRED') {
            assertPaymentTransition(payment.status, 'RECONCILIATION_REQUIRED');
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                status: 'RECONCILIATION_REQUIRED',
                provider: args.provider || payment.provider || null,
                providerTransactionId: args.providerTransactionId || payment.providerTransactionId || null,
                reference: args.reference || payment.reference || null,
              },
            });
          }

          await createReconciliationIssue(tx, {
            paymentId: payment.id,
            provider: args.provider || payment.provider || 'UNKNOWN',
            observedStatus: 'PAID',
            expectedAmount: payment.amount,
            observedAmount: args.payload?.amount ?? null,
            expectedCurrency: payment.currency,
            observedCurrency: args.payload?.currency || null,
            reason: 'INSUFFICIENT_INVENTORY_AFTER_PROVIDER_PAYMENT',
            payload: args.payload || {},
          });

          await recordAuditEvent(tx, {
            actorId: null,
            action: 'PAYMENT_RECONCILIATION_REQUIRED',
            resourceType: 'Payment',
            resourceId: payment.id,
            metadata: {
              reason: 'INSUFFICIENT_INVENTORY_AFTER_PROVIDER_PAYMENT',
              error: error.message,
            },
          });

          return tx.payment.findUnique({ where: { id: payment.id } });
        }, { maxWait: 10000, timeout: 20000 });
      } catch (reconciliationError) {
        logger.error({ err: reconciliationError, paymentId: args.paymentId }, 'Failed to persist inventory/payment reconciliation');
        throw error;
      }
    } else {
      throw error;
    }
  }

  // Track whichever payment effectively settled. For an installment child
  // that completes the plan, the parent MARKETPLACE payment is what really
  // settled; downstream release logic must key off the parent, not the child.
  let settledForRelease = result;

  if (
    result &&
    result.type === 'MARKETPLACE_INSTALLMENT' &&
    result.status === 'PAID' &&
    result.parentPaymentId
  ) {
    try {
      const parentResult = await require('./installmentService').finalizeInstallmentPlan(
        result.parentPaymentId
      );
      if (
        parentResult &&
        parentResult.type === 'MARKETPLACE' &&
        parentResult.status === 'PAID'
      ) {
        settledForRelease = parentResult;
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          paymentId: result.id,
          parentPaymentId: result.parentPaymentId,
        },
        'settlePayment: could not settle the goods payment after the last installment; will retry'
      );
    }
  }

  // --------------------------------------------------------------------------
  // WAITING LIST RELEASE — OFFERS TERMINAL EVENT
  // --------------------------------------------------------------------------
  // A MARKETPLACE payment settled PAID is the terminal event for the offers
  // flow: goods are committed. Any still-PENDING offers on the listing are
  // permanently released (WITHDRAWN) and their bidders notified. Runs outside
  // the settlement transaction so a notice failure can never roll back the
  // payment. Idempotent — repeated settle calls find nothing left to release.
  if (
    settledForRelease &&
    settledForRelease.type === 'MARKETPLACE' &&
    settledForRelease.status === 'PAID' &&
    settledForRelease.orderId
  ) {
    try {
      const order = await prisma.order.findUnique({
        where: { id: settledForRelease.orderId },
        select: { listingId: true, status: true },
      });
      // Skip if the order was received under a dispute or cancellation — the
      // payment is PAID for financial truth, but the listing is not committed.
      if (order && !['DISPUTED', 'CANCELLED'].includes(order.status)) {
        await releaseWaitingBidders(prisma, {
          listingId: order.listingId,
          actorId: null,
          reason: 'MARKETPLACE_PAID',
        });
      }
    } catch (error) {
      logger.error(
        { err: error, paymentId: settledForRelease.id, orderId: settledForRelease.orderId },
        'settlePayment: could not release waiting bidders after MARKETPLACE PAID; will retry on next maintenance sweep'
      );
    }
  }

  return result;
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  moneyEqual,
  commissionRateFor,
  createPayment,
  settlePayment,
  settlePaymentCore,
  replayDisputedPaidPayment,
};
