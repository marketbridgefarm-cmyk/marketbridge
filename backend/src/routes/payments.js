'use strict';


const express = require('express');
const crypto = require('crypto');
const {
  body,
  param,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');

const {
  authenticate,
} = require('../middleware/auth');

const {
  isAdmin,
  isOrderParticipant,
} = require('../utils/authorization');

const chapa =
  require('../config/chapa');

const { getAdapter } = require('../services/paymentProviders');
const { inc } = require('../utils/metrics');
const { assertTransition } = require('../services/paymentStateMachine');
const { verifyAndFinalizeRefund } = require('../services/paymentRefundService');

const {
  paymentLimiter,
  webhookLimiter,
} = require('../middleware/rateLimit');

const paymentService =
  require('../services/paymentService');

const installmentService =
  require('../services/installmentService');

const router = express.Router();

// ============================================================================
// VALIDATION
// ============================================================================

const validate = (req, res, next) => {
  const errors =
    validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      errors: errors.array(),
    });
  }

  next();
};

// ============================================================================
// HELPERS
// ============================================================================

function timingSafeEqual(a, b) {
  const x =
    Buffer.from(a || '', 'utf8');

  const y =
    Buffer.from(b || '', 'utf8');

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
}

function verifySignature(req) {
  const secret =
    process.env.PAYMENT_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const raw =
    req.rawBody ||
    Buffer.from(
      JSON.stringify(req.body)
    );

  const expected =
    crypto
      .createHmac(
        'sha256',
        secret
      )
      .update(raw)
      .digest('hex');

  const supplied =
    req.headers[
      'x-marketbridge-signature'
    ];

  return (
    typeof supplied === 'string' &&
    timingSafeEqual(
      supplied,
      expected
    )
  );
}

function moneyEqual(a, b) {
  return (
    Math.abs(
      Number(a) -
      Number(b)
    ) < 0.01
  );
}

function appBaseUrl() {
  return (
    process.env.APP_BASE_URL ||
    ''
  ).replace(/\/$/, '');
}

function apiBaseUrl() {
  return (
    process.env.API_BASE_URL ||
    ''
  ).replace(/\/$/, '');
}

// ============================================================================
// PAYMENT METHODS
// ============================================================================

router.get(
  '/methods',
  authenticate,
  (req, res) => {
    return res.json({
      methods: [
        {
          code: 'TELEBIRR',
          label: 'Telebirr via Chapa',
        },
        {
          code: 'QR',
          label: 'QR Code',
        },
        {
          code: 'OTHER',
          label: 'Other',
        },
      ],
    });
  }
);

// ============================================================================
// CREATE PAYMENT
// ============================================================================

router.post(
  '/',
  authenticate,
  paymentLimiter,

  [
    body('type')
      .isIn([
        'MARKETPLACE',
        'TRANSPORT',
        'INSPECTOR',
        'ADVERTISING',
        'DIGITAL',
      ]),

    body('amount')
      .isFloat({ gt: 0 }),

    body('method')
      .isIn([
        'TELEBIRR',
        'CBE',
        'QR',
        'OTHER',
      ]),

    body('installments')
      .optional()
      .isBoolean(),

    body('orderId')
      .optional()
      .isUUID(),

    body('digitalProductId')
      .optional()
      .isUUID(),

    body('advertisementId')
      .optional()
      .isUUID(),

    body('inspectionRequestId')
      .optional()
      .isUUID(),

    body('reference')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 }),
  ],

  validate,

  async (req, res) => {
    try {
      const {
        type,
        orderId,
        digitalProductId,
        advertisementId,
        inspectionRequestId,
        reference,
        method,
      } = req.body;

      const amount =
        Number(req.body.amount);

      // Amounts above the provider's per-transaction limit cannot be paid in
      // one checkout. Goods payments may instead be paid in installments
      // (opt-in with installments: true); anything else is rejected up front
      // rather than creating an unpayable intent.
      const wantsInstallments =
        req.body.installments === true ||
        req.body.installments === 'true';

      const usesChapa = method === 'TELEBIRR' || method === 'QR';
      const overProviderLimit =
        usesChapa && amount > chapa.getMaxTransactionAmount();

      let installmentMax = null;

      if (overProviderLimit) {
        installmentMax = chapa.getMaxTransactionAmount();

        if (type !== 'MARKETPLACE') {
          return res.status(400).json({
            error:
              `Online payments are limited to ${installmentMax.toLocaleString('en-US')} ETB per transaction. ` +
              'Please contact MarketBridge support to arrange this payment.',
            code: 'PAYMENT_AMOUNT_EXCEEDS_LIMIT',
            maxAmount: installmentMax,
          });
        }

        if (!wantsInstallments) {
          let installmentCount = null;
          try {
            installmentCount =
              installmentService.splitAmount(amount, installmentMax).length;
          } catch (_) {
            installmentCount = null;
          }

          return res.status(400).json({
            error:
              `Online payments are limited to ${installmentMax.toLocaleString('en-US')} ETB per transaction. ` +
              (installmentCount
                ? `This order can be paid in ${installmentCount} installments.`
                : 'Please contact MarketBridge support to arrange this payment.'),
            code: 'PAYMENT_AMOUNT_EXCEEDS_LIMIT',
            maxAmount: installmentMax,
            installmentsAvailable: Boolean(installmentCount),
            installmentCount,
          });
        }

        // Fail early (before any gate checks) if the plan itself is not possible.
        try {
          installmentService.splitAmount(amount, installmentMax);
        } catch (planError) {
          return res.status(planError.status || 400).json({
            error: planError.message,
            code: planError.code,
            maxAmount: installmentMax,
          });
        }
      } else if (wantsInstallments) {
        return res.status(400).json({
          error: 'Installments are only available for amounts above the online payment limit',
          code: 'INSTALLMENTS_NOT_NEEDED',
        });
      }

      let transportJobId = null;
      let transportQuoteId = null;

      // ======================================================================
      // IDEMPOTENCY KEY
      // ======================================================================
      // PDF recommendation #14. Optional: requests that don't send one keep
      // working exactly as before (the existing active-payment check below
      // still applies). Clients that generate one key per "create this
      // payment intent" attempt and retry with the same key get the same
      // payment back instead of a second one, even under a race — see the
      // P2002 handling in paymentService.createPayment.
      const idempotencyKey =
        req.get('Idempotency-Key') ||
        req.body.idempotencyKey ||
        null;

      if (idempotencyKey && String(idempotencyKey).length > 200) {
        return res.status(400).json({
          error: 'Idempotency-Key must be 200 characters or fewer',
        });
      }

      if (idempotencyKey) {
        const replay = await prisma.payment.findUnique({
          where: { idempotencyKey: String(idempotencyKey) },
        });

        if (replay) {
          if (replay.createdById !== req.user.id) {
            return res.status(409).json({
              error: 'Idempotency-Key already used by a different request',
            });
          }

          return res.status(200).json({
            message: 'Payment intent already exists for this Idempotency-Key.',
            payment: replay,
            paymentConfirmed: false,
            replayed: true,
          });
        }
      }

      // ======================================================================
      // MARKETPLACE / TRANSPORT
      // ======================================================================

      if (
        type === 'MARKETPLACE' ||
        type === 'TRANSPORT'
      ) {
        if (!orderId) {
          return res.status(400).json({
            error:
              `${type} payment requires orderId`,
          });
        }

        const order =
          await prisma.order.findUnique({
            where: {
              id: orderId,
            },

            include: {
              transportJob: true,
              inspectionRequests: {
                where: { status: { not: 'CANCELLED' } },
                orderBy: { createdAt: 'desc' },
                include: { report: true, payments: true },
              },
              listing: {
                include: {
                  inspectionRequests: {
                    where: { status: { not: 'CANCELLED' } },
                    orderBy: { createdAt: 'desc' },
                    include: {
                      report: true,
                      payments: true,
                    },
                  },
                },
              },
            },
          });

        if (!order) {
          return res.status(404).json({
            error: 'Order not found',
          });
        }

        if (
          !isOrderParticipant(
            req.user.id,
            order
          ) &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({
            error: 'Not authorized',
          });
        }

        // An open dispute freezes the whole order, not just its payouts.
        // Do not allow a buyer, seller, inspector or transporter to create a
        // new payment while an admin is deciding whether the transaction will
        // resume or be cancelled/refunded. This prevents a refund/payout
        // collision where money can be paid into an order after the dispute
        // has already stopped it.
        if (order.status === 'DISPUTED') {
          return res.status(409).json({
            code: 'ORDER_DISPUTED',
            error: 'This order is under dispute. Payments are paused until the dispute is resolved.',
          });
        }

        // --------------------------------------------------------------------
        // MARKETPLACE
        // --------------------------------------------------------------------

        if (
          type === 'MARKETPLACE'
        ) {
          if (
            order.buyerId !==
              req.user.id &&
            !isAdmin(req.user)
          ) {
            return res.status(403).json({
              error:
                'Only the buyer may create the marketplace payment',
            });
          }

          if (
            !moneyEqual(
              amount,
              order.finalPrice
            )
          ) {
            return res.status(400).json({
              error:
                'Amount must match order final price',

              expectedAmount:
                Number(
                  order.finalPrice
                ),
            });
          }

          if (
            order.status ===
            'COMPLETED'
          ) {
            return res.status(400).json({
              error:
                'Order already completed',
            });
          }

          // PRODUCT ORDERS MUST COME FROM AN ACCEPTED/NEGOTIATED OFFER.
          // This closes the legacy/direct-buy path even if an old client calls
          // the payment API directly. Payment is never the first step.
          if (order.listing?.category === 'PRODUCT' && !order.agreedOfferId) {
            return res.status(409).json({
              code: 'NEGOTIATION_REQUIRED',
              error: 'This product must first be won through seller bidding and bilateral negotiation before payment.',
            });
          }

          // HARD AGRICULTURAL AND PRODUCT PAYMENT SEQUENCE:
          // An agricultural order may have only one active inspection workflow.
          // For legacy orders that contain more than one non-cancelled request,
          // the newest request is the canonical workflow. Goods payment is
          // allowed only after that inspection has a completed report. This
          // prevents a stale/duplicate historical request from incorrectly
          // blocking an otherwise completed inspection.
          if (['AGRICULTURAL', 'PRODUCT'].includes(order.listing?.category)) {
            const inspectionRequests = (order.inspectionRequests || [])
              .filter((request) => request.status !== 'CANCELLED')
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            const currentInspection = inspectionRequests[0] || null;
            const inspectionGateRequired = Boolean(order.listing?.inspectionRequired || currentInspection);

            if (inspectionGateRequired && !currentInspection) {
              return res.status(409).json({
                code: 'INSPECTION_REQUIRED_BEFORE_BUYER_DECISION',
                error: 'An inspection must be requested and completed before the buyer can pay for these goods.',
              });
            }

            if (inspectionGateRequired && (currentInspection.status !== 'COMPLETED' || !currentInspection.report)) {
              return res.status(409).json({
                code: 'INSPECTION_REQUIRED_BEFORE_BUYER_DECISION',
                error: 'Complete the current inspection and publish its report before the buyer can pay for the goods.',
                inspectionRequestId: currentInspection.id,
                inspectionStatus: currentInspection.status,
                inspectionReportId: currentInspection.report?.id || null,
              });
            }

            if (inspectionGateRequired && order.buyerDecision !== 'BUY') {
              return res.status(409).json({
                code: 'BUYER_DECISION_REQUIRED',
                error: 'The buyer must explicitly choose BUY after reviewing the inspection report before paying for the goods.',
                buyerDecision: order.buyerDecision || null,
              });
            }
          }

          // Purchase payment is unlocked only after the required inspection.
          // Agricultural orders additionally require the explicit BUY decision.
          // Transport remains a separate negotiated workflow.
        }

        // --------------------------------------------------------------------
        // TRANSPORT
        // --------------------------------------------------------------------

        if (
          type === 'TRANSPORT'
        ) {
          if (!order.transportJob) {
            return res.status(400).json({
              error:
                'Transport job required',
            });
          }

          if (
            order.transportJob.method ===
            'OWN_TRUCK'
          ) {
            return res.status(400).json({
              error:
                'No separate transport payment for OWN_TRUCK',
            });
          }

          if (!['QUOTED', 'ACCEPTED'].includes(order.transportJob.status)) {
            return res.status(400).json({
              error:
                'A transporter must be provisionally agreed before payment',
            });
          }

          // A provisionally accepted quote is the prerequisite for payment.
          // The quote/job is committed only after the Chapa payment settles.
          const acceptedTransportQuote = await prisma.transportQuote.findFirst({
            where: {
              transportJobId: order.transportJob.id,
              status: 'ACCEPTED',
            },
            select: { id: true, truckId: true, truckOwnerId: true, amount: true },
          });
          if (!acceptedTransportQuote) {
            return res.status(409).json({
              error: 'A provisionally accepted transporter quote is required before payment',
            });
          }

          // The quote is the immutable commercial source for this payment.
          // Do not allow a stale job-level amount/assignment to create a
          // payment for a different transporter or truck.
          if (
            order.transportJob.truckOwnerId !== acceptedTransportQuote.truckOwnerId ||
            order.transportJob.truckId !== acceptedTransportQuote.truckId ||
            !moneyEqual(order.transportJob.agreedAmount, acceptedTransportQuote.amount)
          ) {
            return res.status(409).json({
              code: 'TRANSPORT_QUOTE_JOB_MISMATCH',
              error: 'The selected transporter quote no longer matches the transport agreement. Please reopen negotiation and select the current quote.',
            });
          }

          if (
            order.transportJob.agreedAmount ==
            null
          ) {
            return res.status(400).json({
              error:
                'Agreed amount missing',
            });
          }

          if (
            !moneyEqual(
              amount,
              order.transportJob.agreedAmount
            )
          ) {
            return res.status(400).json({
              error:
                'Amount mismatch',

              expectedAmount:
                Number(
                  order.transportJob.agreedAmount
                ),
            });
          }

          // Transport is a buyer-to-transporter transaction on MarketBridge.
          // The party who arranged the transport (BUYER, SELLER or JOINT)
          // does not change who pays the hired transporter: the buyer does.
          if (order.buyerId !== req.user.id && !isAdmin(req.user)) {
            return res.status(403).json({
              error: 'Only the buyer may pay the hired transporter',
            });
          }

          // The revised agricultural flow requires the seller to be paid
          // before transport money can be committed for the loading stage.
          const goodsPayment = await prisma.payment.findFirst({
            where: { orderId: order.id, type: 'MARKETPLACE', status: 'PAID' },
            select: { id: true },
          });
          if (!goodsPayment) {
            return res.status(409).json({
              code: 'GOODS_PAYMENT_REQUIRED',
              error: 'The seller must be paid before the hired transporter can be paid.',
            });
          }

          transportJobId =
            order.transportJob.id;
          transportQuoteId =
            acceptedTransportQuote.id;
        }
      }

      // ======================================================================
      // DIGITAL
      // ======================================================================

      else if (
        type === 'DIGITAL'
      ) {
        if (!digitalProductId) {
          return res.status(400).json({
            error:
              'digitalProductId required',
          });
        }

        const product =
          await prisma.digitalProduct.findUnique({
            where: {
              id: digitalProductId,
            },
          });

        if (
          !product ||
          product.status !==
            'ACTIVE'
        ) {
          return res.status(404).json({
            error:
              'Digital product not found',
          });
        }

        if (
          product.sellerId ===
          req.user.id
        ) {
          return res.status(400).json({
            error:
              'Cannot purchase own product',
          });
        }

        if (
          !moneyEqual(
            amount,
            product.price
          )
        ) {
          return res.status(400).json({
            error:
              'Amount mismatch',

            expectedAmount:
              Number(product.price),
          });
        }
      }

      // ======================================================================
      // ADVERTISING
      // ======================================================================

      else if (
        type === 'ADVERTISING'
      ) {
        if (!advertisementId) {
          return res.status(400).json({
            error:
              'advertisementId required',
          });
        }

        const ad =
          await prisma.advertisement.findUnique({
            where: {
              id: advertisementId,
            },
          });

        if (!ad) {
          return res.status(404).json({
            error:
              'Ad not found',
          });
        }

        if (
          ad.advertiserId !==
            req.user.id &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({
            error:
              'Not authorized',
          });
        }

        const expectedAdAmount = Number(ad.priceQuoted ?? ad.amountPaid ?? 0);

        if (!Number.isFinite(expectedAdAmount) || expectedAdAmount <= 0) {
          return res.status(400).json({
            error: 'Advertisement has no valid server-calculated price',
          });
        }

        if (!moneyEqual(amount, expectedAdAmount)) {
          return res.status(400).json({
            error: 'Amount mismatch',
            expectedAmount: expectedAdAmount,
          });
        }

        // Allow-list, not a block-list: a campaign can only be paid while it
        // is still awaiting its first payment. This also covers CANCELLED
        // (previously unblocked, letting a cancelled campaign be revived by
        // payment) and every already-paid status (PAID_PENDING_REVIEW,
        // APPROVED, SCHEDULED, PUBLISHED), which previously allowed a
        // duplicate/retried payment request to create a second PAID payment
        // for the same ad and double the recorded advertising revenue.
        if (ad.status !== 'PENDING_PAYMENT') {
          return res.status(400).json({ error: `Cannot pay a campaign that is ${ad.status.toLowerCase().replace(/_/g, ' ')}` });
        }
      }

      // ======================================================================
      // INSPECTOR
      // ======================================================================

      else if (
        type === 'INSPECTOR'
      ) {
        if (!inspectionRequestId) {
          return res.status(400).json({
            error:
              'inspectionRequestId required',
          });
        }

        const request =
          await prisma.inspectionRequest.findUnique({
            where: {
              id:
                inspectionRequestId,
            },
          });

        if (!request) {
          return res.status(404).json({
            error:
              'Inspection request not found',
          });
        }

        let inspectionPaymentAllowed = isAdmin(req);
        let inspectionPayerId = null;
        let inspectionExpectedAmount = null;
        // The inspection's own order binding is authoritative. A client must
        // not be able to dodge the seller-confirmation gate by omitting or
        // changing orderId in the request body.
        if (request.orderId && req.body.orderId && req.body.orderId !== request.orderId) {
          return res.status(400).json({ error: 'orderId does not match the inspection request' });
        }
        const gateOrderId = request.orderId || req.body.orderId || null;
        if (gateOrderId) {
          const inspectionOrder = await prisma.order.findUnique({
            where: { id: gateOrderId },
            select: { id: true, buyerId: true, sellerId: true, listingId: true, status: true },
          });
          if (inspectionOrder?.status === 'DISPUTED') {
            return res.status(409).json({ code: 'ORDER_DISPUTED', error: 'This order is under dispute. Inspection payment is paused until the dispute is resolved.' });
          }
          if (inspectionOrder && ['CANCELLED', 'COMPLETED'].includes(inspectionOrder.status)) {
            return res.status(409).json({ code: 'ORDER_CLOSED', error: `This order is ${inspectionOrder.status.toLowerCase()}, so inspection payment is no longer possible.` });
          }
          if (inspectionOrder && inspectionOrder.listingId === request.listingId) {
            if (request.status !== 'ACCEPTED') {
              return res.status(409).json({ code: 'INSPECTION_NOT_READY_FOR_PAYMENT', error: 'Inspection payment is only possible for an accepted, seller-confirmed inspection.' });
            }
            if (!request.sellerConfirmedAt) {
              return res.status(409).json({ code: 'SELLER_CONFIRMATION_REQUIRED', error: 'The seller must confirm the selected inspector and agreed inspection fee before inspection payment can begin.' });
            }
            const obligations = await prisma.paymentObligation.findMany({
              where: { orderId: inspectionOrder.id, inspectionRequestId: request.id, type: 'INSPECTOR' },
              select: { id: true, payerId: true, amount: true, status: true },
            });
            const mine = obligations.find((o) => o.payerId === req.user.id);
            if (mine) {
              if (mine.status === 'CANCELLED') {
                return res.status(409).json({ code: 'OBLIGATION_CANCELLED', error: 'This inspection payment obligation has been cancelled.' });
              }
              inspectionPayerId = mine.payerId;
              inspectionExpectedAmount = Number(mine.amount);
              inspectionPaymentAllowed = mine.status === 'OPEN';
            } else {
              const expectedPayer = request.feePayer === 'SELLER' || request.mode === 'SELLER_REQUESTED'
                ? inspectionOrder.sellerId
                : inspectionOrder.buyerId;
              inspectionPayerId = expectedPayer;
              inspectionExpectedAmount = request.feePayer === 'SPLIT'
                ? Number(req.user.id === inspectionOrder.buyerId ? request.buyerFeeAmount : request.sellerFeeAmount)
                : Number(request.fee);
              inspectionPaymentAllowed = expectedPayer === req.user.id && request.feePayer !== 'SPLIT';
            }
          }
        }
        if (!inspectionPaymentAllowed && request.requestedById === req.user.id && !request.orderId && !req.body.orderId) {
          inspectionPaymentAllowed = true;
          inspectionPayerId = req.user.id;
          inspectionExpectedAmount = Number(request.fee);
        }
        if (!inspectionPaymentAllowed) return res.status(403).json({ error: 'Only the designated inspection payer may pay this fee' });
        if (request.fee == null) return res.status(400).json({ error: 'No agreed fee' });
        if (!Number.isFinite(inspectionExpectedAmount) || inspectionExpectedAmount <= 0) inspectionExpectedAmount = Number(request.fee);
        if (!moneyEqual(amount, inspectionExpectedAmount)) {
          return res.status(400).json({ error: 'Amount mismatch', expectedAmount: inspectionExpectedAmount });
        }
      }

      // ======================================================================
      // DUPLICATE PAYMENT PROTECTION
      // ======================================================================

      const duplicate =
        await prisma.payment.findFirst({
          where: {
            createdById:
              req.user.id,

            type,

            status: {
              in: [
                'PENDING',
                'PROCESSING',
                'PAID',
              ],
            },

            ...(orderId && {
              orderId,
            }),

            ...(digitalProductId && {
              digitalProductId,
            }),

            ...(advertisementId && {
              advertisementId,
            }),

            ...(inspectionRequestId && {
              inspectionRequestId,
            }),

            ...(transportJobId && {
              transportJobId,
            }),
          },
        });

      if (duplicate) {
        if (type === 'TRANSPORT' && transportQuoteId && duplicate.transportQuoteId !== transportQuoteId) {
          return res.status(409).json({
            code: 'TRANSPORT_PAYMENT_ALREADY_BOUND',
            error: 'An active transport payment already exists for a different transporter quote. That payment must fail or be cancelled before another quote can be selected.',
            payment: duplicate,
          });
        }

        // If an older UI already created a normal pending marketplace payment
        // for an amount above Chapa's limit, allow the buyer to upgrade that
        // pending payment into the installment parent instead of trapping the
        // order behind the old "contact support" message. This is safe only
        // while the payment is still PENDING; PROCESSING/PAID payments are never
        // reshaped.
        if (
          wantsInstallments &&
          type === 'MARKETPLACE' &&
          duplicate.status === 'PENDING' &&
          installmentMax &&
          Number(duplicate.amount) > Number(installmentMax)
        ) {
          const parts = installmentService.splitAmount(duplicate.amount, installmentMax);
          const updatedParent = await prisma.payment.update({
            where: { id: duplicate.id },
            data: { installmentCount: parts.length },
          });
          const installments =
            await installmentService.ensureInstallmentChildren(
              updatedParent,
              installmentMax
            );

          return res.status(200).json({
            message: 'Pending payment converted to installment plan.',
            payment: updatedParent,
            installments,
            paymentConfirmed: false,
            replayed: true,
            convertedToInstallments: true,
          });
        }

        // Retrying installment creation (for example after a dropped
        // connection): return the existing plan instead of failing.
        if (
          wantsInstallments &&
          installmentService.isInstallmentParent(duplicate)
        ) {
          const installments =
            await installmentService.ensureInstallmentChildren(
              duplicate,
              installmentMax
            );

          return res.status(200).json({
            message: 'Installment plan already exists.',
            payment: duplicate,
            installments,
            paymentConfirmed: false,
            replayed: true,
          });
        }

        return res.status(409).json({
          error:
            'Active payment already exists',

          payment:
            duplicate,
        });
      }

      // ======================================================================
      // CREATE PAYMENT
      // ======================================================================

      const payment =
        await paymentService.createPayment({
          createdById:
            req.user.id,

          type,

          amount,

          method,

          reference:
            reference || null,

          orderId:
            orderId || null,

          digitalProductId:
            digitalProductId || null,

          advertisementId:
            advertisementId || null,

          inspectionRequestId:
            inspectionRequestId || null,

          transportJobId,

          transportQuoteId,

          ...(wantsInstallments && {
            installmentCount:
              installmentService.splitAmount(amount, installmentMax).length,
          }),

          idempotencyKey:
            idempotencyKey ? String(idempotencyKey) : null,
        });

      if (wantsInstallments) {
        const installments =
          await installmentService.ensureInstallmentChildren(
            payment,
            installmentMax
          );

        return res.status(201).json({
          message:
            'Installment plan created. Pay each installment with /payments/:id/chapa/initialize.',

          payment,

          installments,

          paymentConfirmed:
            false,
        });
      }

      return res.status(201).json({
        message:
          'Payment intent created. Use /payments/:id/chapa/initialize for checkout.',

        payment,

        paymentConfirmed:
          false,
      });

    } catch (error) {
      req.log.error({ err: error }, 'CREATE PAYMENT ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not create payment',
      });
    }
  }
);

// ============================================================================
// CHAPA INITIALIZE
// ============================================================================
//
// Creates a hosted Chapa checkout session.
//
// The browser is redirected to the checkoutUrl returned by Chapa.
//
// Chapa notifies MarketBridge in two separate ways after payment:
//   1. callback_url (set below) - Chapa makes a GET request here with
//      status/tx_ref. Handled by GET /chapa/callback below, which
//      independently re-verifies with Chapa before settling.
//   2. Webhook - a URL configured separately in the Chapa merchant
//      dashboard (a POST notification). Must point at
//      POST {API_BASE_URL}/api/payments/webhooks/chapa. This is a
//      dashboard setting, not something this code controls.
//
// Either notification is a backup for the other; the return_url flow
// (PaymentReturn.jsx calling GET /:id/chapa/verify) is the primary path
// and does not depend on either of these reaching us.
// ============================================================================

router.post(
  '/:id/chapa/initialize',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      const payment =
        await prisma.payment.findUnique({
          where: {
            id:
              req.params.id,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      if (
        payment.createdById !==
          req.user.id &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized',
        });
      }

      if (
        payment.status !==
        'PENDING'
      ) {
        return res.status(409).json({
          error:
            `Payment is ${payment.status}`,
        });
      }

      // Inspection payment checkout has a second server-side gate here,
      // because a PENDING payment intent may have been created by an older
      // client/version before seller confirmation became mandatory. Never
      // allow such an intent to reach Chapa until the seller has confirmed
      // the selected inspector and agreed fee.
      if (payment.type === 'INSPECTOR' && payment.inspectionRequestId) {
        const inspection = await prisma.inspectionRequest.findUnique({
          where: { id: payment.inspectionRequestId },
          select: { id: true, orderId: true, sellerConfirmedAt: true, status: true },
        });
        if (inspection?.orderId && !inspection.sellerConfirmedAt) {
          return res.status(409).json({
            code: 'SELLER_CONFIRMATION_REQUIRED',
            error: 'The seller must confirm the selected inspector and agreed inspection fee before inspection payment can begin.',
          });
        }
        if (inspection?.orderId && inspection.status !== 'ACCEPTED') {
          return res.status(409).json({
            code: 'INSPECTION_NOT_READY_FOR_PAYMENT',
            error: 'The inspection is not in an accepted state for payment.',
          });
        }
      }

      // The full-price parent of an installment plan is never sent to the
      // provider; each installment is paid on its own.
      if (installmentService.isInstallmentParent(payment)) {
        return res.status(409).json({
          error:
            'This payment is paid in installments. Pay each installment separately.',
          code: 'PAYMENT_IS_INSTALLMENT_PLAN',
        });
      }

      // Existing PENDING intents created before the limit check land here.
      // Checked before the PROCESSING claim so the payment stays PENDING.
      chapa.assertWithinTransactionLimit(
        payment.amount,
        payment.currency || 'ETB'
      );

      const appUrl =
        appBaseUrl();

      const apiUrl =
        apiBaseUrl();

      if (
        !appUrl ||
        !apiUrl
      ) {
        return res.status(500).json({
          error:
            'APP_BASE_URL and API_BASE_URL required',
        });
      }

      // A fresh, globally-unique tx_ref per initialize attempt.
      // Chapa permanently rejects a reused tx_ref, so retrying or
      // resuming a still-PENDING payment must never reuse the same one.
      const chapaTxRef =
        `${payment.id}_${Date.now()}`;

      const adapter = getAdapter(payment.method);

      // Claim the intent before contacting the provider. This prevents two
      // browser tabs from opening independent checkout attempts for the same
      // payment. If provider initialization fails, the intent is returned to
      // PENDING so the user can safely retry.
      assertTransition(payment.status, 'PROCESSING');
      const processingClaim = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      if (processingClaim.count !== 1) {
        return res.status(409).json({
          error: 'Payment checkout is already being initialized. Please retry shortly.',
        });
      }

      let checkout;
      try {
        checkout = await adapter.initialize({
          txRef:
            chapaTxRef,

          amount:
            payment.amount,

          currency:
            payment.currency ||
            'ETB',

          email:
            req.user.email,

          firstName:
            (
              req.user.name ||
              'MarketBridge'
            ).split(' ')[0],

          lastName:
            (
              req.user.name ||
              ''
            )
              .split(' ')
              .slice(1)
              .join(' ') ||
            'User',

          phoneNumber:
            req.user.phone ||
            undefined,

          // Chapa calls this via GET after payment completes;
          // handled by GET /chapa/callback below.
          callbackUrl:
            `${apiUrl}/api/payments/chapa/callback`,

          // User-facing frontend return page.
          returnUrl:
            `${appUrl}/payments/${payment.id}/return`,

          // Chapa limits the checkout title to 16 characters.
          title:
            payment.type === 'MARKETPLACE_INSTALLMENT'
              ? 'Installment'
              : payment.type,

          description:
            payment.type === 'MARKETPLACE_INSTALLMENT'
              ? `MarketBridge order payment, installment ${payment.installmentSequence}`
              : `MarketBridge ${payment.type} payment`,
        });
      } catch (providerError) {
        await prisma.payment.updateMany({
          where: { id: payment.id, status: 'PROCESSING' },
          data: { status: 'PENDING' },
        });
        throw providerError;
      }

      const { checkoutUrl } = checkout;

      await prisma.payment.update({
        where: {
          id:
            payment.id,
        },

        data: {
          provider:
            getAdapter(payment.method).provider,

          // Tracks the tx_ref actually on file with Chapa for this
          // attempt, so verify/callback/webhook can look it up correctly.
          // Overwritten with Chapa's own confirmed reference at settlement.
          chapaTxRef,

          providerTransactionId:
            chapaTxRef,
        },
      });

      return res.json({
        checkoutUrl,
      });

    } catch (error) {
      req.log.error({ err: error }, 'PAYMENT PROVIDER INIT ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not start Chapa checkout',
      });
    }
  }
);

// ============================================================================
// RETRY A FAILED INSTALLMENT
// ============================================================================
//
// A failed installment cannot be reopened, so the buyer gets a fresh one for
// the same sequence and amount. See installmentService.replaceFailedInstallment.

router.post(
  '/:id/retry-installment',
  authenticate,
  paymentLimiter,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      const installment =
        await installmentService.replaceFailedInstallment(
          req.params.id,
          req.user.id,
          { isAdmin: isAdmin(req.user) }
        );

      return res.status(201).json({ installment });
    } catch (error) {
      req.log.error({ err: error }, 'RETRY INSTALLMENT ERROR:');

      return res.status(error.status || 500).json({
        error: error.message || 'Could not retry installment',
        code: error.code,
      });
    }
  }
);

// ============================================================================
// CHAPA CALLBACK
// ============================================================================
//
// Chapa redirects/calls this endpoint after checkout.
//
// IMPORTANT:
// The callback itself is NOT trusted as final payment confirmation.
// We use tx_ref to query Chapa's verification API and only settle the
// MarketBridge payment after Chapa confirms the transaction.
//
// ============================================================================

router.get(
  '/chapa/callback',
  async (req, res) => {
    const appUrl =
      appBaseUrl();

    const txRef =
      req.query?.tx_ref ||
      req.query?.trx_ref ||
      req.query?.reference;

    try {
      if (!txRef) {
        req.log.warn('CHAPA CALLBACK: missing tx_ref');

        if (appUrl) {
          return res.redirect(
            `${appUrl}/payments/return?status=ERROR`
          );
        }

        return res.status(400).json({
          error:
            'Missing Chapa transaction reference',
        });
      }

      // tx_ref is `${payment.id}_${timestamp}` (see /chapa/initialize) -
      // extract the payment id to look it up, but verify against Chapa
      // using the exact raw tx_ref, since that's what Chapa has on file.
      const paymentId =
        String(txRef).split('_')[0];

      const payment =
        await prisma.payment.findUnique({
          where: {
            id:
              paymentId,
          },
        });

      if (!payment) {
        req.log.error({ txRef, paymentId }, 'CHAPA CALLBACK: payment not found');

        if (appUrl) {
          return res.redirect(
            `${appUrl}/payments/${encodeURIComponent(
              paymentId
            )}/return`
          );
        }

        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      // Already settled.
      if (
        payment.status ===
        'PAID'
      ) {
        return res.redirect(
          `${appUrl}/payments/${payment.id}/return`
        );
      }

      // ----------------------------------------------------------------------
      // SERVER-SIDE VERIFICATION
      // ----------------------------------------------------------------------

      const {
        status,
        raw,
      } =
        await chapa.verifyTransaction(
          String(txRef)
        );

      const verifiedAmount = raw?.data?.amount;
      const verifiedCurrency = raw?.data?.currency;
      const providerTransactionId =
        raw?.data?.reference ||
        raw?.data?.ref_id ||
        raw?.data?.tx_ref ||
        payment.providerTransactionId ||
        payment.id;

      if (status === 'success') {
        // paymentService performs final amount/currency validation.
        await paymentService.settlePayment({
          paymentId: payment.id,
          status: 'PAID',
          provider: getAdapter(payment.method).provider,
          providerTransactionId,
          eventId: `chapa-callback-${payment.id}-${Date.now()}`,
          payload: {
            amount: verifiedAmount,
            currency: verifiedCurrency ?? payment.currency ?? 'ETB',
            chapa: raw?.data || raw,
          },
        });
      } else if (status === 'failed') {
        // A failed/cancelled hosted checkout must close the local payment
        // intent. Leaving it PROCESSING permanently blocks the Payment Center
        // from creating a fresh seller-payment attempt.
        await paymentService.settlePayment({
          paymentId: payment.id,
          status: 'FAILED',
          provider: getAdapter(payment.method).provider,
          providerTransactionId,
          eventId: `chapa-callback-failed-${payment.id}-${Date.now()}`,
          payload: {
            amount: verifiedAmount,
            currency: verifiedCurrency ?? payment.currency ?? 'ETB',
            chapa: raw?.data || raw,
          },
        });
      }

      // Always return the customer to MarketBridge.
      return res.redirect(
        `${appUrl}/payments/${payment.id}/return`
      );

    } catch (error) {
      req.log.error({ err: error }, 'CHAPA CALLBACK ERROR:');

      // The frontend PaymentReturn page will perform its own verification.
      if (
        appUrl &&
        txRef
      ) {
        return res.redirect(
          `${appUrl}/payments/${encodeURIComponent(
            String(txRef).split('_')[0]
          )}/return`
        );
      }

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not process Chapa callback',
      });
    }
  }
);

// ============================================================================
// CHAPA VERIFY
// ============================================================================
//
// Used by the frontend PaymentReturn page.
//
// This endpoint independently asks Chapa for the transaction status.
// ============================================================================

router.get(
  '/:id/chapa/verify',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      const payment =
        await prisma.payment.findUnique({
          where: {
            id:
              req.params.id,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      if (
        payment.createdById !==
          req.user.id &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized',
        });
      }

      // The parent of an installment plan has no provider transaction of its
      // own. Re-check whether every installment is paid and settle it if so.
      if (installmentService.isInstallmentParent(payment)) {
        const parent =
          await installmentService.finalizeInstallmentPlan(payment.id);

        return res.json({
          ok: true,
          status: parent?.status || payment.status,
          payment: parent || payment,
        });
      }

      if (
        payment.status ===
        'PAID'
      ) {
        inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'already_paid' });
        return res.json({
          status:
            'PAID',

          payment,
        });
      }

      const {
        status,
        raw,
      } =
        await chapa.verifyTransaction(
          payment.providerTransactionId ||
            payment.id
        );

      // ----------------------------------------------------------------------
      // SUCCESS
      // ----------------------------------------------------------------------

      if (
        status ===
        'success'
      ) {
        const verifiedAmount =
          raw?.data?.amount;

        const verifiedCurrency =
          raw?.data?.currency;

        const settled =
          await paymentService.settlePayment({
            paymentId:
              payment.id,

            status:
              'PAID',

            provider:
              'chapa',

            providerTransactionId:
              raw?.data?.reference ||
              raw?.data?.ref_id ||
              raw?.data?.tx_ref ||
              payment.id,

            reference:
              payment.reference,

            eventId:
              `chapa-verify-${payment.id}-${Date.now()}`,

            payload: {
              amount:
                verifiedAmount,

              currency:
                verifiedCurrency ??
                payment.currency ??
                'ETB',

              chapa:
                raw?.data || raw,
            },
          });

        return res.json({
          status:
            'PAID',

          payment:
            settled,
        });
      }

      // ----------------------------------------------------------------------
      // FAILED
      // ----------------------------------------------------------------------

      if (status === 'failed') {
        const failedPayment = await paymentService.settlePayment({
          paymentId: payment.id,
          status: 'FAILED',
          provider: getAdapter(payment.method).provider,
          providerTransactionId:
            raw?.data?.reference ||
            raw?.data?.ref_id ||
            raw?.data?.tx_ref ||
            payment.providerTransactionId ||
            payment.id,
          reference: payment.reference,
          eventId: `chapa-verify-failed-${payment.id}-${Date.now()}`,
          payload: {
            amount: raw?.data?.amount ?? payment.amount,
            currency: raw?.data?.currency ?? payment.currency ?? 'ETB',
            chapa: raw?.data || raw,
          },
        });

        return res.json({
          status: 'FAILED',
          payment: failedPayment,
          chapaStatus: status,
        });
      }

      // ----------------------------------------------------------------------
      // PENDING
      // ----------------------------------------------------------------------

      return res.json({
        status:
          'PENDING',

        payment,

        chapaStatus:
          status,
      });

    } catch (error) {
      req.log.error({ err: error }, 'CHAPA VERIFY ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not verify Chapa transaction',
      });
    }
  }
);

// ============================================================================
// CHAPA WEBHOOK
// ============================================================================
//
// Chapa sends POST notifications here.
//
// Security:
// 1. Validate raw-body signature.
// 2. Extract tx_ref.
// 3. Ask Chapa's API to verify the transaction.
// 4. Validate amount/currency through paymentService.
// 5. Settle payment idempotently.
//
// ============================================================================

router.post(
  '/webhooks/chapa',
  webhookLimiter,
  async (req, res) => {
    inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'received' });
    const rawBody =
      req.rawBody;

    // ------------------------------------------------------------------------
    // SIGNATURE VERIFICATION
    // ------------------------------------------------------------------------
    // Chapa sends two differently-computed headers (chapa-signature and
    // x-chapa-signature); verifyWebhookSignature checks both correctly.

    if (
      !rawBody ||
      !chapa.verifyWebhookSignature(
        rawBody,
        req.headers
      )
    ) {
      inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'invalid_signature' });
      req.log.warn('CHAPA WEBHOOK: invalid signature');

      return res.status(401).json({
        error:
          'Invalid webhook signature',
      });
    }

    // ------------------------------------------------------------------------
    // TRANSACTION REFERENCE
    // ------------------------------------------------------------------------

    const txRef =
      req.body?.tx_ref ||
      req.body?.trx_ref ||
      req.body?.reference;

    if (!txRef) {
      inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'missing_reference' });
      req.log.warn('CHAPA WEBHOOK: missing tx_ref');

      return res.status(400).json({
        error:
          'Invalid payload',
      });
    }

    try {
      // ----------------------------------------------------------------------
      // LOOK UP LOCAL PAYMENT
      // ----------------------------------------------------------------------

      // tx_ref is `${payment.id}_${timestamp}` (see /chapa/initialize) -
      // extract the payment id to look it up, but verify against Chapa
      // using the exact raw tx_ref, since that's what Chapa has on file.
      const paymentId =
        String(txRef).split('_')[0];

      const payment =
        await prisma.payment.findUnique({
          where: {
            id:
              paymentId,
          },
        });

      if (!payment) {
        req.log.error({ txRef, paymentId }, 'CHAPA WEBHOOK: payment not found');

        inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'payment_not_found' });
        return res.json({ ok: true, ignored: true, reason: 'Payment not found' });
      }

      // ----------------------------------------------------------------------
      // REFUND WEBHOOK
      // ----------------------------------------------------------------------
      // Chapa documents charge.refunded as a refund event. Treat the signed
      // webhook as a notification only: when a refund ref_id is present,
      // re-query Chapa's refund verification endpoint before changing the
      // MarketBridge payment to REFUNDED.
      const webhookEvent = String(req.body?.event || req.body?.type || '').toLowerCase();
      const refundEvent = webhookEvent === 'charge.refunded' ||
        webhookEvent === 'payment.refunded' ||
        (String(req.body?.status || '').toLowerCase() === 'refunded' && Boolean(req.body?.ref_id || req.body?.refund_ref_id || req.body?.data?.ref_id));

      if (refundEvent) {
        const refund = await prisma.paymentRefund.findFirst({
          where: { paymentId: payment.id, status: { in: ['REQUESTED', 'PROCESSING'] } },
          orderBy: { createdAt: 'desc' },
        });

        if (!refund) {
          return res.json({ ok: true, ignored: true, reason: 'No active MarketBridge refund for payment' });
        }

        const refundRefId = String(
          req.body?.ref_id ||
          req.body?.refund_ref_id ||
          req.body?.data?.ref_id ||
          refund.providerRefundId ||
          ''
        ).trim();

        if (!refundRefId) {
          req.log.warn({ paymentId: payment.id, refundId: refund.id }, 'CHAPA REFUND WEBHOOK: missing refund ref_id; awaiting verification');
          return res.json({ ok: true, processing: true, reason: 'Refund reference missing' });
        }

        await prisma.paymentRefund.updateMany({
          where: { id: refund.id, status: { in: ['REQUESTED', 'PROCESSING'] } },
          data: { provider: refund.provider || payment.provider || 'CHAPA', providerRefundId: refundRefId },
        });

        const result = await verifyAndFinalizeRefund({ refundId: refund.id, actorId: null, note: 'Finalized from verified Chapa refund webhook.' });
        return res.json({ ok: true, refund: result.refund, providerStatus: result.providerStatus });
      }

      // ----------------------------------------------------------------------
      // ALREADY PAID
      // ----------------------------------------------------------------------

      if (
        payment.status ===
        'PAID'
      ) {
        return res.json({
          ok:
            true,

          alreadyPaid:
            true,

          paymentId:
            payment.id,
        });
      }

      // ----------------------------------------------------------------------
      // NEVER TRUST WEBHOOK STATUS ALONE
      // ----------------------------------------------------------------------

      const {
        status,
        raw,
      } =
        await chapa.verifyTransaction(
          String(txRef)
        );

      if (
        status !==
        'success'
      ) {
        inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'provider_not_success' });
        return res.json({
          ok:
            true,

          ignored:
            true,

          verificationStatus:
            status,
        });
      }

      // ----------------------------------------------------------------------
      // VERIFIED PAYMENT DATA
      // ----------------------------------------------------------------------

      const verifiedAmount =
        raw?.data?.amount;

      const verifiedCurrency =
        raw?.data?.currency;

      // paymentService validates amount and currency.
      const settled =
        await paymentService.settlePayment({
          paymentId:
            payment.id,

          status:
            'PAID',

          provider:
            getAdapter(payment.method).provider,

          providerTransactionId:
            raw?.data?.reference ||
            raw?.data?.ref_id ||
            raw?.data?.tx_ref ||
            payment.id,

          reference:
            raw?.data?.reference ||
            req.body?.reference ||
            payment.reference,

          eventId:
            req.body?.event_id ||
            req.body?.trx_ref ||
            String(txRef),

          payload: {
            ...req.body,

            amount:
              verifiedAmount,

            currency:
              verifiedCurrency ??
              payment.currency ??
              'ETB',

            chapaVerification:
              raw?.data || raw,
          },
        });

      inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'settled' });
      return res.json({
        ok:
          true,

        payment:
          settled,
      });

    } catch (error) {
      inc('marketbridge_payment_webhooks_total', { provider: 'chapa', outcome: 'error' });
      req.log.error({ err: error }, 'CHAPA WEBHOOK ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Webhook processing failed',
      });
    }
  }
);

// ============================================================================
// GENERIC WEBHOOK
// ============================================================================
//
// Used for internal/provider integrations that use the MarketBridge webhook
// signature.
//
// Chapa does NOT use this endpoint.
// ============================================================================

router.post(
  '/webhooks/generic',

  webhookLimiter,

  express.json({
    limit:
      '100kb',

    verify: (
      req,
      res,
      buf
    ) => {
      req.rawBody =
        Buffer.from(buf);
    },
  }),

  async (req, res) => {
    if (
      !verifySignature(req)
    ) {
      return res.status(401).json({
        error:
          'Invalid signature',
      });
    }

    const {
      paymentId,
      status,
      reference,
      provider,
      providerTransactionId,
    } = req.body;

    if (
      !paymentId ||
      ![
        'PAID',
        'FAILED',
        'REFUNDED',
        'RECONCILIATION_REQUIRED',
      ].includes(status)
    ) {
      return res.status(400).json({
        error:
          'Invalid payload',
      });
    }

    try {
      const settled =
        await paymentService.settlePayment({
          paymentId,

          status,

          provider:
            provider ||
            'generic',

          providerTransactionId,

          reference:
            reference ||
            null,

          eventId:
            req.body?.eventId ||
            req.body?.event_id ||
            `${provider || 'generic'}-${paymentId}-${status}-${providerTransactionId || reference || 'no-ref'}`,

          payload:
            req.body,
        });

      return res.json({
        ok:
          true,

        payment:
          settled,
      });

    } catch (error) {
      req.log.error({ err: error }, 'GENERIC WEBHOOK ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Webhook processing failed',
      });
    }
  }
);

// ============================================================================
// ADMIN PAYMENT QUEUE
// ============================================================================

router.get(
  '/',
  authenticate,

  async (req, res) => {
    try {
      if (
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Admin only',
        });
      }

      const {
        status,
      } = req.query;

      // status may arrive as a single value ("PENDING") or, via
      // axios's default array serialization (status[]=A&status[]=B),
      // as an array — support both so the admin queue can ask for
      // more than one status at once (e.g. PENDING + RECONCILIATION_REQUIRED).
      const statusFilter =
        Array.isArray(status)
          ? { in: status }
          : status;

      const payments =
        await prisma.payment.findMany({
          where: {
            ...(status && {
              status: statusFilter,
            }),
          },

          include: {
            createdBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },

            order: {
              select: {
                id: true,
                finalPrice: true,
              },
            },

            digitalProduct: {
              select: {
                id: true,
                title: true,
              },
            },

            advertisement: {
              select: {
                id: true,
                type: true,
              },
            },

            inspectionRequest: {
              select: {
                id: true,
                fee: true,
              },
            },

            transportJob: {
              select: {
                id: true,
                method: true,
                agreedAmount: true,
              },
            },

            ledgerEntries:
              true,
          },

          orderBy: {
            createdAt:
              'desc',
          },
        });

      return res.json({
        payments,

        count:
          payments.length,
      });

    } catch (error) {
      req.log.error({ err: error }, 'ADMIN PAYMENTS ERROR:');

      return res.status(500).json({
        error:
          'Could not load payments',
      });
    }
  }
);

// ============================================================================
// COMMISSION SUMMARY
// ============================================================================

router.get(
  '/commissions/summary',
  authenticate,

  async (req, res) => {
    try {
      if (
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Admin only',
        });
      }

      const paid =
        await prisma.payment.findMany({
          where: {
            status:
              'PAID',
          },

          select: {
            type:
              true,

            amount:
              true,

            commissionAmount:
              true,
          },
        });

      const byType = {};

      let totalCommission =
        0;

      let totalVolume =
        0;

      for (
        const payment
        of paid
      ) {
        const type =
          byType[payment.type] ||
          {
            volume:
              0,

            commission:
              0,

            count:
              0,
          };

        type.volume +=
          Number(
            payment.amount
          );

        type.commission +=
          Number(
            payment.commissionAmount ||
            0
          );

        type.count +=
          1;

        byType[
          payment.type
        ] = type;

        totalVolume +=
          Number(
            payment.amount
          );

        totalCommission +=
          Number(
            payment.commissionAmount ||
            0
          );
      }

      return res.json({
        totalVolume,

        totalCommission,

        byType,
      });

    } catch (error) {
      req.log.error({ err: error }, 'COMMISSION SUMMARY ERROR:');

      return res.status(500).json({
        error:
          'Could not load commission summary',
      });
    }
  }
);

// ============================================================================
// ADMIN MANUAL CONFIRMATION
// ============================================================================

router.patch(
  '/:id/confirm',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      if (
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Admin only',
        });
      }

      const existing =
        await prisma.payment.findUnique({
          where: {
            id:
              req.params.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      if (
        existing.status !==
        'PENDING'
      ) {
        return res.status(409).json({
          error:
            `Payment is ${existing.status}`,
        });
      }

      if (
        existing.provider
      ) {
        return res.status(409).json({
          error:
            `Payment linked to ${existing.provider} — verify via gateway`,
        });
      }

      const settled =
        await paymentService.settlePayment({
          paymentId:
            existing.id,

          status:
            'PAID',

          provider:
            'admin',

          eventId:
            `admin-${existing.id}`,

          payload: {
            amount:
              existing.amount,

            currency:
              existing.currency ||
              'ETB',
          },
        });

      return res.json({
        message:
          'Payment manually reconciled.',

        payment:
          settled,
      });

    } catch (error) {
      req.log.error({ err: error }, 'ADMIN CONFIRM ERROR:');

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not reconcile',
      });
    }
  }
);

// ============================================================================
// PAYMENTS FOR ORDER
// ============================================================================

router.get(
  '/order/:orderId',
  authenticate,

  [
    param('orderId').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id:
              req.params.orderId,
          },
        });

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found',
        });
      }

      if (
        !isOrderParticipant(
          req.user.id,
          order
        ) &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized',
        });
      }

      // Self-heal: if every installment is paid but the goods payment was not
      // settled (for example the server stopped right after the last
      // installment), settle it now. Idempotent.
      try {
        const plans = await prisma.payment.findMany({
          where: {
            orderId: order.id,
            installmentCount: { not: null },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          select: { id: true },
        });
        for (const plan of plans) {
          await installmentService.finalizeInstallmentPlan(plan.id);
        }
      } catch (healError) {
        req.log.error({ err: healError }, 'INSTALLMENT SELF-HEAL ERROR:');
      }

      const payments =
        await prisma.payment.findMany({
          where: {
            orderId:
              order.id,
          },

          include: {
            ledgerEntries:
              true,

            transportJob:
              true,
          },

          orderBy: {
            createdAt:
              'desc',
          },
        });

      return res.json({
        payments,

        count:
          payments.length,
      });

    } catch (error) {
      req.log.error({ err: error }, 'GET ORDER PAYMENTS ERROR:');

      return res.status(500).json({
        error:
          'Could not load order payments',
      });
    }
  }
);

// ============================================================================
// PAYMENT BY ID
// ============================================================================

router.get(
  '/:id',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    try {
      const payment =
        await prisma.payment.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            order:
              true,

            digitalPurchase:
              true,

            ledgerEntries:
              true,

            transportJob:
              true,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      const owner =
        payment.createdById ===
        req.user.id;

      const orderParticipant =
        payment.order &&
        isOrderParticipant(
          req.user.id,
          payment.order
        );

      if (
        !owner &&
        !orderParticipant &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized',
        });
      }

      return res.json({
        payment,
      });

    } catch (error) {
      req.log.error({ err: error }, 'GET PAYMENT ERROR:');

      return res.status(500).json({
        error:
          'Could not load payment',
      });
    }
  }
);

// ============================================================================
// EXPORT
// ============================================================================

module.exports = router;
