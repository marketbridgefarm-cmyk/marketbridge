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

const {
  commissionFor,
} = require('../config/commissions');

const {
  CHAPA_MODE,
  CHAPA_API_URL,
  getChapaConfig,
  directCharge,
  verifyPayment,
  chapaPaymentType,
  extractChapaReference,
} = require('../config/chapa');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
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
/* Security helpers                                                            */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* General helpers                                                             */
/* -------------------------------------------------------------------------- */

function createTxRef(paymentId) {
  return `MB-${paymentId}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

function normalizeMobile(value) {
  if (!value) return null;

  let mobile = String(value).trim();

  mobile = mobile.replace(/\s+/g, '');

  if (mobile.startsWith('+251')) {
    mobile = mobile.substring(1);
  }

  if (mobile.startsWith('09')) {
    mobile = `251${mobile.substring(1)}`;
  }

  if (mobile.startsWith('9') && mobile.length === 9) {
    mobile = `251${mobile}`;
  }

  return mobile;
}

function getPaymentChapaType(payment) {
  return chapaPaymentType(payment.method);
}

function getVerifiedStatus(data) {
  return String(
    data?.data?.status ||
      data?.status ||
      ''
  ).toLowerCase();
}

function getVerifiedReference(data) {
  return (
    data?.data?.reference ||
    data?.reference ||
    null
  );
}

function getVerifiedTxRef(data) {
  return (
    data?.data?.tx_ref ||
    data?.tx_ref ||
    null
  );
}

function getVerifiedAmount(data) {
  const amount =
    data?.data?.amount ??
    data?.amount;

  return amount == null
    ? null
    : Number(amount);
}

/* -------------------------------------------------------------------------- */
/* Payment side effects                                                        */
/* -------------------------------------------------------------------------- */

async function markPaymentPaid(tx, payment, extra = {}) {
  if (payment.status === 'REFUNDED') {
    throw Object.assign(
      new Error('Refunded payment cannot be reopened'),
      { status: 409 }
    );
  }

  if (payment.status === 'PAID') {
    return payment;
  }

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

      commissionRate:
        commission.rate,

      commissionAmount:
        commission.commissionAmount,

      ...(extra.reference !== undefined && {
        reference: extra.reference,
      }),

      ...(extra.provider !== undefined && {
        provider: extra.provider,
      }),

      ...(extra.providerTransactionId !== undefined && {
        providerTransactionId:
          extra.providerTransactionId,
      }),
    },
  });

  /* Marketplace order */
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

  /* Digital purchase */
  if (payment.type === 'DIGITAL') {
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

  /* Advertisement */
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

async function markPaymentStatus(
  paymentId,
  status,
  extra = {}
) {
  return prisma.$transaction(
    async (tx) => {
      const payment =
        await tx.payment.findUnique({
          where: {
            id: paymentId,
          },
        });

      if (!payment) {
        throw Object.assign(
          new Error('Payment not found'),
          { status: 404 }
        );
      }

      if (status === 'PAID') {
        return markPaymentPaid(
          tx,
          payment,
          extra
        );
      }

      if (
        payment.status === 'REFUNDED' &&
        status !== 'REFUNDED'
      ) {
        throw Object.assign(
          new Error(
            'Refunded payment cannot be reopened'
          ),
          { status: 409 }
        );
      }

      return tx.payment.update({
        where: {
          id: payment.id,
        },

        data: {
          status,

          ...(extra.reference !== undefined && {
            reference: extra.reference,
          }),

          ...(extra.provider !== undefined && {
            provider: extra.provider,
          }),

          ...(extra.providerTransactionId !== undefined && {
            providerTransactionId:
              extra.providerTransactionId,
          }),
        },
      });
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Existing MarketBridge payment creation                                     */
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

    body('orderId').optional().isUUID(),

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
              : (
                  order.buyerId ===
                    req.user.id ||
                  order.sellerId ===
                    req.user.id
                );

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

    else if (type === 'DIGITAL') {
      if (!digitalProductId) {
        return res.status(400).json({
          error:
            'digitalProductId is required',
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

    else if (type === 'ADVERTISING') {
      if (!advertisementId) {
        return res.status(400).json({
          error:
            'advertisementId is required',
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

    else if (type === 'INSPECTOR') {
      if (!inspectionRequestId) {
        return res.status(400).json({
          error:
            'inspectionRequestId is required',
        });
      }

      const request =
        await prisma.inspectionRequest.findUnique({
          where: {
            id: inspectionRequestId,
          },
        });

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
        },
      });

    res.status(201).json({
      message:
        'Payment intent created; it is not paid until verified by a gateway webhook or verification request.',

      payment,

      paymentConfirmed:
        false,
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa Direct Charge — INITIATE                                             */
/* -------------------------------------------------------------------------- */

router.post(
  '/chapa/initiate',
  authenticate,

  [
    body('paymentId')
      .isUUID(),

    body('mobile')
      .isString()
      .trim()
      .isLength({
        min: 9,
        max: 20,
      }),
  ],

  validate,

  async (req, res) => {
    const {
      paymentId,
      mobile,
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

    if (
      payment.status !==
      'PENDING'
    ) {
      return res.status(409).json({
        error:
          `Payment is already ${payment.status}`,
      });
    }

    const chapaType =
      getPaymentChapaType(
        payment
      );

    if (!chapaType) {
      return res.status(400).json({
        error:
          'This payment method is not supported by Chapa Direct Charge. Use TELEBIRR or CBE.',
      });
    }

    const normalizedMobile =
      normalizeMobile(
        mobile
      );

    if (
      !normalizedMobile ||
      !/^2519\d{8}$/.test(
        normalizedMobile
      )
    ) {
      return res.status(400).json({
        error:
          'Enter a valid Ethiopian mobile number, for example 0912345678 or 251912345678.',
      });
    }

    /*
     * Do not reuse an old Chapa reference.
     */
    const txRef =
      createTxRef(
        payment.id
      );

    try {
      const chapaResponse =
        await directCharge({
          type: chapaType,

          amount:
            payment.amount,

          mobile:
            normalizedMobile,

          txRef,

          currency:
            'ETB',
        });

      const chapaReference =
        extractChapaReference(
          chapaResponse
        );

      /*
       * Store our tx_ref in Payment.reference.
       *
       * This is intentionally done before payment
       * confirmation. PENDING remains PENDING.
       */
      const updated =
        await prisma.payment.update({
          where: {
            id: payment.id,
          },

          data: {
            reference:
              txRef,

            provider:
              'CHAPA',

            providerTransactionId:
              chapaReference ||
              null,
          },
        });

      return res.status(200).json({
        message:
          'Chapa payment initiated. The customer must authorize the charge before it can be marked as paid.',

        payment: updated,

        chapa: {
          mode:
            CHAPA_MODE,

          paymentMethod:
            chapaType,

          txRef,

          reference:
            chapaReference,

          response:
            chapaResponse,
        },

        paymentConfirmed:
          false,
      });
    } catch (error) {
      console.error(
        'Chapa Direct Charge initiation error:',
        error.response ||
          error.message
      );

      return res.status(
        error.status || 502
      ).json({
        error:
          error.message ||
          'Could not initiate Chapa payment',

        provider:
          'CHAPA',

        paymentId:
          payment.id,

        paymentConfirmed:
          false,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa Direct Charge — VERIFY                                               */
/* -------------------------------------------------------------------------- */

router.post(
  '/chapa/verify/:id',
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

    if (
      payment.provider !==
      'CHAPA'
    ) {
      return res.status(400).json({
        error:
          'This payment was not initiated through Chapa.',
      });
    }

    if (!payment.reference) {
      return res.status(400).json({
        error:
          'No Chapa transaction reference is stored for this payment.',
      });
    }

    try {
      const chapaResponse =
        await verifyPayment(
          payment.reference
        );

      const status =
        getVerifiedStatus(
          chapaResponse
        );

      const verifiedAmount =
        getVerifiedAmount(
          chapaResponse
        );

      const verifiedTxRef =
        getVerifiedTxRef(
          chapaResponse
        );

      const verifiedReference =
        getVerifiedReference(
          chapaResponse
        );

      /*
       * Never trust a successful response unless
       * the amount matches our payment.
       */
      if (
        verifiedAmount != null &&
        Math.abs(
          verifiedAmount -
            Number(payment.amount)
        ) > 0.01
      ) {
        return res.status(409).json({
          error:
            'Chapa verification amount does not match the MarketBridge payment amount.',

          expectedAmount:
            Number(payment.amount),

          verifiedAmount,

          paymentConfirmed:
            false,
        });
      }

      if (
        verifiedTxRef &&
        verifiedTxRef !==
          payment.reference
      ) {
        return res.status(409).json({
          error:
            'Chapa transaction reference does not match the MarketBridge payment.',

          paymentConfirmed:
            false,
        });
      }

      if (
        status === 'success' ||
        status === 'paid'
      ) {
        const updated =
          await markPaymentStatus(
            payment.id,
            'PAID',

            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                verifiedReference ||
                payment.providerTransactionId,
            }
          );

        return res.json({
          message:
            'Chapa payment verified successfully.',

          payment:
            updated,

          chapa:
            chapaResponse,

          paymentConfirmed:
            true,
        });
      }

      if (
        status === 'failed' ||
        status === 'cancelled'
      ) {
        const updated =
          await markPaymentStatus(
            payment.id,
            'FAILED',

            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                verifiedReference ||
                payment.providerTransactionId,
            }
          );

        return res.json({
          message:
            'Chapa reports that the payment failed or was cancelled.',

          payment:
            updated,

          chapa:
            chapaResponse,

          paymentConfirmed:
            false,
        });
      }

      return res.json({
        message:
          'Chapa payment is not yet confirmed.',

        payment,

        chapa:
          chapaResponse,

        paymentConfirmed:
          false,
      });
    } catch (error) {
      console.error(
        'Chapa verification error:',
        error.response ||
          error.message
      );

      /*
       * A "payment not paid yet" response should not
       * turn our payment into FAILED automatically.
       */
      return res.status(
        error.status || 502
      ).json({
        error:
          error.message ||
          'Could not verify Chapa payment',

        provider:
          'CHAPA',

        paymentId:
          payment.id,

        paymentConfirmed:
          false,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa configuration/status — authenticated                                 */
/* -------------------------------------------------------------------------- */

router.get(
  '/chapa/config',
  authenticate,

  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        error:
          'Only an administrator can view Chapa configuration.',
      });
    }

    res.json({
      chapa:
        getChapaConfig(),
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Generic MarketBridge webhook                                                */
/* -------------------------------------------------------------------------- */

router.post(
  '/webhooks/generic',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    if (!verifySignature(req)) {
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
        await markPaymentStatus(
          paymentId,
          status,
          {
            reference,
            provider,
            providerTransactionId,
          }
        );

      res.json({
        ok: true,
        payment: result,
      });
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        error:
          e.status
            ? e.message
            : 'Webhook processing failed',
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* Chapa webhook                                                               */
/* -------------------------------------------------------------------------- */

router.post(
  '/webhooks/chapa',
  express.json({
    limit: '100kb',
  }),

  async (req, res) => {
    /*
     * Chapa webhook events include charge.success,
     * charge.failed/cancelled, charge.refunded and
     * charge.reversed.
     *
     * We still verify the transaction with Chapa
     * before giving value to the customer.
     */

    const event =
      String(
        req.body?.event ||
          ''
      ).toLowerCase();

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
      /*
       * Do not expose internal information.
       *
       * Returning 200 prevents repeated retries for a
       * webhook belonging to an unknown transaction.
       */
      return res.json({
        ok: true,
        ignored: true,
      });
    }

    try {
      /*
       * Successful Chapa webhook:
       *
       * Verify directly with Chapa before marking PAID.
       */
      if (
        event ===
        'charge.success'
      ) {
        const verified =
          await verifyPayment(
            payment.reference
          );

        const status =
          getVerifiedStatus(
            verified
          );

        const verifiedAmount =
          getVerifiedAmount(
            verified
          );

        if (
          status !==
            'success' &&
          status !==
            'paid'
        ) {
          return res.json({
            ok: true,
            paymentConfirmed:
              false,
            message:
              'Webhook received, but Chapa verification has not confirmed the payment.',
          });
        }

        if (
          verifiedAmount != null &&
          Math.abs(
            verifiedAmount -
              Number(payment.amount)
          ) > 0.01
        ) {
          console.error(
            'Chapa webhook amount mismatch',
            {
              paymentId:
                payment.id,

              expected:
                payment.amount,

              received:
                verifiedAmount,
            }
          );

          return res.status(409).json({
            error:
              'Payment amount mismatch',
          });
        }

        const updated =
          await markPaymentStatus(
            payment.id,
            'PAID',
            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                getVerifiedReference(
                  verified
                ) ||
                payment.providerTransactionId,
            }
          );

        return res.json({
          ok: true,

          payment:
            updated,

          paymentConfirmed:
            true,
        });
      }

      if (
        event ===
          'charge.failed/cancelled' ||
        event ===
          'charge.failed' ||
        event ===
          'charge.cancelled'
      ) {
        const updated =
          await markPaymentStatus(
            payment.id,
            'FAILED',
            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                payment.providerTransactionId,
            }
          );

        return res.json({
          ok: true,
          payment:
            updated,

          paymentConfirmed:
            false,
        });
      }

      if (
        event ===
        'charge.refunded'
      ) {
        const updated =
          await markPaymentStatus(
            payment.id,
            'REFUNDED',
            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                payment.providerTransactionId,
            }
          );

        if (
          payment.type ===
            'DIGITAL'
        ) {
          await prisma.digitalPurchase.updateMany(
            {
              where: {
                paymentId:
                  payment.id,
              },

              data: {
                status:
                  'REFUNDED',
              },
            }
          );
        }

        return res.json({
          ok: true,

          payment:
            updated,

          paymentConfirmed:
            false,
        });
      }

      /*
       * Reversed transactions should not remain
       * considered successfully paid.
       */
      if (
        event ===
        'charge.reversed'
      ) {
        const updated =
          await markPaymentStatus(
            payment.id,
            'FAILED',
            {
              reference:
                payment.reference,

              provider:
                'CHAPA',

              providerTransactionId:
                payment.providerTransactionId,
            }
          );

        return res.json({
          ok: true,

          payment:
            updated,

          paymentConfirmed:
            false,
        });
      }

      return res.json({
        ok: true,

        ignoredEvent:
          event ||
          'unknown',
      });
    } catch (error) {
      console.error(
        'Chapa webhook processing error:',
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
          commissionAmount:
            true,
        },
      });

    const byType = {};

    let totalCommission = 0;
    let totalVolume = 0;

    for (const p of paid) {
      const t =
        byType[p.type] ||
        {
          volume: 0,
          commission: 0,
          count: 0,
        };

      t.volume +=
        Number(p.amount);

      t.commission +=
        Number(
          p.commissionAmount ||
            0
        );

      t.count += 1;

      byType[p.type] =
        t;

      totalVolume +=
        Number(p.amount);

      totalCommission +=
        Number(
          p.commissionAmount ||
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

/* -------------------------------------------------------------------------- */
/* Legacy manual admin confirmation                                           */
/* -------------------------------------------------------------------------- */

router.patch(
  '/:id/confirm',
  authenticate,

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
            await tx.order.updateMany(
              {
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
              }
            );
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
            payment.type ===
              'ADVERTISING' &&
            payment.advertisementId
          ) {
            await tx.advertisement.update(
              {
                where: {
                  id:
                    payment.advertisementId,
                },

                data: {
                  amountPaid:
                    payment.amount,
                },
              }
            );
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

/* -------------------------------------------------------------------------- */
/* Payments belonging to an order                                             */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Individual payment                                                         */
/* -------------------------------------------------------------------------- */

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
          id:
            req.params.id,
        },

        include: {
          order: true,
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
