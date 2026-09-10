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

const {
  paymentLimiter,
} = require('../middleware/rateLimit');

const paymentService =
  require('../services/paymentService');

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
          code: 'CBE',
          label: 'CBE',
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

      let transportJobId = null;

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
              listing: {
                include: {
                  inspectionRequests: {
                    include: { payments: true },
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

          // Agricultural purchase payment is independent from transport.
          // The buyer may pay for the produce before or after arranging
          // transport. IN_TRANSIT is separately gated on the backend until
          // all required payments are PAID.
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

          if (
            order.transportJob.status !==
            'ACCEPTED'
          ) {
            return res.status(400).json({
              error:
                'Transport must be accepted before payment',
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

          // Transport payment is independent from marketplace payment.
          // Both must be PAID before IN_TRANSIT, but neither payment has to
          // be completed before creating the other payment intent.

          transportJobId =
            order.transportJob.id;
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

        if (
          ad.amountPaid != null &&
          !moneyEqual(
            amount,
            ad.amountPaid
          )
        ) {
          return res.status(400).json({
            error:
              'Amount mismatch',

            expectedAmount:
              Number(ad.amountPaid),
          });
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

        // Once an agricultural order exists, the buyer is responsible for
        // the inspection service payment even when the seller originally
        // requested the inspection. Keep the original requester authorized
        // as well for pre-order inspection payments.
        let inspectionPaymentAllowed = request.requestedById === req.user.id || isAdmin(req.user);
        if (!inspectionPaymentAllowed && req.body.orderId) {
          const inspectionOrder = await prisma.order.findUnique({
            where: { id: req.body.orderId },
            select: { id: true, buyerId: true, listingId: true },
          });
          inspectionPaymentAllowed = Boolean(
            inspectionOrder &&
            inspectionOrder.buyerId === req.user.id &&
            inspectionOrder.listingId === request.listingId
          );
        }
        if (!inspectionPaymentAllowed) {
          return res.status(403).json({
            error: 'Only the buyer of the related order or the inspection requester may pay',
          });
        }

        if (
          request.fee == null
        ) {
          return res.status(400).json({
            error:
              'No agreed fee',
          });
        }

        if (
          !moneyEqual(
            amount,
            request.fee
          )
        ) {
          return res.status(400).json({
            error:
              'Amount mismatch',

            expectedAmount:
              Number(request.fee),
          });
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
        });

      return res.status(201).json({
        message:
          'Payment intent created. Use /payments/:id/chapa/initialize for checkout.',

        payment,

        paymentConfirmed:
          false,
      });

    } catch (error) {
      console.error(
        'CREATE PAYMENT ERROR:',
        error
      );

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

      const {
        checkoutUrl,
      } =
        await chapa.initializeTransaction({
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

          title:
            payment.type,

          description:
            `MarketBridge ${payment.type} payment`,
        });

      await prisma.payment.update({
        where: {
          id:
            payment.id,
        },

        data: {
          provider:
            'chapa',

          // Tracks the tx_ref actually on file with Chapa for this
          // attempt, so verify/callback/webhook can look it up correctly.
          // Overwritten with Chapa's own confirmed reference at settlement.
          providerTransactionId:
            chapaTxRef,
        },
      });

      return res.json({
        checkoutUrl,
      });

    } catch (error) {
      console.error(
        'CHAPA INIT ERROR:',
        error
      );

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
        console.error(
          'CHAPA CALLBACK: missing tx_ref'
        );

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
        console.error(
          'CHAPA CALLBACK: payment not found:',
          txRef
        );

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

      if (
        status ===
        'success'
      ) {
        const verifiedAmount =
          raw?.data?.amount;

        const verifiedCurrency =
          raw?.data?.currency;

        // paymentService performs final amount/currency validation.
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

          eventId:
            `chapa-callback-${payment.id}-${Date.now()}`,

          payload: {
            amount:
              verifiedAmount ??
              payment.amount,

            currency:
              verifiedCurrency ??
              payment.currency ??
              'ETB',

            chapa:
              raw?.data || raw,
          },
        });
      }

      // Always return the customer to MarketBridge.
      return res.redirect(
        `${appUrl}/payments/${payment.id}/return`
      );

    } catch (error) {
      console.error(
        'CHAPA CALLBACK ERROR:',
        error
      );

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

      if (
        payment.status ===
        'PAID'
      ) {
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
                verifiedAmount ??
                payment.amount,

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

      if (
        status ===
        'failed'
      ) {
        return res.json({
          status:
            'FAILED',

          payment,

          chapaStatus:
            status,
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
      console.error(
        'CHAPA VERIFY ERROR:',
        error
      );

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
  async (req, res) => {
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
      console.error(
        'CHAPA WEBHOOK: invalid signature'
      );

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
      console.error(
        'CHAPA WEBHOOK: missing tx_ref'
      );

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
        console.error(
          'CHAPA WEBHOOK: payment not found:',
          txRef
        );

        // Acknowledge the webhook without trying to create a payment.
        return res.json({
          ok:
            true,

          ignored:
            true,

          reason:
            'Payment not found',
        });
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
            'chapa',

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
            `chapa-webhook-${payment.id}-${Date.now()}`,

          payload: {
            ...req.body,

            amount:
              verifiedAmount ??
              payment.amount,

            currency:
              verifiedCurrency ??
              payment.currency ??
              'ETB',

            chapaVerification:
              raw?.data || raw,
          },
        });

      return res.json({
        ok:
          true,

        payment:
          settled,
      });

    } catch (error) {
      console.error(
        'CHAPA WEBHOOK ERROR:',
        error
      );

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
            `generic-${paymentId}-${Date.now()}`,

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
      console.error(
        'GENERIC WEBHOOK ERROR:',
        error
      );

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

      const payments =
        await prisma.payment.findMany({
          where: {
            ...(status && {
              status,
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
      console.error(
        'ADMIN PAYMENTS ERROR:',
        error
      );

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
      console.error(
        'COMMISSION SUMMARY ERROR:',
        error
      );

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
      console.error(
        'ADMIN CONFIRM ERROR:',
        error
      );

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
      console.error(
        'GET ORDER PAYMENTS ERROR:',
        error
      );

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
      console.error(
        'GET PAYMENT ERROR:',
        error
      );

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
