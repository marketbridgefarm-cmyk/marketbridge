'use strict';

const prisma = require('../config/db');
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
const sellerPayoutService = require('./sellerPayoutService');

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
      return existing;
    }
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        let obligation = null;

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
            data
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
    //
    // Two mobile/browser requests can arrive with the same idempotency key.
    //
    // Request A:
    //   creates the payment successfully.
    //
    // Request B:
    //   attempts the same unique key and receives P2002.
    //
    // The transaction for B is rolled back first.
    // ONLY THEN do we query the normal Prisma client.
    // ------------------------------------------------------------------------

    const target = error?.meta?.target;

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
        if (net > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId:
              payment.id,

            userId:
              job.truckOwnerId,

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
  return prisma.$transaction(
    async (tx) => {
      // ----------------------------------------------------------------------
      // LOAD PAYMENT
      // ----------------------------------------------------------------------

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

      // ----------------------------------------------------------------------
      // PROVIDER AMOUNT VALIDATION
      // ----------------------------------------------------------------------

      if (
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
      //
      // IMPORTANT FIX:
      //
      // The old implementation did:
      //
      //   try {
      //     await tx.paymentEvent.create(...)
      //   } catch (P2002) {
      //     return payment
      //   }
      //
      // That is unsafe because PostgreSQL aborts the transaction immediately
      // after the P2002. Returning from the callback does NOT repair the
      // transaction. Prisma then attempts to finish the transaction and later
      // queries can produce:
      //
      //   current transaction is aborted
      //
      // We therefore use createMany(..., skipDuplicates: true).
      //
      // PostgreSQL handles the duplicate without aborting the transaction.
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
          // Same provider event already processed for this payment.
          if (
            existingEvent.paymentId ===
            payment.id
          ) {
            return payment;
          }

          // The same provider event must never settle another payment.
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

        // A concurrent request may have inserted the event between the
        // findFirst() and createMany(). skipDuplicates prevents PostgreSQL
        // from aborting the transaction.
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

      // Never reopen a refunded payment.
      if (
        payment.status === 'REFUNDED' &&
        status !== 'REFUNDED'
      ) {
        return payment;
      }

      // Never move PAID backwards.
      if (
        payment.status === 'PAID' &&
        [
          'FAILED',
          'RECONCILIATION_REQUIRED',
        ].includes(status)
      ) {
        return payment;
      }

      // A reconciliation-required payment may only be resolved by an
      // authoritative settlement result.
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
        await tx.paymentObligation.update({
          where: {
            id:
              updated.obligationId,
          },

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
            await transitionOrderStatus(
              tx,
              payment.orderId,
              'PENDING_PAYMENT',
              'CONFIRMED'
            );

            orderClaim = {
              count: 1,
            };

            await sellerPayoutService.createPayoutHold(tx, {
              order: payment.order,
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
      // Payment settlement intentionally contains several dependent writes.
      // Give it enough time to complete on the production PostgreSQL service.
      maxWait: 10000,
      timeout: 20000,
    }
  );
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
