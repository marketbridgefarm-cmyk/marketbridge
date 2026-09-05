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

/* ---------------------------------------------------------
   Validation
--------------------------------------------------------- */

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

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

function timingSafeEqual(a, b) {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
}

function verifySignature(req) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const raw =
    req.rawBody ||
    Buffer.from(JSON.stringify(req.body));

  const expected = crypto
    .createHmac('sha256', secret)
    .update(raw)
    .digest('hex');

  const supplied =
    req.headers['x-marketbridge-signature'];

  return (
    typeof supplied === 'string' &&
    timingSafeEqual(supplied, expected)
  );
}

function generateTxRef(paymentId) {
  return `MB-${paymentId}-${Date.now()}`;
}

function normalizePhone(phone) {
  if (!phone) return '';

  let value = String(phone).trim();

  value = value.replace(/\s+/g, '');

  if (value.startsWith('+251')) {
    return `0${value.slice(4)}`;
  }

  if (value.startsWith('251')) {
    return `0${value.slice(3)}`;
  }

  return value;
}

function isChapaMethod(method) {
  return (
    String(method || '').toUpperCase() === 'TELEBIRR' ||
    String(method || '').toUpperCase() === 'CBE'
  );
}

/* ---------------------------------------------------------
   Payment resource validation
--------------------------------------------------------- */

async function validatePaymentResource({
  req,
  type,
  amount,
  orderId,
  digitalProductId,
  advertisementId,
  inspectionRequestId,
}) {
  if (type === 'MARKETPLACE' || type === 'TRANSPORT') {
    if (!orderId) {
      return {
        error: `${type} payment requires orderId`,
      };
    }

    const order = await prisma.order.findUnique({
      where: {
        id: orderId,
      },
      include: {
        transportJob: true,
      },
    });

    if (!order) {
      return {
        status: 404,
        error: 'Order not found',
      };
    }

    if (
      !isOrderParticipant(req.user.id, order) &&
      !isAdmin(req.user)
    ) {
      return {
        status: 403,
        error: 'Not authorized',
      };
    }

    if (type === 'MARKETPLACE') {
      if (
        order.buyerId !== req.user.id &&
        !isAdmin(req.user)
      ) {
        return {
          status: 403,
          error:
            'Only the buyer may create the marketplace payment',
        };
      }

      if (
        Math.abs(
          amount - Number(order.finalPrice)
        ) > 0.01
      ) {
        return {
          status: 400,
          error:
            'Amount must match order final price',
          expectedAmount:
            Number(order.finalPrice),
        };
      }
    }

    if (type === 'TRANSPORT') {
      if (!order.transportJob) {
        return {
          status: 400,
          error: 'Transport job required',
        };
      }

      if (
        order.transportJob.method === 'OWN_TRUCK'
      ) {
        return {
          status: 400,
          error:
            'Own-truck arrangements are settled directly between the parties; no platform payment applies',
        };
      }

      if (
        order.transportJob.agreedAmount == null
      ) {
        return {
          status: 400,
          error:
            'This transport job has no accepted quote yet',
        };
      }

      if (
        Math.abs(
          amount -
            Number(order.transportJob.agreedAmount)
        ) > 0.01
      ) {
        return {
          status: 400,
          error:
            'Amount must match the accepted transport quote',
          expectedAmount:
            Number(order.transportJob.agreedAmount),
        };
      }

      let allowed = false;

      if (order.arrangingParty === 'BUYER') {
        allowed =
          order.buyerId === req.user.id;
      } else if (
        order.arrangingParty === 'SELLER'
      ) {
        allowed =
          order.sellerId === req.user.id;
      } else if (
        order.arrangingParty === 'JOINT'
      ) {
        allowed =
          order.buyerId === req.user.id ||
          order.sellerId === req.user.id;
      }

      if (!allowed && !isAdmin(req.user)) {
        return {
          status: 403,
          error:
            'Not authorized to pay for this transport',
        };
      }
    }

    return {
      order,
    };
  }

  if (type === 'DIGITAL') {
    if (!digitalProductId) {
      return {
        status: 400,
        error: 'digitalProductId is required',
      };
    }

    const product =
      await prisma.digitalProduct.findUnique({
        where: {
          id: digitalProductId,
        },
      });

    if (
      !product ||
      product.status !== 'ACTIVE'
    ) {
      return {
        status: 404,
        error: 'Digital product not found',
      };
    }

    if (product.sellerId === req.user.id) {
      return {
        status: 400,
        error:
          'You cannot purchase your own product',
      };
    }

    if (
      Math.abs(
        amount - Number(product.price)
      ) > 0.01
    ) {
      return {
        status: 400,
        error:
          'Amount must match product price',
        expectedAmount:
          Number(product.price),
      };
    }

    return {
      product,
    };
  }

  if (type === 'ADVERTISING') {
    if (!advertisementId) {
      return {
        status: 400,
        error: 'advertisementId is required',
      };
    }

    const ad =
      await prisma.advertisement.findUnique({
        where: {
          id: advertisementId,
        },
      });

    if (!ad) {
      return {
        status: 404,
        error: 'Advertisement not found',
      };
    }

    if (
      ad.advertiserId !== req.user.id &&
      !isAdmin(req.user)
    ) {
      return {
        status: 403,
        error: 'Not authorized',
      };
    }

    if (
      ad.amountPaid != null &&
      Math.abs(
        amount - Number(ad.amountPaid)
      ) > 0.01
    ) {
      return {
        status: 400,
        error:
          'Amount must match advertisement amount',
        expectedAmount:
          Number(ad.amountPaid),
      };
    }

    return {
      advertisement: ad,
    };
  }

  if (type === 'INSPECTOR') {
    if (!inspectionRequestId) {
      return {
        status: 400,
        error:
          'inspectionRequestId is required',
      };
    }

    const request =
      await prisma.inspectionRequest.findUnique({
        where: {
          id: inspectionRequestId,
        },
      });

    if (!request) {
      return {
        status: 404,
        error:
          'Inspection request not found',
      };
    }

    if (
      request.requestedById !== req.user.id &&
      !isAdmin(req.user)
    ) {
      return {
        status: 403,
        error:
          'Only the person who requested the inspection may pay for it',
      };
    }

    if (request.fee == null) {
      return {
        status: 400,
        error:
          'This inspection has no agreed fee yet',
      };
    }

    if (
      Math.abs(
        amount - Number(request.fee)
      ) > 0.01
    ) {
      return {
        status: 400,
        error:
          'Amount must match the agreed inspection fee',
        expectedAmount:
          Number(request.fee),
      };
    }

    return {
      inspectionRequest: request,
    };
  }

  return {};
}

/* ---------------------------------------------------------
   CREATE PAYMENT
--------------------------------------------------------- */

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

    body('mobile')
      .optional()
      .isString()
      .trim()
      .isLength({
        min: 9,
        max: 20,
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

      const amount =
        Number(req.body.amount);

      const method =
        String(req.body.method).toUpperCase();

      const resource =
        await validatePaymentResource({
          req,
          type,
          amount,
          orderId,
          digitalProductId,
          advertisementId,
          inspectionRequestId,
        });

      if (resource.error) {
        return res.status(
          resource.status || 400
        ).json({
          error: resource.error,
          ...(resource.expectedAmount != null
            ? {
                expectedAmount:
                  resource.expectedAmount,
              }
            : {}),
        });
      }

      /*
       * Prevent the same user from creating
       * multiple active payments for the same
       * marketplace resource.
       */
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

            ...(orderId
              ? {
                  orderId,
                }
              : {}),

            ...(digitalProductId
              ? {
                  digitalProductId,
                }
              : {}),

            ...(advertisementId
              ? {
                  advertisementId,
                }
              : {}),

            ...(inspectionRequestId
              ? {
                  inspectionRequestId,
                }
              : {}),
          },
        });

      if (duplicate) {
        return res.status(409).json({
          error:
            'An active payment already exists',
          payment: duplicate,
        });
      }

      /*
       * QR and OTHER are retained as manual/
       * alternative payment methods.
       *
       * Chapa Direct Charge is used only for
       * TELEBIRR and CBE.
       */
      const payment =
        await prisma.payment.create({
          data: {
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

            status: 'PENDING',

            provider:
              isChapaMethod(method)
                ? 'CHAPA'
                : null,
          },
        });

      /*
       * Non-Chapa payment methods:
       *
       * Keep the payment pending.
       * Admin/manual reconciliation remains
       * available through the existing endpoint.
       */
      if (!isChapaMethod(method)) {
        return res.status(201).json({
          message:
            'Payment intent created; it is pending confirmation.',
          payment,
          paymentConfirmed: false,
          provider:
            method === 'QR'
              ? 'QR'
              : 'MANUAL',
          requiresGateway: false,
        });
      }

      /*
       * Chapa Direct Charge
       *
       * We need the customer's phone number.
       */
      let mobile =
        req.body.mobile ||
        req.user.phone ||
        null;

      mobile = normalizePhone(mobile);

      if (!mobile) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
          },
        });

        return res.status(400).json({
          error:
            'A mobile number is required for Chapa Telebirr/CBE payment. Please provide mobile or add a phone number to your account.',
          paymentId:
            payment.id,
        });
      }

      /*
       * Generate a unique Chapa transaction
       * reference.
       */
      const txRef =
        generateTxRef(payment.id);

      const chapaType =
        chapaPaymentType(method);

      if (!chapaType) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
          },
        });

        return res.status(400).json({
          error:
            'Unsupported Chapa payment method',
        });
      }

      /*
       * Save the Chapa transaction reference
       * before calling Chapa.
       */
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          reference: txRef,
          provider: 'CHAPA',
        },
      });

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
         * Chapa may return a reference/request
         * token or authorization information.
         *
         * Do NOT mark the payment PAID here.
         *
         * Chapa requires authorization/verification.
         */
        return res.status(201).json({
          message:
            'Chapa payment initiated. Complete the authorization and verify the transaction before the order is confirmed.',

          payment: {
            ...payment,
            reference: txRef,
            provider: 'CHAPA',
            status: 'PENDING',
          },

          paymentConfirmed: false,

          provider: 'CHAPA',

          mode:
            getChapaConfig().mode,

          chapa: chapaResponse,

          txRef,

          paymentMethod:
            chapaType,

          nextStep:
            'AUTHORIZE_OR_VERIFY',
        });
      } catch (chapaError) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
          },
        });

        return res.status(
          chapaError.status || 502
        ).json({
          error:
            chapaError.message ||
            'Chapa payment initiation failed',

          paymentId:
            payment.id,

          provider:
            'CHAPA',

          response:
            chapaError.response || null,
        });
      }
    } catch (error) {
      console.error(
        'Create payment error:',
        error
      );

      return res.status(500).json({
        error:
          'Could not create payment',
      });
    }
  }
);

/* ---------------------------------------------------------
   CHAPA AUTHORIZE
--------------------------------------------------------- */

/*
 * This endpoint is intentionally separate from
 * payment creation.
 *
 * The Direct Charge flow is:
 *
 * 1. POST /payments
 * 2. Chapa charge initiation
 * 3. Customer authorization
 * 4. Chapa verification
 * 5. MarketBridge marks payment PAID
 *
 * The exact authorization payload can vary by
 * Chapa payment method and whether Chapa returns
 * an OTP/request token.
 */
router.post(
  '/chapa/authorize',
  authenticate,
  [
    body('paymentId').isUUID(),

    body('client')
      .optional()
      .isString(),

    body('reference')
      .optional()
      .isString(),

    body('requestId')
      .optional()
      .isString(),

    body('otp')
      .optional()
      .isString()
      .isLength({
        min: 1,
        max: 20,
      }),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        paymentId,
        client,
        reference,
        requestId,
        otp,
      } = req.body;

      const payment =
        await prisma.payment.findUnique({
          where: {
            id: paymentId,
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
        payment.provider !==
        'CHAPA'
      ) {
        return res.status(400).json({
          error:
            'This payment is not a Chapa payment',
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

      /*
       * If Chapa has already completed the
       * transaction, verification is enough.
       *
       * This route does not mark PAID based
       * only on client input.
       */
      if (
        !client &&
        !otp &&
        !requestId
      ) {
        return res.status(400).json({
          error:
            'Chapa authorization data is required when the transaction requires authorization',
        });
      }

      /*
       * Chapa's authorization endpoint requires
       * encrypted sensitive data for OTP-style
       * authorization.
       *
       * We deliberately do not accept or construct
       * a fake authorization request here.
       *
       * Verification remains the source of truth.
       */
      let txRef =
        reference ||
        payment.reference;

      if (!txRef) {
        return res.status(400).json({
          error:
            'Payment does not have a Chapa transaction reference',
        });
      }

      /*
       * Verify the transaction with Chapa.
       */
      let verification;

      try {
        verification =
          await verifyPayment(
            txRef
          );
      } catch (verificationError) {
        return res.status(
          verificationError.status ||
            502
        ).json({
          error:
            verificationError.message ||
            'Could not verify payment with Chapa',

          response:
            verificationError.response ||
            null,
        });
      }

      const verifiedStatus =
        String(
          verification?.data?.status ||
            verification?.status ||
            ''
        ).toLowerCase();

      if (
        verifiedStatus !==
          'success' &&
        verifiedStatus !==
          'successful' &&
        verifiedStatus !==
          'paid'
      ) {
        return res.status(409).json({
          error:
            'Chapa has not confirmed this payment as successful',
          payment,
          verification,
        });
      }

      /*
       * Finalize the payment only after
       * Chapa verification.
       */
      const result =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.payment.findUnique({
                where: {
                  id: payment.id,
                },
              });

            if (!current) {
              throw new Error(
                'Payment not found'
              );
            }

            if (
              current.status ===
              'PAID'
            ) {
              return current;
            }

            const commission =
              commissionFor(
                current.type,
                current.amount
              );

            const updated =
              await tx.payment.update({
                where: {
                  id:
                    current.id,
                },

                data: {
                  status: 'PAID',

                  provider:
                    'CHAPA',

                  providerTransactionId:
                    verification?.data
                      ?.reference ||
                    verification?.reference ||
                    null,

                  reference:
                    txRef,

                  commissionRate:
                    commission.rate,

                  commissionAmount:
                    commission.commissionAmount,
                },
              });

            if (
              current.type ===
                'MARKETPLACE' &&
              current.orderId
            ) {
              await tx.order.updateMany({
                where: {
                  id:
                    current.orderId,

                  status:
                    'PENDING_PAYMENT',
                },

                data: {
                  status:
                    'CONFIRMED',
                },
              });
            }

            if (
              current.type ===
                'DIGITAL'
            ) {
              const purchase =
                await tx.digitalPurchase.findUnique(
                  {
                    where: {
                      paymentId:
                        current.id,
                    },
                  }
                );

              if (purchase) {
                await tx.digitalPurchase.update(
                  {
                    where: {
                      id:
                        purchase.id,
                    },

                    data: {
                      status:
                        'COMPLETED',
                    },
                  }
                );
              }
            }

            if (
              current.type ===
                'ADVERTISING' &&
              current.advertisementId
            ) {
              await tx.advertisement.update(
                {
                  where: {
                    id:
                      current.advertisementId,
                  },

                  data: {
                    amountPaid:
                      current.amount,
                  },
                }
              );
            }

            return updated;
          }
        );

      return res.json({
        message:
          'Payment verified and confirmed',
        payment: result,
        paymentConfirmed: true,
        verification,
      });
    } catch (error) {
      console.error(
        'Chapa authorization error:',
        error
      );

      return res.status(500).json({
        error:
          'Chapa authorization/verification failed',
      });
    }
  }
);

/* ---------------------------------------------------------
   CHAPA VERIFY
--------------------------------------------------------- */

router.post(
  '/chapa/verify',
  authenticate,
  [
    body('paymentId').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        paymentId,
      } = req.body;

      const payment =
        await prisma.payment.findUnique({
          where: {
            id: paymentId,
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
        payment.provider !==
        'CHAPA'
      ) {
        return res.status(400).json({
          error:
            'This payment is not a Chapa payment',
        });
      }

      if (!payment.reference) {
        return res.status(400).json({
          error:
            'Payment has no Chapa transaction reference',
        });
      }

      const verification =
        await verifyPayment(
          payment.reference
        );

      const chapaStatus =
        String(
          verification?.data?.status ||
            verification?.status ||
            ''
        ).toLowerCase();

      if (
        chapaStatus ===
          'success' ||
        chapaStatus ===
          'successful' ||
        chapaStatus ===
          'paid'
      ) {
        const result =
          await prisma.$transaction(
            async (tx) => {
              const current =
                await tx.payment.findUnique({
                  where: {
                    id:
                      payment.id,
                  },
                });

              if (!current) {
                throw new Error(
                  'Payment not found'
                );
              }

              if (
                current.status ===
                'PAID'
              ) {
                return current;
              }

              const commission =
                commissionFor(
                  current.type,
                  current.amount
                );

              const updated =
                await tx.payment.update({
                  where: {
                    id:
                      current.id,
                  },

                  data: {
                    status:
                      'PAID',

                    provider:
                      'CHAPA',

                    providerTransactionId:
                      verification?.data
                        ?.reference ||
                      verification?.reference ||
                      null,

                    commissionRate:
                      commission.rate,

                    commissionAmount:
                      commission.commissionAmount,
                  },
                });

              if (
                current.type ===
                  'MARKETPLACE' &&
                current.orderId
              ) {
                await tx.order.updateMany({
                  where: {
                    id:
                      current.orderId,

                    status:
                      'PENDING_PAYMENT',
                  },

                  data: {
                    status:
                      'CONFIRMED',
                  },
                });
              }

              if (
                current.type ===
                  'DIGITAL'
              ) {
                const purchase =
                  await tx.digitalPurchase.findUnique(
                    {
                      where: {
                        paymentId:
                          current.id,
                      },
                    }
                  );

                if (purchase) {
                  await tx.digitalPurchase.update(
                    {
                      where: {
                        id:
                          purchase.id,
                      },

                      data: {
                        status:
                          'COMPLETED',
                      },
                    }
                  );
                }
              }

              if (
                current.type ===
                  'ADVERTISING' &&
                current.advertisementId
              ) {
                await tx.advertisement.update(
                  {
                    where: {
                      id:
                        current.advertisementId,
                    },

                    data: {
                      amountPaid:
                        current.amount,
                    },
                  }
                );
              }

              return updated;
            }
          );

        return res.json({
          message:
            'Chapa payment verified and confirmed',
          payment:
            result,
          paymentConfirmed:
            true,
          verification,
        });
      }

      /*
       * Do not immediately mark a transaction
       * failed just because verification is not
       * currently successful. Mobile-money
       * transactions can still be pending.
       */
      return res.json({
        message:
          'Chapa transaction has not been confirmed as successful yet',
        payment,
        paymentConfirmed:
          false,
        verification,
      });
    } catch (error) {
      console.error(
        'Chapa verify error:',
        error
      );

      return res.status(
        error.status || 502
      ).json({
        error:
          error.message ||
          'Could not verify payment with Chapa',

        response:
          error.response ||
          null,
      });
    }
  }
);

/* ---------------------------------------------------------
   CHAPA WEBHOOK
--------------------------------------------------------- */

/*
 * Chapa's webhook documentation describes
 * charge.success / charge.refunded /
 * charge.reversed / charge.failed events.
 *
 * We accept the webhook only when the optional
 * MarketBridge webhook secret is configured.
 */
router.post(
  '/webhooks/chapa',
  express.json({
    limit: '100kb',
  }),
  async (req, res) => {
    try {
      if (
        !verifySignature(req)
      ) {
        return res.status(401).json({
          error:
            'Invalid webhook signature',
        });
      }

      const event =
        req.body?.event;

      const txRef =
        req.body?.tx_ref ||
        req.body?.reference;

      if (!txRef) {
        return res.status(400).json({
          error:
            'Chapa webhook does not contain a transaction reference',
        });
      }

      const payment =
        await prisma.payment.findFirst({
          where: {
            OR: [
              {
                reference:
                  txRef,
              },
              {
                providerTransactionId:
                  txRef,
              },
            ],
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'MarketBridge payment not found',
        });
      }

      /*
       * Never trust webhook success alone.
       *
       * Verify the transaction against Chapa.
       */
      if (
        event ===
        'charge.success'
      ) {
        const verification =
          await verifyPayment(
            payment.reference
          );

        const status =
          String(
            verification?.data
              ?.status ||
              verification?.status ||
              ''
          ).toLowerCase();

        if (
          status !==
            'success' &&
          status !==
            'successful' &&
          status !==
            'paid'
        ) {
          return res.status(409).json({
            error:
              'Webhook indicated success, but Chapa verification did not confirm success',
          });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const current =
                await tx.payment.findUnique({
                  where: {
                    id:
                      payment.id,
                  },
                });

              if (
                !current
              ) {
                throw new Error(
                  'Payment not found'
                );
              }

              if (
                current.status ===
                'PAID'
              ) {
                return current;
              }

              const commission =
                commissionFor(
                  current.type,
                  current.amount
                );

              const updated =
                await tx.payment.update({
                  where: {
                    id:
                      current.id,
                  },

                  data: {
                    status:
                      'PAID',

                    provider:
                      'CHAPA',

                    providerTransactionId:
                      req.body
                        ?.reference ||
                      current.providerTransactionId,

                    commissionRate:
                      commission.rate,

                    commissionAmount:
                      commission.commissionAmount,
                  },
                });

              if (
                current.type ===
                  'MARKETPLACE' &&
                current.orderId
              ) {
                await tx.order.updateMany({
                  where: {
                    id:
                      current.orderId,

                    status:
                      'PENDING_PAYMENT',
                  },

                  data: {
                    status:
                      'CONFIRMED',
                  },
                });
              }

              if (
                current.type ===
                  'DIGITAL'
              ) {
                const purchase =
                  await tx.digitalPurchase.findUnique(
                    {
                      where: {
                        paymentId:
                          current.id,
                      },
                    }
                  );

                if (purchase) {
                  await tx.digitalPurchase.update(
                    {
                      where: {
                        id:
                          purchase.id,
                      },

                      data: {
                        status:
                          'COMPLETED',
                      },
                    }
                  );
                }
              }

              if (
                current.type ===
                  'ADVERTISING' &&
                current.advertisementId
              ) {
                await tx.advertisement.update(
                  {
                    where: {
                      id:
                        current.advertisementId,
                    },

                    data: {
                      amountPaid:
                        current.amount,
                    },
                  }
                );
              }

              return updated;
            }
          );

        return res.json({
          ok: true,
          payment:
            result,
        });
      }

      if (
        event ===
          'charge.failed/cancelled' ||
        event ===
          'charge.reversed'
      ) {
        const updated =
          await prisma.payment.update({
            where: {
              id:
                payment.id,
            },

            data: {
              status:
                'FAILED',
            },
          });

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      if (
        event ===
        'charge.refunded'
      ) {
        const updated =
          await prisma.payment.update({
            where: {
              id:
                payment.id,
            },

            data: {
              status:
                'REFUNDED',
            },
          });

        if (
          payment.type ===
          'DIGITAL'
        ) {
          const purchase =
            await prisma.digitalPurchase.findUnique(
              {
                where: {
                  paymentId:
                    payment.id,
                },
              }
            );

          if (purchase) {
            await prisma.digitalPurchase.update({
              where: {
                id:
                  purchase.id,
              },

              data: {
                status:
                  'REFUNDED',
              },
            });
          }
        }

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      /*
       * Unknown Chapa event:
       * acknowledge without changing
       * the payment.
       */
      return res.json({
        ok: true,
        ignored: true,
        event,
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

/* ---------------------------------------------------------
   GENERIC WEBHOOK
--------------------------------------------------------- */

router.post(
  '/webhooks/generic',
  express.json({
    limit: '100kb',
  }),
  async (req, res) => {
    if (
      !verifySignature(req)
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
              await tx.payment.findUnique({
                where: {
                  id:
                    paymentId,
                },

                include: {
                  order:
                    true,
                  digitalPurchase:
                    true,
                  advertisement:
                    true,
                },
              });

            if (!payment) {
              throw Object.assign(
                new Error(
                  'Payment not found'
                ),
                {
                  status:
                    404,
                }
              );
            }

            if (
              payment.status ===
                'PAID' &&
              status ===
                'PAID'
            ) {
              return payment;
            }

            if (
              payment.status ===
                'REFUNDED' &&
              status !==
                'REFUNDED'
            ) {
              throw Object.assign(
                new Error(
                  'Refunded payment cannot be reopened'
                ),
                {
                  status:
                    409,
                }
              );
            }

            const commission =
              status ===
              'PAID'
                ? commissionFor(
                    payment.type,
                    payment.amount
                  )
                : {
                    rate:
                      payment.commissionRate,
                    commissionAmount:
                      payment.commissionAmount,
                  };

            const updated =
              await tx.payment.update({
                where: {
                  id:
                    payment.id,
                },

                data: {
                  status,

                  reference:
                    reference ||
                    payment.reference,

                  provider:
                    provider ||
                    payment.provider,

                  providerTransactionId:
                    providerTransactionId ||
                    payment.providerTransactionId,

                  ...(status ===
                    'PAID'
                    ? {
                        commissionRate:
                          commission.rate,

                        commissionAmount:
                          commission.commissionAmount,
                      }
                    : {}),
                },
              });

            if (
              status ===
              'PAID'
            ) {
              if (
                payment.type ===
                  'MARKETPLACE' &&
                payment.orderId
              ) {
                await tx.order.updateMany({
                  where: {
                    id:
                      payment.orderId,

                    status:
                      'PENDING_PAYMENT',
                  },

                  data: {
                    status:
                      'CONFIRMED',
                  },
                });
              }

              if (
                payment.type ===
                  'DIGITAL' &&
                payment.digitalPurchase
              ) {
                await tx.digitalPurchase.update({
                  where: {
                    id:
                      payment
                        .digitalPurchase
                        .id,
                  },

                  data: {
                    status:
                      'COMPLETED',
                  },
                });
              }

              if (
                payment.type ===
                  'ADVERTISING' &&
                payment.advertisement
              ) {
                await tx.advertisement.update({
                  where: {
                    id:
                      payment
                        .advertisement
                        .id,
                  },

                  data: {
                    amountPaid:
                      payment.amount,
                  },
                });
              }
            }

            if (
              status ===
                'REFUNDED' &&
              payment.digitalPurchase
            ) {
              await tx.digitalPurchase.update({
                where: {
                  id:
                    payment
                      .digitalPurchase
                      .id,
                },

                data: {
                  status:
                    'REFUNDED',
                },
              });
            }

            return updated;
          }
        );

      return res.json({
        ok: true,
        payment:
          result,
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

/* ---------------------------------------------------------
   ADMIN PAYMENT QUEUE
--------------------------------------------------------- */

router.get(
  '/',
  authenticate,
  async (req, res) => {
    if (
      !isAdmin(req.user)
    ) {
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
          ...(status
            ? {
                status,
              }
            : {}),
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
        },

        orderBy: {
          createdAt:
            'desc',
        },
      });

    res.json({
      payments,
      count:
        payments.length,
    });
  }
);

/* ---------------------------------------------------------
   ADMIN COMMISSION SUMMARY
--------------------------------------------------------- */

router.get(
  '/commissions/summary',
  authenticate,
  async (req, res) => {
    if (
      !isAdmin(req.user)
    ) {
      return res.status(403).json({
        error:
          'Only an administrator can view commission records',
      });
    }

    const paid =
      await prisma.payment.findMany({
        where: {
          status:
            'PAID',
        },

        select: {
          type: true,
          amount: true,
          commissionAmount:
            true,
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

      type.volume +=
        Number(
          payment.amount
        );

      type.commission +=
        Number(
          payment.commissionAmount ||
            0
        );

      type.count += 1;

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

    res.json({
      totalVolume,
      totalCommission,
      byType,
    });
  }
);

/* ---------------------------------------------------------
   LEGACY ADMIN MANUAL CONFIRMATION
--------------------------------------------------------- */

router.patch(
  '/:id/confirm',
  authenticate,
  async (req, res) => {
    if (
      !isAdmin(req.user)
    ) {
      return res.status(403).json({
        error:
          'Only an administrator can perform manual payment reconciliation',
      });
    }

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
      payment.status !==
      'PENDING'
    ) {
      return res.status(409).json({
        error:
          `Payment is already ${payment.status}`,
      });
    }

    const commission =
      commissionFor(
        payment.type,
        payment.amount
      );

    const updated =
      await prisma.$transaction(
        async (tx) => {
          const p =
            await tx.payment.update({
              where: {
                id:
                  payment.id,
              },

              data: {
                status:
                  'PAID',

                commissionRate:
                  commission.rate,

                commissionAmount:
                  commission.commissionAmount,
              },
            });

          if (
            payment.type ===
              'MARKETPLACE' &&
            payment.orderId
          ) {
            await tx.order.updateMany({
              where: {
                id:
                  payment.orderId,

                status:
                  'PENDING_PAYMENT',
              },

              data: {
                status:
                  'CONFIRMED',
              },
            });
          }

          if (
            payment.type ===
            'DIGITAL'
          ) {
            const purchase =
              await tx.digitalPurchase.findUnique(
                {
                  where: {
                    paymentId:
                      payment.id,
                  },
                }
              );

            if (purchase) {
              await tx.digitalPurchase.update({
                where: {
                  id:
                    purchase.id,
                },

                data: {
                  status:
                    'COMPLETED',
                },
              });
            }
          }

          if (
            payment.type ===
              'ADVERTISING' &&
            payment.advertisementId
          ) {
            await tx.advertisement.update({
              where: {
                id:
                  payment.advertisementId,
              },

              data: {
                amountPaid:
                  payment.amount,
              },
            });
          }

          return p;
        }
      );

    res.json({
      message:
        'Payment manually reconciled. Prefer verified provider payments in production.',
      payment:
        updated,
    });
  }
);

/* ---------------------------------------------------------
   ORDER PAYMENTS
--------------------------------------------------------- */

router.get(
  '/order/:orderId',
  authenticate,
  [
    param(
      'orderId'
    ).isUUID(),
  ],
  validate,
  async (req, res) => {
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

        orderBy: {
          createdAt:
            'desc',
        },
      });

    res.json({
      payments,
      count:
        payments.length,
    });
  }
);

/* ---------------------------------------------------------
   SINGLE PAYMENT
--------------------------------------------------------- */

router.get(
  '/:id',
  authenticate,
  [
    param(
      'id'
    ).isUUID(),
  ],
  validate,
  async (req, res) => {
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

    res.json({
      payment,
    });
  }
);

module.exports = router;
