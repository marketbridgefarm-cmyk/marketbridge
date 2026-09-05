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
  CHAPA_MODE,
  directCharge,
  verifyPayment,
  chapaPaymentType,
} = require('../config/chapa');

const router = express.Router();

/* =========================================================
   VALIDATION
========================================================= */

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

/* =========================================================
   HELPERS
========================================================= */

function timingSafeEqual(a, b) {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
}

function verifyGenericSignature(req) {
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

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).trim();

  value = value.replace(/\s+/g, '');

  if (value.startsWith('+251')) {
    value = `0${value.slice(4)}`;
  } else if (value.startsWith('251')) {
    value = `0${value.slice(3)}`;
  }

  return value;
}

function makeTxRef(paymentId) {
  return `MB-${paymentId}-${Date.now()}`;
}

function getChapaStatus(data) {
  return String(
    data?.status ||
      data?.data?.status ||
      ''
  ).toLowerCase();
}

function getChapaReference(data) {
  return (
    data?.reference ||
    data?.data?.reference ||
    null
  );
}

function getChapaTxRef(data) {
  return (
    data?.tx_ref ||
    data?.data?.tx_ref ||
    null
  );
}

/* =========================================================
   FINALIZE PAYMENT
   Centralized function used by:
   - Chapa verification
   - Chapa webhook
   - Admin reconciliation
========================================================= */

async function finalizePayment({
  paymentId,
  status,
  provider = 'chapa',
  providerTransactionId = null,
  reference = null,
}) {
  const normalizedStatus = String(status || '').toUpperCase();

  if (
    !['PAID', 'FAILED', 'REFUNDED'].includes(
      normalizedStatus
    )
  ) {
    throw Object.assign(
      new Error('Invalid payment status'),
      { status: 400 }
    );
  }

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: {
        order: true,
        digitalPurchase: true,
        advertisement: true,
      },
    });

    if (!payment) {
      throw Object.assign(
        new Error('Payment not found'),
        { status: 404 }
      );
    }

    /*
     * Idempotency:
     * If the same successful webhook/verification arrives twice,
     * do not create another state transition.
     */
    if (
      payment.status === 'PAID' &&
      normalizedStatus === 'PAID'
    ) {
      return payment;
    }

    if (
      payment.status === 'REFUNDED' &&
      normalizedStatus !== 'REFUNDED'
    ) {
      throw Object.assign(
        new Error(
          'Refunded payment cannot be reopened'
        ),
        { status: 409 }
      );
    }

    const commission =
      normalizedStatus === 'PAID'
        ? commissionFor(
            payment.type,
            payment.amount
          )
        : {
            rate: payment.commissionRate,
            commissionAmount:
              payment.commissionAmount,
          };

    const updatedPayment =
      await tx.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          status: normalizedStatus,

          provider:
            provider || payment.provider,

          providerTransactionId:
            providerTransactionId ||
            payment.providerTransactionId,

          reference:
            reference ||
            payment.reference,

          ...(normalizedStatus === 'PAID'
            ? {
                commissionRate:
                  commission.rate,

                commissionAmount:
                  commission.commissionAmount,
              }
            : {}),
        },
      });

    /* -----------------------------------------------------
       MARKETPLACE
    ----------------------------------------------------- */

    if (
      normalizedStatus === 'PAID' &&
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

    /* -----------------------------------------------------
       DIGITAL
    ----------------------------------------------------- */

    if (
      normalizedStatus === 'PAID' &&
      payment.type === 'DIGITAL'
    ) {
      const purchase =
        payment.digitalPurchase ||
        (await tx.digitalPurchase.findUnique({
          where: {
            paymentId: payment.id,
          },
        }));

      if (purchase) {
        await tx.digitalPurchase.update({
          where: {
            id: purchase.id,
          },
          data: {
            status: 'COMPLETED',
          },
        });
      }
    }

    /* -----------------------------------------------------
       ADVERTISING
    ----------------------------------------------------- */

    if (
      normalizedStatus === 'PAID' &&
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

    /* -----------------------------------------------------
       DIGITAL REFUND
    ----------------------------------------------------- */

    if (
      normalizedStatus === 'REFUNDED' &&
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

    return updatedPayment;
  });
}

/* =========================================================
   CREATE PAYMENT INTENT + CHAPA DIRECT CHARGE
========================================================= */

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

      const amount = Number(
        req.body.amount
      );

      /* ===================================================
         MARKETPLACE / TRANSPORT
      =================================================== */

      let order = null;

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

        order =
          await prisma.order.findUnique({
            where: {
              id: orderId,
            },
            include: {
              transportJob: true,
              buyer: true,
              seller: true,
              listing: true,
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

        /* -----------------------------------------------
           MARKETPLACE
        ------------------------------------------------ */

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

        /* -----------------------------------------------
           TRANSPORT
        ------------------------------------------------ */

        if (type === 'TRANSPORT') {
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

          const arrangingParty =
            order.arrangingParty;

          const allowed =
            arrangingParty === 'BUYER'
              ? order.buyerId ===
                req.user.id
              : arrangingParty ===
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

      /* ===================================================
         DIGITAL
      =================================================== */

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

      /* ===================================================
         ADVERTISING
      =================================================== */

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
            error:
              'Not authorized',
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

      /* ===================================================
         INSPECTOR
      =================================================== */

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

      /* ===================================================
         RESOURCE ID VALIDATION
      =================================================== */

      if (
        ![
          'MARKETPLACE',
          'TRANSPORT',
          'DIGITAL',
          'ADVERTISING',
          'INSPECTOR',
        ].includes(type)
      ) {
        return res.status(400).json({
          error: 'Invalid payment type',
        });
      }

      /* ===================================================
         DUPLICATE ACTIVE PAYMENT CHECK
      =================================================== */

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
          },
        });

      if (duplicate) {
        return res.status(409).json({
          error:
            'An active payment already exists',
          payment: duplicate,
        });
      }

      /* ===================================================
         CREATE DATABASE PAYMENT FIRST
      =================================================== */

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
              method === 'TELEBIRR' ||
              method === 'CBE'
                ? 'chapa'
                : null,
          },
        });

      /* ===================================================
         QR / OTHER
         
         These remain manual/test methods for now.
         Chapa Direct Charge is used for Telebirr/CBE.
      =================================================== */

      if (
        method !== 'TELEBIRR' &&
        method !== 'CBE'
      ) {
        return res.status(201).json({
          message:
            'Payment intent created. This payment method requires manual reconciliation or a separate gateway integration.',

          payment,

          paymentConfirmed: false,

          gateway: null,
        });
      }

      /* ===================================================
         CHAPA DIRECT CHARGE
      =================================================== */

      const chapaType =
        chapaPaymentType(method);

      if (!chapaType) {
        return res.status(400).json({
          error:
            'Unsupported Chapa payment method',
        });
      }

      /*
       * The payment must have a customer phone number.
       *
       * For marketplace / transport / inspection,
       * the logged-in user is the payer.
       */

      let customerPhone =
        req.user.phone;

      if (!customerPhone) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
            provider: 'chapa',
          },
        });

        return res.status(400).json({
          error:
            'Your account does not have a phone number. Add your Ethiopian mobile number before paying with Telebirr or CBE.',
          paymentId: payment.id,
        });
      }

      customerPhone =
        normalizePhone(customerPhone);

      const txRef =
        makeTxRef(payment.id);

      /*
       * Save our transaction reference before
       * contacting Chapa.
       *
       * This lets us recover the payment even if
       * the HTTP request is interrupted.
       */

      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          reference: txRef,
          provider: 'chapa',
        },
      });

      let chapaResponse;

      try {
        chapaResponse =
          await directCharge({
            type: chapaType,
            amount,
            mobile: customerPhone,
            txRef,
            currency: 'ETB',
          });
      } catch (error) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
            provider: 'chapa',
          },
        });

        return res.status(
          error.status || 502
        ).json({
          error:
            'Chapa payment initiation failed',
          message:
            error.message,
          paymentId: payment.id,
          gateway:
            'chapa',
          mode:
            CHAPA_MODE,
        });
      }

      const chapaReference =
        getChapaReference(
          chapaResponse
        );

      const returnedTxRef =
        getChapaTxRef(
          chapaResponse
        );

      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          provider:
            'chapa',

          providerTransactionId:
            chapaReference ||
            null,

          reference:
            returnedTxRef ||
            txRef,
        },
      });

      /*
       * Direct Charge normally returns an
       * authorization instruction / result.
       *
       * Do NOT mark the MarketBridge payment PAID here.
       *
       * The payment becomes PAID only after
       * Chapa verification/webhook confirms success.
       */

      return res.status(201).json({
        message:
          'Chapa payment initiated. Complete the authorization on your phone, then the payment will be verified.',

        paymentId:
          payment.id,

        txRef:
          returnedTxRef ||
          txRef,

        chapaReference:
          chapaReference,

        method,

        chapaType,

        mode:
          CHAPA_MODE,

        gateway:
          'chapa',

        paymentConfirmed:
          false,

        chapa:
          chapaResponse,
      });
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

/* =========================================================
   VERIFY CHAPA PAYMENT

   Frontend can call this after the customer authorizes
   the Telebirr/CBE payment.

   IMPORTANT:
   Verification is what changes PENDING -> PAID.
========================================================= */

router.post(
  '/chapa/verify',
  authenticate,

  [
    body('paymentId')
      .isUUID(),

    body('txRef')
      .isString()
      .trim()
      .isLength({
        min: 3,
        max: 200,
      }),
  ],

  validate,

  async (req, res) => {
    try {
      const {
        paymentId,
        txRef,
      } = req.body;

      const payment =
        await prisma.payment.findUnique({
          where: {
            id: paymentId,
          },
          include: {
            order: true,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'Payment not found',
        });
      }

      const authorized =
        payment.createdById ===
          req.user.id ||
        (payment.order &&
          isOrderParticipant(
            req.user.id,
            payment.order
          )) ||
        isAdmin(req.user);

      if (!authorized) {
        return res.status(403).json({
          error:
            'Not authorized',
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

      if (
        payment.reference &&
        payment.reference !== txRef
      ) {
        return res.status(400).json({
          error:
            'Transaction reference does not match this payment',
        });
      }

      const result =
        await verifyPayment(txRef);

      const chapaStatus =
        getChapaStatus(result);

      if (
        chapaStatus === 'success'
      ) {
        const chapaReference =
          getChapaReference(
            result
          );

        const updated =
          await finalizePayment({
            paymentId,
            status: 'PAID',
            provider: 'chapa',
            providerTransactionId:
              chapaReference,
            reference:
              txRef,
          });

        return res.json({
          message:
            'Payment verified successfully',
          payment:
            updated,
          paymentConfirmed:
            true,
          chapa:
            result,
        });
      }

      if (
        chapaStatus === 'failed' ||
        chapaStatus ===
          'cancelled' ||
        chapaStatus ===
          'reversed' ||
        chapaStatus ===
          'refunded'
      ) {
        const internalStatus =
          chapaStatus ===
          'refunded'
            ? 'REFUNDED'
            : 'FAILED';

        const updated =
          await finalizePayment({
            paymentId,
            status:
              internalStatus,
            provider:
              'chapa',
            providerTransactionId:
              getChapaReference(
                result
              ),
            reference:
              txRef,
          });

        return res.json({
          message:
            'Chapa payment is not successful',
          payment:
            updated,
          paymentConfirmed:
            false,
          chapa:
            result,
        });
      }

      return res.status(202).json({
        message:
          'Payment is still pending confirmation',
        paymentId,
        txRef,
        paymentConfirmed:
          false,
        chapa:
          result,
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
          'Could not verify Chapa payment',
        message:
          error.message,
      });
    }
  }
);

/* =========================================================
   CHAPA WEBHOOK

   Chapa sends charge.success / charge.failed /
   charge.refunded / charge.reversed events.

   We use tx_ref to locate the MarketBridge payment.

   Verification is still preferred before releasing value.
========================================================= */

router.post(
  '/webhooks/chapa',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    try {
      const event =
        req.body || {};

      const eventName =
        String(
          event.event || ''
        ).toLowerCase();

      const txRef =
        event.tx_ref ||
        event.trx_ref ||
        null;

      if (!txRef) {
        return res.status(400).json({
          error:
            'Missing Chapa transaction reference',
        });
      }

      /*
       * Locate payment by our tx_ref.
       */

      const payment =
        await prisma.payment.findFirst({
          where: {
            reference: txRef,
            provider: 'chapa',
          },
        });

      if (!payment) {
        /*
         * Acknowledge unknown events without
         * modifying any payment.
         *
         * This avoids Chapa repeatedly retrying
         * an event for a transaction we do not know.
         */

        return res.json({
          ok: true,
          ignored: true,
        });
      }

      /* ---------------------------------------------------
         SUCCESS
      --------------------------------------------------- */

      if (
        eventName ===
        'charge.success'
      ) {
        /*
         * Verify directly with Chapa before
         * marking the MarketBridge payment PAID.
         */

        const verified =
          await verifyPayment(
            txRef
          );

        const verifiedStatus =
          getChapaStatus(
            verified
          );

        if (
          verifiedStatus !==
          'success'
        ) {
          return res.status(202).json({
            ok: true,
            verified: false,
            message:
              'Webhook received but verification is not successful yet',
          });
        }

        const updated =
          await finalizePayment({
            paymentId:
              payment.id,
            status:
              'PAID',
            provider:
              'chapa',
            providerTransactionId:
              getChapaReference(
                verified
              ) ||
              event.reference ||
              null,
            reference:
              txRef,
          });

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      /* ---------------------------------------------------
         FAILED / CANCELLED
      --------------------------------------------------- */

      if (
        eventName ===
          'charge.failed/cancelled' ||
        eventName ===
          'charge.failed' ||
        eventName ===
          'charge.cancelled'
      ) {
        const updated =
          await finalizePayment({
            paymentId:
              payment.id,
            status:
              'FAILED',
            provider:
              'chapa',
            providerTransactionId:
              event.reference ||
              null,
            reference:
              txRef,
          });

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      /* ---------------------------------------------------
         REFUNDED
      --------------------------------------------------- */

      if (
        eventName ===
        'charge.refunded'
      ) {
        const updated =
          await finalizePayment({
            paymentId:
              payment.id,
            status:
              'REFUNDED',
            provider:
              'chapa',
            providerTransactionId:
              event.reference ||
              null,
            reference:
              txRef,
          });

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      /* ---------------------------------------------------
         REVERSED
      --------------------------------------------------- */

      if (
        eventName ===
        'charge.reversed'
      ) {
        const updated =
          await finalizePayment({
            paymentId:
              payment.id,
            status:
              'FAILED',
            provider:
              'chapa',
            providerTransactionId:
              event.reference ||
              null,
            reference:
              txRef,
          });

        return res.json({
          ok: true,
          payment:
            updated,
        });
      }

      return res.json({
        ok: true,
        ignored: true,
        event:
          eventName || null,
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

/* =========================================================
   GENERIC SIGNED WEBHOOK

   Retained for other gateways / future integrations.
========================================================= */

router.post(
  '/webhooks/generic',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    if (
      !verifyGenericSignature(req)
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
        await finalizePayment({
          paymentId,
          status,
          reference,
          provider,
          providerTransactionId,
        });

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

/* =========================================================
   ADMIN PAYMENT QUEUE
========================================================= */

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
              status: true,
            },
          },

          digitalProduct: {
            select: {
              id: true,
              title: true,
              price: true,
            },
          },

          advertisement: {
            select: {
              id: true,
              type: true,
              amountPaid: true,
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
      count:
        payments.length,
    });
  }
);

/* =========================================================
   COMMISSION SUMMARY
========================================================= */

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
        payment.type;

      const row =
        byType[type] || {
          volume: 0,
          commission: 0,
          count: 0,
        };

      row.volume +=
        Number(payment.amount);

      row.commission +=
        Number(
          payment.commissionAmount ||
            0
        );

      row.count += 1;

      byType[type] =
        row;

      totalVolume +=
        Number(payment.amount);

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
  }
);

/* =========================================================
   ADMIN MANUAL CONFIRMATION

   Kept for QR / OTHER and controlled reconciliation.
========================================================= */

router.patch(
  '/:id/confirm',
  authenticate,

  [
    param('id')
      .isUUID(),
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

    try {
      const updated =
        await finalizePayment({
          paymentId:
            payment.id,
          status:
            'PAID',
          provider:
            payment.provider ||
            'manual',
          providerTransactionId:
            payment.providerTransactionId,
          reference:
            payment.reference,
        });

      return res.json({
        message:
          'Payment manually reconciled. Prefer verified provider payments in production.',
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

/* =========================================================
   PAYMENTS FOR AN ORDER
========================================================= */

router.get(
  '/order/:orderId',
  authenticate,

  [
    param('orderId')
      .isUUID(),
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

    return res.json({
      payments,
      count:
        payments.length,
    });
  }
);

/* =========================================================
   SINGLE PAYMENT
========================================================= */

router.get(
  '/:id',
  authenticate,

  [
    param('id')
      .isUUID(),
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
  }
);

module.exports = router;
