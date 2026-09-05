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
  CHAPA_MODE,
  getChapaConfig,
} = require('../config/chapa');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Validation                                                                */
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
    crypto.timingSafeEqual(x, y)
  );
}

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).trim().replace(/\s+/g, '');

  /*
   * Chapa documentation accepts Ethiopian mobile numbers such as:
   * 0912345678 / 0712345678
   *
   * If a user has stored 251912345678, convert it to 0912345678.
   */
  if (/^251[79]\d{8}$/.test(value)) {
    value = `0${value.slice(3)}`;
  }

  return value;
}

function validEthiopianMobile(phone) {
  return /^(09|07)\d{8}$/.test(phone);
}

function generateTxRef(paymentId) {
  return `MB-${CHAPA_MODE}-${paymentId}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

function getChapaWebhookSecret() {
  return (
    process.env.CHAPA_WEBHOOK_SECRET ||
    process.env.PAYMENT_WEBHOOK_SECRET ||
    ''
  );
}

function verifyChapaWebhook(req) {
  const secret = getChapaWebhookSecret();

  if (!secret) {
    return false;
  }

  const payload = JSON.stringify(req.body);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const chapaSignature =
    req.headers['x-chapa-signature'];

  const chapaSignatureLegacy =
    req.headers['chapa-signature'];

  if (
    typeof chapaSignature === 'string' &&
    timingSafeEqual(chapaSignature, expected)
  ) {
    return true;
  }

  if (
    typeof chapaSignatureLegacy === 'string' &&
    timingSafeEqual(chapaSignatureLegacy, expected)
  ) {
    return true;
  }

  return false;
}

function mapChapaStatus(status) {
  const value = String(status || '').toLowerCase();

  if (value === 'success') {
    return 'PAID';
  }

  if (
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'failed/cancelled'
  ) {
    return 'FAILED';
  }

  if (value === 'refunded') {
    return 'REFUNDED';
  }

  return 'PENDING';
}

/* -------------------------------------------------------------------------- */
/* Apply successful payment effects                                           */
/* -------------------------------------------------------------------------- */

async function applySuccessfulPayment(tx, payment) {
  const commission = commissionFor(
    payment.type,
    payment.amount
  );

  const updated = await tx.payment.update({
    where: {
      id: payment.id,
    },
    data: {
      status: 'PAID',
      commissionRate: commission.rate,
      commissionAmount: commission.commissionAmount,
    },
  });

  /*
   * Marketplace payment:
   *
   * PENDING_PAYMENT -> CONFIRMED
   */
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

  /*
   * Digital product payment.
   */
  if (
    payment.type === 'DIGITAL' &&
    payment.digitalProductId
  ) {
    const purchase =
      await tx.digitalPurchase.findUnique({
        where: {
          paymentId: payment.id,
        },
      });

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

  /*
   * Advertisement payment.
   */
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

  return updated;
}

/* -------------------------------------------------------------------------- */
/* Create Chapa Direct Charge                                                 */
/* -------------------------------------------------------------------------- */

async function startChapaPayment({
  payment,
  user,
}) {
  const chapaType =
    chapaPaymentType(payment.method);

  if (!chapaType) {
    throw new Error(
      'This payment method is not supported by Chapa Direct Charge'
    );
  }

  const mobile = normalizePhone(user.phone);

  if (!mobile) {
    const error = new Error(
      'Your account does not have a phone number. Add your Telebirr or CBE mobile number before paying.'
    );

    error.status = 400;

    throw error;
  }

  if (!validEthiopianMobile(mobile)) {
    const error = new Error(
      'Invalid Ethiopian mobile number. Use a number such as 0912345678 or 0712345678.'
    );

    error.status = 400;

    throw error;
  }

  const txRef = generateTxRef(payment.id);

  /*
   * Store the Chapa transaction reference before calling Chapa.
   *
   * This lets us correlate:
   * MarketBridge Payment
   *        ↓
   * Chapa tx_ref
   *        ↓
   * Chapa webhook / verification
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
    const response = await directCharge({
      type: chapaType,
      amount: payment.amount,
      mobile,
      txRef,
      currency: 'ETB',
    });

    /*
     * IMPORTANT:
     *
     * The Direct Charge request being accepted does NOT automatically
     * mean the customer has paid.
     *
     * Payment remains PENDING until Chapa confirms it.
     */

    return {
      txRef,
      chapaType,
      response,
    };
  } catch (error) {
    await prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        status: 'FAILED',
        provider: 'CHAPA',
        reference: txRef,
      },
    });

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* POST /payments                                                             */
/* -------------------------------------------------------------------------- */

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
      } = req.body;

      const amount = Number(req.body.amount);
      const method = String(req.body.method).toUpperCase();

      /* ------------------------------------------------------------------ */
      /* Marketplace / transport                                            */
      /* ------------------------------------------------------------------ */

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
            order.arrangingParty === 'BUYER'
              ? order.buyerId === req.user.id
              : order.arrangingParty === 'SELLER'
              ? order.sellerId === req.user.id
              : order.buyerId === req.user.id ||
                order.sellerId === req.user.id;

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

      /* ------------------------------------------------------------------ */
      /* Digital                                                             */
      /* ------------------------------------------------------------------ */

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
            amount - Number(product.price)
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

      /* ------------------------------------------------------------------ */
      /* Advertising                                                        */
      /* ------------------------------------------------------------------ */

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
          ad.advertiserId !== req.user.id &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({
            error: 'Not authorized',
          });
        }

        if (
          ad.amountPaid != null &&
          Math.abs(
            amount - Number(ad.amountPaid)
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

      /* ------------------------------------------------------------------ */
      /* Inspection                                                         */
      /* ------------------------------------------------------------------ */

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
            amount - Number(request.fee)
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

      /* ------------------------------------------------------------------ */
      /* Resource ID protection                                              */
      /* ------------------------------------------------------------------ */

      else if (
        orderId ||
        digitalProductId ||
        advertisementId ||
        inspectionRequestId
      ) {
        return res.status(400).json({
          error:
            'This payment type cannot use the supplied resource id',
        });
      }

      /* ------------------------------------------------------------------ */
      /* Only Chapa-supported methods use Direct Charge                     */
      /* ------------------------------------------------------------------ */

      const isChapaDirectCharge =
        method === 'TELEBIRR' ||
        method === 'CBE';

      /*
       * QR and OTHER remain pending manual/reconciliation payments.
       *
       * They are NOT falsely marked as paid.
       */
      const duplicate =
        await prisma.payment.findFirst({
          where: {
            createdById: req.user.id,

            type,

            status: {
              in: ['PENDING', 'PAID'],
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

      /* ------------------------------------------------------------------ */
      /* Create payment intent                                               */
      /* ------------------------------------------------------------------ */

      const payment =
        await prisma.payment.create({
          data: {
            createdById: req.user.id,

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

            provider:
              isChapaDirectCharge
                ? 'CHAPA'
                : null,

            status: 'PENDING',
          },
        });

      /* ------------------------------------------------------------------ */
      /* Chapa Direct Charge                                                */
      /* ------------------------------------------------------------------ */

      if (isChapaDirectCharge) {
        try {
          const chapaResult =
            await startChapaPayment({
              payment,
              user: req.user,
            });

          const updatedPayment =
            await prisma.payment.findUnique({
              where: {
                id: payment.id,
              },
            });

          return res.status(201).json({
            message:
              'Chapa payment initiated. Complete the authorization on your phone.',
            payment: updatedPayment,
            paymentConfirmed: false,

            provider: 'CHAPA',

            mode: CHAPA_MODE,

            chapa: {
              type:
                chapaResult.chapaType,

              txRef:
                chapaResult.txRef,

              response:
                chapaResult.response,
            },
          });
        } catch (error) {
          return res.status(
            error.status || 502
          ).json({
            error:
              error.message ||
              'Chapa payment initiation failed',

            provider: 'CHAPA',

            mode: CHAPA_MODE,

            details:
              error.response || null,
          });
        }
      }

      /* ------------------------------------------------------------------ */
      /* QR / OTHER                                                         */
      /* ------------------------------------------------------------------ */

      return res.status(201).json({
        message:
          'Payment intent created; it remains pending until verified or manually reconciled by an administrator.',

        payment,

        paymentConfirmed: false,

        provider: null,

        mode: CHAPA_MODE,
      });
    } catch (error) {
      console.error(
        'POST /payments error:',
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
/* Verify a Chapa transaction                                                */
/*                                                                            */
/* POST /payments/chapa/verify                                                */
/* -------------------------------------------------------------------------- */

router.post(
  '/chapa/verify',
  authenticate,
  [
    body('txRef')
      .isString()
      .trim()
      .isLength({
        min: 5,
        max: 200,
      }),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        txRef,
      } = req.body;

      const payment =
        await prisma.payment.findFirst({
          where: {
            reference: txRef,
            provider: 'CHAPA',
          },
          include: {
            order: true,
            digitalPurchase: true,
            advertisement: true,
          },
        });

      if (!payment) {
        return res.status(404).json({
          error:
            'MarketBridge payment not found for this Chapa transaction reference',
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
            'Not authorized to verify this payment',
        });
      }

      const chapa =
        await verifyPayment(txRef);

      const chapaStatus =
        String(
          chapa?.data?.status ||
            chapa?.status ||
            ''
        ).toLowerCase();

      const mappedStatus =
        mapChapaStatus(chapaStatus);

      /*
       * Never trust only the status.
       *
       * For a successful payment, verify:
       * - transaction reference
       * - amount
       * - currency
       * - test/live mode
       */

      if (mappedStatus === 'PAID') {
        const returnedTxRef =
          chapa?.data?.tx_ref ||
          chapa?.data?.trx_ref ||
          chapa?.tx_ref ||
          chapa?.trx_ref;

        const returnedAmount =
          Number(
            chapa?.data?.amount ??
              chapa?.amount
          );

        const returnedCurrency =
          chapa?.data?.currency ||
          chapa?.currency;

        const returnedMode =
          String(
            chapa?.data?.mode ||
              chapa?.mode ||
              ''
          ).toLowerCase();

        if (
          returnedTxRef &&
          returnedTxRef !==
            payment.reference
        ) {
          return res.status(409).json({
            error:
              'Chapa transaction reference does not match the MarketBridge payment',
          });
        }

        if (
          Number.isFinite(returnedAmount) &&
          Math.abs(
            returnedAmount -
              Number(payment.amount)
          ) > 0.01
        ) {
          return res.status(409).json({
            error:
              'Chapa payment amount does not match the MarketBridge payment',
            expectedAmount:
              Number(payment.amount),
            receivedAmount:
              returnedAmount,
          });
        }

        if (
          returnedCurrency &&
          returnedCurrency !== 'ETB'
        ) {
          return res.status(409).json({
            error:
              'Chapa payment currency is not ETB',
          });
        }

        if (
          returnedMode &&
          returnedMode !== CHAPA_MODE
        ) {
          return res.status(409).json({
            error:
              'Chapa payment mode does not match MarketBridge configuration',
            expectedMode:
              CHAPA_MODE,
            receivedMode:
              returnedMode,
          });
        }
      }

      let updatedPayment = payment;

      if (mappedStatus === 'PAID') {
        updatedPayment =
          await prisma.$transaction(
            async (tx) => {
              const current =
                await tx.payment.findUnique(
                  {
                    where: {
                      id: payment.id,
                    },
                  }
                );

              if (!current) {
                throw new Error(
                  'Payment no longer exists'
                );
              }

              if (
                current.status ===
                'PAID'
              ) {
                return current;
              }

              return applySuccessfulPayment(
                tx,
                current
              );
            }
          );
      } else if (
        mappedStatus === 'FAILED' ||
        mappedStatus === 'REFUNDED'
      ) {
        updatedPayment =
          await prisma.payment.update({
            where: {
              id: payment.id,
            },
            data: {
              status: mappedStatus,
              provider:
                'CHAPA',
              providerTransactionId:
                chapa?.data?.reference ||
                chapa?.reference ||
                null,
            },
          });
      }

      return res.json({
        message:
          'Chapa payment verification completed',

        payment:
          updatedPayment,

        chapaStatus,

        paymentConfirmed:
          updatedPayment.status ===
          'PAID',

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
          'Could not verify Chapa payment',

        details:
          error.response || null,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa webhook                                                             */
/* -------------------------------------------------------------------------- */

router.post(
  '/webhooks/chapa',
  express.json({
    limit: '100kb',
  }),
  async (req, res) => {
    try {
      /*
       * Chapa requires a configured webhook secret/signature.
       *
       * Do NOT accept unsigned payment notifications.
       */
      if (!verifyChapaWebhook(req)) {
        return res.status(401).json({
          error:
            'Invalid Chapa webhook signature',
        });
      }

      const event = req.body || {};

      const txRef =
        event.tx_ref ||
        event.trx_ref;

      const status =
        String(
          event.status || ''
        ).toLowerCase();

      if (!txRef) {
        return res.status(400).json({
          error:
            'Chapa webhook does not contain tx_ref',
        });
      }

      const payment =
        await prisma.payment.findFirst({
          where: {
            reference: txRef,
            provider: 'CHAPA',
          },
        });

      /*
       * Return 200 for unknown events after authentication.
       *
       * This prevents repeated webhook retries for transactions
       * that do not belong to MarketBridge.
       */
      if (!payment) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      /*
       * For successful events, re-query Chapa.
       *
       * Chapa specifically recommends verifying critical transaction
       * data before giving value to the customer.
       */
      if (status === 'success') {
        const verified =
          await verifyPayment(txRef);

        const verifiedStatus =
          String(
            verified?.data?.status ||
              verified?.status ||
              ''
          ).toLowerCase();

        if (
          verifiedStatus !==
          'success'
        ) {
          return res.status(409).json({
            error:
              'Chapa webhook reported success but transaction verification did not confirm success',
          });
        }

        const verifiedAmount =
          Number(
            verified?.data?.amount ??
              verified?.amount
          );

        if (
          Number.isFinite(
            verifiedAmount
          ) &&
          Math.abs(
            verifiedAmount -
              Number(payment.amount)
          ) > 0.01
        ) {
          return res.status(409).json({
            error:
              'Verified Chapa amount does not match MarketBridge payment',
          });
        }

        const verifiedTxRef =
          verified?.data?.tx_ref ||
          verified?.data?.trx_ref ||
          verified?.tx_ref ||
          verified?.trx_ref;

        if (
          verifiedTxRef &&
          verifiedTxRef !==
            payment.reference
        ) {
          return res.status(409).json({
            error:
              'Verified Chapa reference does not match MarketBridge payment',
          });
        }

        const result =
          await prisma.$transaction(
            async (tx) => {
              const current =
                await tx.payment.findUnique(
                  {
                    where: {
                      id: payment.id,
                    },
                  }
                );

              if (!current) {
                return null;
              }

              if (
                current.status ===
                'PAID'
              ) {
                return current;
              }

              const providerReference =
                verified?.data
                  ?.reference ||
                verified?.reference ||
                event.reference ||
                null;

              await tx.payment.update({
                where: {
                  id: current.id,
                },
                data: {
                  provider:
                    'CHAPA',

                  providerTransactionId:
                    providerReference,
                },
              });

              const refreshed =
                await tx.payment.findUnique(
                  {
                    where: {
                      id: current.id,
                    },
                  }
                );

              return applySuccessfulPayment(
                tx,
                refreshed
              );
            }
          );

        return res.json({
          ok: true,
          payment: result,
        });
      }

      /* ------------------------------------------------------------------ */
      /* Failed / cancelled                                                */
      /* ------------------------------------------------------------------ */

      if (
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'failed/cancelled'
      ) {
        const updated =
          await prisma.payment.update({
            where: {
              id: payment.id,
            },
            data: {
              status: 'FAILED',

              provider:
                'CHAPA',

              providerTransactionId:
                event.reference ||
                null,
            },
          });

        return res.json({
          ok: true,
          payment: updated,
        });
      }

      /* ------------------------------------------------------------------ */
      /* Refunded                                                           */
      /* ------------------------------------------------------------------ */

      if (
        status === 'refunded'
      ) {
        const updated =
          await prisma.$transaction(
            async (tx) => {
              const current =
                await tx.payment.findUnique(
                  {
                    where: {
                      id: payment.id,
                    },
                  }
                );

              if (!current) {
                return null;
              }

              const p =
                await tx.payment.update({
                  where: {
                    id: current.id,
                  },
                  data: {
                    status:
                      'REFUNDED',

                    provider:
                      'CHAPA',

                    providerTransactionId:
                      event.reference ||
                      null,
                  },
                });

              if (
                current.digitalProductId
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
                        id: purchase.id,
                      },
                      data: {
                        status:
                          'REFUNDED',
                      },
                    }
                  );
                }
              }

              return p;
            }
          );

        return res.json({
          ok: true,
          payment: updated,
        });
      }

      /*
       * Pending or another event.
       *
       * Do not mark the payment paid.
       */
      return res.json({
        ok: true,
        ignored: true,
        status,
      });
    } catch (error) {
      console.error(
        'Chapa webhook error:',
        error
      );

      return res.status(500).json({
        error:
          'Chapa webhook processing failed',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa configuration status                                                 */
/* -------------------------------------------------------------------------- */

router.get(
  '/chapa/config',
  authenticate,
  (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        error:
          'Only an administrator can view Chapa configuration status',
      });
    }

    res.json({
      chapa:
        getChapaConfig(),
    });
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

    for (const p of paid) {
      const type = p.type;

      const current =
        byType[type] || {
          volume: 0,
          commission: 0,
          count: 0,
        };

      current.volume +=
        Number(p.amount);

      current.commission +=
        Number(
          p.commissionAmount || 0
        );

      current.count += 1;

      byType[type] = current;

      totalVolume +=
        Number(p.amount);

      totalCommission +=
        Number(
          p.commissionAmount || 0
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
/* Legacy admin manual confirmation                                           */
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
      });

    if (!payment) {
      return res.status(404).json({
        error:
          'Payment not found',
      });
    }

    if (payment.status !== 'PENDING') {
      return res.status(409).json({
        error:
          `Payment is already ${payment.status}`,
      });
    }

    /*
     * Manual confirmation remains available for:
     *
     * - QR
     * - OTHER
     * - controlled reconciliation
     *
     * It should NOT normally be needed for Chapa payments.
     */
    const updated =
      await prisma.$transaction(
        async (tx) => {
          return applySuccessfulPayment(
            tx,
            payment
          );
        }
      );

    return res.json({
      message:
        'Payment manually reconciled. Prefer verified Chapa payments/webhooks in production.',
      payment: updated,
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Order payments                                                             */
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
/* Payment by ID                                                              */
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
