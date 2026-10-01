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
const { commitListingQuantity } = require('./inventoryService');
const payoutService = require('./payoutService');

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

    // A partial unique index protects against two simultaneous transport
    // payment attempts for the same job. After the losing transaction rolls
    // back, inspect the committed payment and return it only if it belongs to
    // the same negotiated quote. Never silently switch the payment to another
    // transporter.
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
// SETTLE PAYMENT
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
            // The order was only provisional until payment. Commit the
            // agricultural quantity now, inside the same transaction as the
            // PAID state transition. If inventory is unexpectedly unavailable
            // the whole settlement rolls back rather than creating a paid
            // order with no goods behind it.
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
        // A quote acceptance is only provisional. The transport payment is
        // the commitment point: atomically claim the truck, commit the job,
        // and close the competing quotes only after PAID is confirmed.
        if (
          payment.type === 'TRANSPORT' &&
          payment.transportJob &&
          payment.transportJob.method === 'HIRE_TRANSPORTER' &&
          payment.transportJob.truckId &&
          payment.transportJob.truckOwnerId &&
          payment.transportQuote
        ) {
          // The quote is the immutable payment target. Never derive the
          // commercial counterparty from mutable job fields alone.
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

          // New negotiations stay QUOTED until payment. ACCEPTED is retained
          // here only for compatibility with older orders that were created
          // before provisional transport acceptance was introduced. In the
          // new flow, only an AVAILABLE truck is claimed at payment time.
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
              // Legacy ACCEPTED jobs already claimed their truck before this
              // provisional-payment model existed. Make sure BUSY really
              // belongs to this job before allowing the old payment to settle.
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
        // Inspection selection/acceptance is provisional. Payment makes the
        // inspector assignment commercial and closes the remaining quotes.
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
        // HIRED TRANSPORT
        // --------------------------------------------------------------------
        //
        // Own-truck jobs never reach here with a truckOwnerId (see
        // writeLedger above), so no TRANSPORTER_EARNING is written and no
        // payout hold is created for them — there is no external payee to
        // hold money for.

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
        // INSPECTION
        // --------------------------------------------------------------------
        //
        // inspectionRequest.orderId can be null for a pre-order inspection;
        // createPayoutHold treats that as "no order to tie this to yet"
        // rather than failing, matching how InspectionRequest.orderId is
        // itself optional.

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

// ============================================================================
// SETTLE PAYMENT (public entry point)
// ============================================================================
//
// Every provider path (callback, webhook, verify, admin confirm) calls this.
// It runs the normal settlement, then - for an installment of a large goods
// payment - settles the parent goods payment once every installment is PAID.
// See installmentService.js.

async function settlePayment(args) {
  const result = await settlePaymentCore(args);

  if (
    result &&
    result.type === 'MARKETPLACE_INSTALLMENT' &&
    result.status === 'PAID' &&
    result.parentPaymentId
  ) {
    try {
      await require('./installmentService').finalizeInstallmentPlan(
        result.parentPaymentId
      );
    } catch (error) {
      // The installment itself is safely PAID. The parent is settled again by
      // the next verify/callback/webhook or when the buyer opens the order.
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
};
