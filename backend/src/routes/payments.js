const express = require('express');
const crypto = require('crypto');
const {
  body,
  param,
  validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const {
  isAdmin,
  isOrderParticipant,
} = require('../utils/authorization');
const { commissionFor } = require('../config/commissions');

const {
  directCharge,
  verifyPayment,
  chapaPaymentType,
  getChapaConfig,
} = require('../config/chapa');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      errors: errors.array(),
    });
  }

  next();
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function timingSafeEqual(a, b) {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');

  return (
    x.length === y.length &&
    x.length > 0 &&
    crypto.timingSafeEqual(x, y)
  );
}

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).trim();

  value = value.replace(/[^\d+]/g, '');

  if (value.startsWith('+251')) {
    return `251${value.slice(4)}`;
  }

  if (value.startsWith('251')) {
    return value;
  }

  if (value.startsWith('0')) {
    return `251${value.slice(1)}`;
  }

  return value;
}

function createTxRef(paymentId) {
  return `MB-${paymentId}-${Date.now()}`;
}

function getWebhookRawBody(req) {
  if (req.rawBody) {
    return Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.from(String(req.rawBody), 'utf8');
  }

  return Buffer.from(
    JSON.stringify(req.body || {}),
    'utf8'
  );
}

function verifyChapaWebhookSignature(req) {
  const secret = process.env.CHAPA_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const rawBody = getWebhookRawBody(req);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const chapaSignature =
    req.headers['chapa-signature'];

  const xChapaSignature =
    req.headers['x-chapa-signature'];

  return (
    (typeof chapaSignature === 'string' &&
      timingSafeEqual(chapaSignature, expected)) ||
    (typeof xChapaSignature === 'string' &&
      timingSafeEqual(xChapaSignature, expected))
  );
}

function mapChapaStatus(status) {
  const value = String(status || '').toLowerCase();

  if (value === 'success') return 'PAID';

  if (
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'failed/cancelled'
  ) {
    return 'FAILED';
  }

  if (value === 'refunded') return 'REFUNDED';

  if (value === 'reversed') return 'FAILED';

  return null;
}

/* -------------------------------------------------------------------------- */
/* Payment finalization                                                       */
/* -------------------------------------------------------------------------- */

async function finalizePayment(tx, payment, status, chapaData = {}) {
  if (!payment) {
    throw Object.assign(
      new Error('Payment not found'),
      { status: 404 }
    );
  }

  if (
    payment.status === 'PAID' &&
    status === 'PAID'
  ) {
    return payment;
  }

  if (
    payment.status === 'REFUNDED' &&
    status !== 'REFUNDED'
  ) {
    throw Object.assign(
      new Error('Refunded payment cannot be reopened'),
      { status: 409 }
    );
  }

  const commission =
    status === 'PAID'
      ? commissionFor(payment.type, payment.amount)
      : {
          rate: payment.commissionRate,
          commissionAmount: payment.commissionAmount,
        };

  const updated = await tx.payment.update({
    where: {
      id: payment.id,
    },

    data: {
      status,

      reference:
        chapaData.reference ||
        payment.reference ||
        null,

      provider:
        chapaData.provider ||
        payment.provider ||
        'chapa',

      providerTransactionId:
        chapaData.providerTransactionId ||
        chapaData.reference ||
        payment.providerTransactionId ||
        null,

      ...(status === 'PAID'
        ? {
            commissionRate: commission.rate,
            commissionAmount:
              commission.commissionAmount,
          }
        : {}),
    },
  });

  if (status === 'PAID') {
    if (
      payment.type === 'MARKETPLACE' &&
      payment.orderId
    ) {
      await tx.order.updateMany({
        where: {
          id: payment.orderId,
          status: 'PENDING_PAYMENT',
        },

        data: {
          status: 'CONFIRMED',
        },
      });
    }

    if (
      payment.type === 'DIGITAL' &&
      payment.digitalPurchase
    ) {
      await tx.digitalPurchase.update({
        where: {
          id: payment.digitalPurchase.id,
        },

        data: {
          status: 'COMPLETED',
        },
      });
    }

    if (
      payment.type === 'ADVERTISING' &&
      payment.advertisementId
    ) {
      await tx.advertisement.update({
        where: {
          id: payment.advertisementId,
        },

        data: {
          amountPaid: payment.amount,
        },
      });
    }
  }

  if (
    status === 'REFUNDED' &&
    payment.digitalPurchase
  ) {
    await tx.digitalPurchase.update({
      where: {
        id: payment.digitalPurchase.id,
      },

      data: {
        status: 'REFUNDED',
      },
    });
  }

  return updated;
}

/* -------------------------------------------------------------------------- */
/* Chapa Direct Charge                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Starts a Chapa Direct Charge for Telebirr or CBE Birr.
 *
 * Frontend sends:
 *
 * {
 *   type: "MARKETPLACE",
 *   orderId: "...",
 *   amount: 100,
 *   method: "TELEBIRR",
 *   mobile: "0912345678"
 * }
 *
 * OR:
 *
 * {
 *   type: "MARKETPLACE",
 *   orderId: "...",
 *   amount: 100,
 *   method: "CBE",
 *   mobile: "0912345678"
 * }
 */
router.post(
  '/',
  authenticate,

  [
    body('type').isIn([
      'MARKETPLACE',
      'TRANSPORT',
      'INSPECTOR',
      'ADVERTISING',
      'DIGITAL',
    ]),

    body('amount').isFloat({
      gt: 0,
    }),

    body('method').isIn([
      'TELEBIRR',
      'CBE',
      'QR',
      'OTHER',
    ]),

    body('mobile')
      .optional()
      .isString()
      .trim()
      .isLength({
        min: 9,
        max: 20,
      }),

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
      .isLength({
        max: 200,
      }),
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
      } = req.body;

      const amount = Number(req.body.amount);

      /*
       * Telebirr/CBE Direct Charge needs the customer's mobile.
       *
       * If the frontend does not send it, we fall back to the
       * authenticated user's registered phone number.
       */
      const requestedMobile =
        req.body.mobile ||
        req.user.phone;

      /* -------------------------------------------------------------------- */
      /* Resource validation                                                  */
      /* -------------------------------------------------------------------- */

      if (
        type === 'MARKETPLACE' ||
        type === 'TRANSPORT'
      ) {
        if (!orderId) {
          return res.status(400).json({
            error: `${type} payment requires orderId`,
          });
        }

        const order =
          await prisma.order.findUnique({
            where: {
              id: orderId,
            },

            include: {
              transportJob: true,
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

        /* -------------------------------------------------------------- */
        /* Marketplace payment                                            */
        /* -------------------------------------------------------------- */

        if (type === 'MARKETPLACE') {
          if (
            order.buyerId !== req.user.id &&
            !isAdmin(req.user)
          ) {
            return res.status(403).json({
              error:
                'Only the buyer may create the marketplace payment',
            });
          }

          if (
            Math.abs(
              amount -
                Number(order.finalPrice)
            ) > 0.01
          ) {
            return res.status(400).json({
              error:
                'Amount must match order final price',

              expectedAmount:
                Number(order.finalPrice),
            });
          }
        }

        /* -------------------------------------------------------------- */
        /* Transport payment                                              */
        /* -------------------------------------------------------------- */

        if (type === 'TRANSPORT') {
          if (!order.transportJob) {
            return res.status(400).json({
              error: 'Transport job required',
            });
          }

          if (
            order.transportJob.method ===
            'OWN_TRUCK'
          ) {
            return res.status(400).json({
              error:
                'Own-truck arrangements are settled directly between the parties; no platform payment applies',
            });
          }

          if (
            order.transportJob.agreedAmount ==
            null
          ) {
            return res.status(400).json({
              error:
                'This transport job has no accepted quote yet',
            });
          }

          if (
            Math.abs(
              amount -
                Number(
                  order.transportJob
                    .agreedAmount
                )
            ) > 0.01
          ) {
            return res.status(400).json({
              error:
                'Amount must match the accepted transport quote',

              expectedAmount:
                Number(
                  order.transportJob
                    .agreedAmount
                ),
            });
          }

          const allowed =
            order.arrangingParty ===
            'BUYER'
              ? order.buyerId ===
                req.user.id
              : order.arrangingParty ===
                'SELLER'
              ? order.sellerId ===
                req.user.id
              : order.buyerId ===
                  req.user.id ||
                order.sellerId ===
                  req.user.id;

          if (
            !allowed &&
            !isAdmin(req.user)
          ) {
            return res.status(403).json({
              error:
                'Not authorized to pay for this transport',
            });
          }
        }
      }

      /* -------------------------------------------------------------------- */
      /* Digital payment                                                      */
      /* -------------------------------------------------------------------- */

      else if (type === 'DIGITAL') {
        if (!digitalProductId) {
          return res.status(400).json({
            error:
              'digitalProductId is required',
          });
        }

        const product =
          await prisma.digitalProduct.findUnique(
            {
              where: {
                id: digitalProductId,
              },
            }
          );

        if (
          !product ||
          product.status !== 'ACTIVE'
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
              'You cannot purchase your own product',
          });
        }

        if (
          Math.abs(
            amount -
              Number(product.price)
          ) > 0.01
        ) {
          return res.status(400).json({
            error:
              'Amount must match product price',

            expectedAmount:
              Number(product.price),
          });
        }
      }

      /* -------------------------------------------------------------------- */
      /* Advertising                                                          */
      /* -------------------------------------------------------------------- */

      else if (type === 'ADVERTISING') {
        if (!advertisementId) {
          return res.status(400).json({
            error:
              'advertisementId is required',
          });
        }

        const ad =
          await prisma.advertisement.findUnique(
            {
              where: {
                id: advertisementId,
              },
            }
          );

        if (!ad) {
          return res.status(404).json({
            error:
              'Advertisement not found',
          });
        }

        if (
          ad.advertiserId !==
            req.user.id &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({
            error: 'Not authorized',
          });
        }

        if (
          ad.amountPaid != null &&
          Math.abs(
            amount -
              Number(ad.amountPaid)
          ) > 0.01
        ) {
          return res.status(400).json({
            error:
              'Amount must match advertisement amount',

            expectedAmount:
              Number(ad.amountPaid),
          });
        }
      }

      /* -------------------------------------------------------------------- */
      /* Inspection                                                           */
      /* -------------------------------------------------------------------- */

      else if (type === 'INSPECTOR') {
        if (!inspectionRequestId) {
          return res.status(400).json({
            error:
              'inspectionRequestId is required',
          });
        }

        const request =
          await prisma.inspectionRequest.findUnique(
            {
              where: {
                id: inspectionRequestId,
              },
            }
          );

        if (!request) {
          return res.status(404).json({
            error:
              'Inspection request not found',
          });
        }

        if (
          request.requestedById !==
            req.user.id &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({
            error:
              'Only the person who requested the inspection may pay for it',
          });
        }

        if (request.fee == null) {
          return res.status(400).json({
            error:
              'This inspection has no agreed fee yet',
          });
        }

        if (
          Math.abs(
            amount -
              Number(request.fee)
          ) > 0.01
        ) {
          return res.status(400).json({
            error:
              'Amount must match the agreed inspection fee',

            expectedAmount:
              Number(request.fee),
          });
        }
      }

      /* -------------------------------------------------------------------- */
      /* Resource mismatch protection                                         */
      /* -------------------------------------------------------------------- */

      if (
        type !== 'MARKETPLACE' &&
        type !== 'TRANSPORT' &&
        type !== 'DIGITAL' &&
        type !== 'ADVERTISING' &&
        type !== 'INSPECTOR'
      ) {
        return res.status(400).json({
          error: 'Unsupported payment type',
        });
      }

      /* -------------------------------------------------------------------- */
      /* Determine whether this is a Chapa payment                            */
      /* -------------------------------------------------------------------- */

      const chapaType =
        chapaPaymentType(
          req.body.method
        );

      /*
       * QR and OTHER remain supported as manual payment records.
       *
       * TELEBIRR and CBE are sent to Chapa Direct Charge.
       */
      const isChapaPayment =
        Boolean(chapaType);

      if (
        isChapaPayment &&
        !requestedMobile
      ) {
        return res.status(400).json({
          error:
            'A mobile number is required for Chapa Telebirr/CBE payment',
        });
      }

      const mobile =
        normalizePhone(
          requestedMobile
        );

      if (
        isChapaPayment &&
        (!mobile ||
          !/^251\d{9}$/.test(mobile))
      ) {
        return res.status(400).json({
          error:
            'Enter a valid Ethiopian mobile number, for example 0912345678 or +251912345678',
        });
      }

      /* -------------------------------------------------------------------- */
      /* Prevent duplicate active payments                                    */
      /* -------------------------------------------------------------------- */

      const duplicate =
        await prisma.payment.findFirst({
          where: {
            createdById: req.user.id,

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
          },
        });

      if (duplicate) {
        return res.status(409).json({
          error:
            'An active payment already exists',
          payment: duplicate,
        });
      }

      /* -------------------------------------------------------------------- */
      /* Create local payment record first                                    */
      /* -------------------------------------------------------------------- */

      const payment =
        await prisma.payment.create({
          data: {
            createdById:
              req.user.id,

            type,

            amount,

            method:
              req.body.method,

            reference:
              reference || null,

            orderId:
              orderId || null,

            digitalProductId:
              digitalProductId ||
              null,

            advertisementId:
              advertisementId ||
              null,

            inspectionRequestId:
              inspectionRequestId ||
              null,

            status: 'PENDING',
          },
        });

      /* -------------------------------------------------------------------- */
      /* Manual payment                                                       */
      /* -------------------------------------------------------------------- */

      if (!isChapaPayment) {
        return res.status(201).json({
          message:
            'Payment intent created; it remains pending until manually reconciled or otherwise verified.',

          payment,

          paymentConfirmed:
            false,

          gateway:
            req.body.method === 'QR'
              ? 'QR'
              : 'MANUAL',

          chapa:
            getChapaConfig(),
        });
      }

      /* -------------------------------------------------------------------- */
      /* Chapa Direct Charge                                                 */
      /* -------------------------------------------------------------------- */

      const txRef =
        createTxRef(payment.id);

      try {
        const chapaResponse =
          await directCharge({
            type: chapaType,

            amount,

            mobile,

            txRef,

            currency: 'ETB',
          });

        /*
         * The Payment.reference stores our transaction reference.
         *
         * providerTransactionId stores Chapa's reference when one
         * is returned immediately.
         */
        const chapaReference =
          chapaResponse?.data
            ?.reference ||
          chapaResponse?.reference ||
          null;

        const updatedPayment =
          await prisma.payment.update({
            where: {
              id: payment.id,
            },

            data: {
              reference: txRef,

              provider: 'chapa',

              providerTransactionId:
                chapaReference,
            },
          });

        return res.status(201).json({
          message:
            'Chapa payment request submitted.',

          payment:
            updatedPayment,

          paymentConfirmed:
            false,

          gateway: 'CHAPA',

          chapa: {
            mode:
              getChapaConfig().mode,

            paymentMethod:
              chapaType,

            txRef,

            response:
              chapaResponse,
          },
        });
      } catch (gatewayError) {
        /*
         * The local payment exists, but Chapa rejected the charge.
         * Mark it failed instead of leaving an unusable PENDING record.
         */

        await prisma.payment.update({
          where: {
            id: payment.id,
          },

          data: {
            status: 'FAILED',

            reference: txRef,

            provider: 'chapa',
          },
        });

        return res.status(
          gatewayError.status >= 400 &&
          gatewayError.status < 600
            ? gatewayError.status
            : 502
        ).json({
          error:
            gatewayError.message ||
            'Chapa payment request failed',

          paymentId:
            payment.id,

          gateway:
            'CHAPA',

          details:
            gatewayError.response ||
            null,
        });
      }
    } catch (error) {
      console.error(
        'Payment creation error:',
        error
      );

      return res.status(500).json({
        error:
          'Could not create payment',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa transaction verification                                            */
/* -------------------------------------------------------------------------- */

/**
 * Verify a payment directly against Chapa.
 *
 * This is useful for:
 *
 * - testing
 * - recovering from missed webhooks
 * - checking a pending payment
 *
 * The payment is only marked PAID if:
 *
 * - Chapa says success
 * - amount matches
 * - currency is ETB
 * - tx_ref matches our payment reference
 */
router.post(
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
            id: req.params.id,
          },

          include: {
            order: true,
            digitalPurchase: true,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found',
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
          error: 'Not authorized',
        });
      }

      if (
        payment.provider !==
        'chapa'
      ) {
        return res.status(400).json({
          error:
            'This payment was not created through Chapa',
        });
      }

      if (!payment.reference) {
        return res.status(400).json({
          error:
            'This Chapa payment has no transaction reference',
        });
      }

      const chapa =
        await verifyPayment(
          payment.reference
        );

      const chapaStatus =
        String(
          chapa?.data?.status ||
          chapa?.status ||
          ''
        ).toLowerCase();

      const chapaAmount =
        Number(
          chapa?.data?.amount ??
          chapa?.amount ??
          0
        );

      const chapaTxRef =
        chapa?.data?.tx_ref ||
        chapa?.tx_ref ||
        null;

      if (
        chapaTxRef &&
        chapaTxRef !==
          payment.reference
      ) {
        return res.status(409).json({
          error:
            'Chapa transaction reference does not match this payment',
        });
      }

      if (
        chapaAmount > 0 &&
        Math.abs(
          chapaAmount -
            Number(payment.amount)
        ) > 0.01
      ) {
        return res.status(409).json({
          error:
            'Chapa payment amount does not match MarketBridge payment',

          expectedAmount:
            Number(payment.amount),

          chapaAmount,
        });
      }

      const newStatus =
        mapChapaStatus(
          chapaStatus
        );

      if (!newStatus) {
        return res.json({
          message:
            'Chapa payment is still pending or returned an unrecognized status.',

          payment,

          chapa,
        });
      }

      const updated =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.payment.findUnique(
                {
                  where: {
                    id: payment.id,
                  },

                  include: {
                    order: true,
                    digitalPurchase:
                      true,
                    advertisement:
                      true,
                  },
                }
              );

            return finalizePayment(
              tx,
              current,
              newStatus,
              {
                provider:
                  'chapa',

                reference:
                  chapa?.data
                    ?.reference ||
                  chapa?.reference ||
                  payment.reference,

                providerTransactionId:
                  chapa?.data
                    ?.reference ||
                  chapa?.reference ||
                  payment.providerTransactionId,
              }
            );
          }
        );

      return res.json({
        message:
          'Chapa payment verified.',

        payment:
          updated,

        chapa,
      });
    } catch (error) {
      console.error(
        'Chapa verification error:',
        error
      );

      return res.status(
        error.status || 502
      ).json({
        error:
          error.message ||
          'Could not verify payment with Chapa',

        details:
          error.response ||
          null,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa webhook                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Chapa webhook.
 *
 * Configure this URL in Chapa Dashboard:
 *
 * /api/payments/webhooks/chapa
 *
 * depending on how payments.js is mounted.
 */
router.post(
  '/webhooks/chapa',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    try {
      if (
        !verifyChapaWebhookSignature(
          req
        )
      ) {
        return res.status(401).json({
          error:
            'Invalid Chapa webhook signature',
        });
      }

      const event =
        req.body || {};

      const eventName =
        String(
          event.event || ''
        ).toLowerCase();

      const txRef =
        event.tx_ref ||
        event.reference ||
        null;

      if (!txRef) {
        return res.status(400).json({
          error:
            'Webhook transaction reference missing',
        });
      }

      const payment =
        await prisma.payment.findFirst(
          {
            where: {
              OR: [
                {
                  reference: txRef,
                },

                {
                  providerTransactionId:
                    txRef,
                },
              ],
            },

            include: {
              order: true,
              digitalPurchase: true,
              advertisement: true,
            },
          }
        );

      if (!payment) {
        /*
         * Acknowledge the webhook so Chapa does not
         * repeatedly retry an event for a transaction
         * MarketBridge does not know.
         */
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason:
            'Payment not found in MarketBridge',
        });
      }

      /*
       * Always verify the transaction with Chapa
       * before granting value.
       */
      let verified;

      try {
        verified =
          await verifyPayment(
            payment.reference
          );
      } catch (verificationError) {
        console.error(
          'Chapa webhook verification failed:',
          verificationError
        );

        return res.status(502).json({
          error:
            'Could not verify Chapa transaction',
        });
      }

      const verifiedData =
        verified?.data ||
        verified ||
        {};

      const verifiedStatus =
        String(
          verifiedData.status ||
          ''
        ).toLowerCase();

      const verifiedAmount =
        Number(
          verifiedData.amount ??
          0
        );

      const verifiedTxRef =
        verifiedData.tx_ref ||
        null;

      if (
        verifiedTxRef &&
        verifiedTxRef !==
          payment.reference
      ) {
        return res.status(409).json({
          error:
            'Verified transaction reference mismatch',
        });
      }

      if (
        verifiedAmount > 0 &&
        Math.abs(
          verifiedAmount -
            Number(payment.amount)
        ) > 0.01
      ) {
        return res.status(409).json({
          error:
            'Verified payment amount mismatch',
        });
      }

      const mappedStatus =
        mapChapaStatus(
          verifiedStatus
        );

      if (!mappedStatus) {
        return res.status(200).json({
          ok: true,
          paymentStatus:
            payment.status,
          chapaStatus:
            verifiedStatus,
        });
      }

      const updated =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.payment.findUnique(
                {
                  where: {
                    id: payment.id,
                  },

                  include: {
                    order: true,
                    digitalPurchase:
                      true,
                    advertisement:
                      true,
                  },
                }
              );

            return finalizePayment(
              tx,
              current,
              mappedStatus,
              {
                provider:
                  'chapa',

                reference:
                  verifiedData.reference ||
                  payment.reference,

                providerTransactionId:
                  verifiedData.reference ||
                  payment.providerTransactionId,
              }
            );
          }
        );

      return res.status(200).json({
        ok: true,
        payment: updated,
      });
    } catch (error) {
      console.error(
        'Chapa webhook error:',
        error
      );

      return res.status(500).json({
        error:
          'Webhook processing failed',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Generic signed webhook                                                     */
/* -------------------------------------------------------------------------- */

router.post(
  '/webhooks/generic',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    const secret =
      process.env.PAYMENT_WEBHOOK_SECRET;

    if (!secret) {
      return res.status(401).json({
        error:
          'Payment webhook secret is not configured',
      });
    }

    const rawBody =
      req.rawBody ||
      Buffer.from(
        JSON.stringify(
          req.body
        )
      );

    const expected =
      crypto
        .createHmac(
          'sha256',
          secret
        )
        .update(rawBody)
        .digest('hex');

    const supplied =
      req.headers[
        'x-marketbridge-signature'
      ];

    if (
      typeof supplied !==
        'string' ||
      !timingSafeEqual(
        supplied,
        expected
      )
    ) {
      return res.status(401).json({
        error:
          'Invalid webhook signature',
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
      ].includes(status)
    ) {
      return res.status(400).json({
        error:
          'Invalid webhook payload',
      });
    }

    try {
      const result =
        await prisma.$transaction(
          async (tx) => {
            const payment =
              await tx.payment.findUnique(
                {
                  where: {
                    id: paymentId,
                  },

                  include: {
                    order: true,
                    digitalPurchase:
                      true,
                    advertisement: true,
                  },
                }
              );

            return finalizePayment(
              tx,
              payment,
              status,
              {
                provider,
                reference,
                providerTransactionId,
              }
            );
          }
        );

      return res.json({
        ok: true,
        payment: result,
      });
    } catch (error) {
      return res.status(
        error.status || 500
      ).json({
        error:
          error.status
            ? error.message
            : 'Webhook processing failed',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Admin payment queue                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  '/',
  authenticate,

  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        error:
          'Only an administrator can view all payments',
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
              phone: true,
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
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    return res.json({
      payments,
      count: payments.length,
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Commission summary                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  '/commissions/summary',
  authenticate,

  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        error:
          'Only an administrator can view commission records',
      });
    }

    const paid =
      await prisma.payment.findMany({
        where: {
          status: 'PAID',
        },

        select: {
          type: true,
          amount: true,
          commissionAmount: true,
        },
      });

    const byType = {};

    let totalCommission = 0;
    let totalVolume = 0;

    for (const payment of paid) {
      const type =
        byType[payment.type] || {
          volume: 0,
          commission: 0,
          count: 0,
        };

      type.volume += Number(
        payment.amount
      );

      type.commission += Number(
        payment.commissionAmount || 0
      );

      type.count += 1;

      byType[payment.type] =
        type;

      totalVolume += Number(
        payment.amount
      );

      totalCommission += Number(
        payment.commissionAmount || 0
      );
    }

    return res.json({
      totalVolume,
      totalCommission,
      byType,
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Manual admin reconciliation                                               */
/* -------------------------------------------------------------------------- */

router.patch(
  '/:id/confirm',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        error:
          'Only an administrator can perform manual payment reconciliation',
      });
    }

    const payment =
      await prisma.payment.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          order: true,
          digitalPurchase: true,
          advertisement: true,
        },
      });

    if (!payment) {
      return res.status(404).json({
        error: 'Payment not found',
      });
    }

    if (
      payment.status !==
      'PENDING'
    ) {
      return res.status(409).json({
        error:
          `Payment is already ${payment.status}`,
      });
    }

    try {
      const updated =
        await prisma.$transaction(
          async (tx) => {
            return finalizePayment(
              tx,
              payment,
              'PAID',
              {
                provider:
                  payment.provider ||
                  'manual',
                reference:
                  payment.reference,
                providerTransactionId:
                  payment.providerTransactionId,
              }
            );
          }
        );

      return res.json({
        message:
          'Payment manually reconciled. Prefer signed provider webhooks or direct Chapa verification in production.',

        payment:
          updated,
      });
    } catch (error) {
      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Could not reconcile payment',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Payments belonging to an order                                             */
/* -------------------------------------------------------------------------- */

router.get(
  '/order/:orderId',
  authenticate,

  [
    param('orderId').isUUID(),
  ],

  validate,

  async (req, res) => {
    const order =
      await prisma.order.findUnique({
        where: {
          id: req.params.orderId,
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

    const payments =
      await prisma.payment.findMany({
        where: {
          orderId: order.id,
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    return res.json({
      payments,
      count: payments.length,
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Single payment                                                             */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    const payment =
      await prisma.payment.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          order: true,
          digitalPurchase: true,
        },
      });

    if (!payment) {
      return res.status(404).json({
        error: 'Payment not found',
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
        error: 'Not authorized',
      });
    }

    return res.json({
      payment,
    });
  }
);

module.exports = router;
