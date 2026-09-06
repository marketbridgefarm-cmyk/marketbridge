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
const { commissionFor, netFor } = require('../config/commissions');
const chapa = require('../config/chapa');
const { paymentLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ============================================================================
// VALIDATION
// ============================================================================

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

// ============================================================================
// HELPERS
// ============================================================================

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

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

// ============================================================================
// PAYMENT PAID — SINGLE SOURCE OF TRUTH
// ============================================================================
//
// Every confirmation path eventually uses this function.
//
// It handles:
// MARKETPLACE, TRANSPORT, DIGITAL, ADVERTISING, INSPECTOR
//
// ============================================================================

async function markPaymentPaid(
  tx,
  paymentId,
  {
    reference,
    provider,
    providerTransactionId,
  } = {}
) {
  const payment =
    await tx.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: {
        order: {
          include: {
            transportJob: true,
            payments: true,
          },
        },
        digitalPurchase: true,
        advertisement: true,
        inspectionRequest: true,
      },
    });

  if (!payment) {
    throw Object.assign(
      new Error('Payment not found'),
      { status: 404 }
    );
  }

  if (payment.status === 'PAID') {
    return payment;
  }

  if (payment.status === 'REFUNDED') {
    throw Object.assign(
      new Error(
        'Refunded payment cannot be reopened'
      ),
      { status: 409 }
    );
  }

  // --------------------------------------------------------------------------
  // SECURITY CHECKS BEFORE MARKING PAYMENT PAID
  // --------------------------------------------------------------------------

  if (
    payment.type === 'TRANSPORT' &&
    payment.orderId
  ) {
    const order = payment.order;

    if (!order) {
      throw Object.assign(
        new Error('Order not found'),
        { status: 404 }
      );
    }

    if (!order.transportJob) {
      throw Object.assign(
        new Error(
          'Transport job required before transport payment can be confirmed'
        ),
        { status: 400 }
      );
    }

    if (
      order.transportJob.method !==
      'HIRE_TRANSPORTER'
    ) {
      throw Object.assign(
        new Error(
          'No separate transport payment is required for OWN_TRUCK transport'
        ),
        { status: 400 }
      );
    }

    if (
      order.transportJob.status !==
      'ACCEPTED'
    ) {
      throw Object.assign(
        new Error(
          'A transport quote must be accepted before transport payment can be confirmed'
        ),
        { status: 400 }
      );
    }

    if (
      order.transportJob.agreedAmount == null
    ) {
      throw Object.assign(
        new Error(
          'Accepted transport amount is missing'
        ),
        { status: 400 }
      );
    }

    if (
      !moneyEqual(
        payment.amount,
        order.transportJob.agreedAmount
      )
    ) {
      throw Object.assign(
        new Error(
          'Transport payment amount does not match the accepted transport fee'
        ),
        { status: 409 }
      );
    }

    const marketplacePaid =
      order.payments.some(
        (p) =>
          p.type === 'MARKETPLACE' &&
          p.status === 'PAID'
      );

    if (!marketplacePaid) {
      throw Object.assign(
        new Error(
          'Marketplace payment must be PAID before transport payment can be confirmed'
        ),
        { status: 402 }
      );
    }
  }

  // --------------------------------------------------------------------------
  // COMMISSION
  // --------------------------------------------------------------------------

  const commission =
    commissionFor(
      payment.type,
      payment.amount
    );

  const net =
    netFor(
      payment.type,
      payment.amount
    );

  const updated =
    await tx.payment.update({
      where: {
        id: payment.id,
      },

      data: {
        status: 'PAID',

        commissionRate:
          commission.rate,

        commissionAmount:
          commission.commissionAmount,

        netAmount:
          net.netAmount,

        reference:
          reference ||
          payment.reference,

        provider:
          provider ||
          payment.provider,

        providerTransactionId:
          providerTransactionId ||
          payment.providerTransactionId,
      },
    });

  // --------------------------------------------------------------------------
  // CREATE COMMISSION RECORD
  // --------------------------------------------------------------------------

  if (
    commission.commissionAmount > 0 &&
    ['MARKETPLACE', 'TRANSPORT', 'INSPECTOR', 'DIGITAL'].includes(payment.type)
  ) {
    try {
      await tx.commission.create({
        data: {
          paymentId: payment.id,
          orderId: payment.orderId,
          transportJobId: payment.transportJobId,
          type: payment.type,
          rate: commission.rate,
          amount: commission.commissionAmount,
          currency: payment.currency || 'ETB',
          status: 'RECORDED',
        },
      });
    } catch (error) {
      if (error.code !== 'P2002') {
        console.error('Commission creation error:', error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // CREATE LEDGER ENTRIES
  // --------------------------------------------------------------------------

  try {
    // Platform commission
    if (commission.commissionAmount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission.commissionAmount,
          currency: payment.currency || 'ETB',
          description: `${payment.type} commission`,
        },
      });
    }

    // Seller earning for marketplace
    if (payment.type === 'MARKETPLACE' && payment.order?.sellerId && net.netAmount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          userId: payment.order.sellerId,
          type: 'SELLER_EARNING',
          amount: net.netAmount,
          currency: payment.currency || 'ETB',
          description: 'Seller earning from marketplace payment',
        },
      });
    }

    // Transporter earning for transport
    if (payment.type === 'TRANSPORT' && payment.transportJob?.truckOwnerId && net.netAmount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          userId: payment.transportJob.truckOwnerId,
          type: 'TRANSPORTER_EARNING',
          amount: net.netAmount,
          currency: payment.currency || 'ETB',
          description: 'Transporter earning from hired transport payment',
        },
      });
    }

    // Inspector earning
    if (payment.type === 'INSPECTOR' && payment.inspectionRequest?.inspectorId && net.netAmount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          userId: payment.inspectionRequest.inspectorId,
          type: 'INSPECTOR_EARNING',
          amount: net.netAmount,
          currency: payment.currency || 'ETB',
          description: 'Inspector earning from inspection payment',
        },
      });
    }

    // Digital seller earning
    if (payment.type === 'DIGITAL' && payment.digitalProduct?.sellerId && net.netAmount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          userId: payment.digitalProduct.sellerId,
          type: 'SELLER_EARNING',
          amount: net.netAmount,
          currency: payment.currency || 'ETB',
          description: 'Digital seller earning from digital product sale',
        },
      });
    }

    // Advertising revenue
    if (payment.type === 'ADVERTISING' && payment.amount > 0) {
      await tx.paymentLedgerEntry.create({
        data: {
          paymentId: payment.id,
          type: 'PLATFORM_REVENUE',
          amount: payment.amount,
          currency: payment.currency || 'ETB',
          description: 'Advertising revenue',
        },
      });
    }
  } catch (ledgerError) {
    console.error('Ledger entry creation error:', ledgerError);
  }

  // --------------------------------------------------------------------------
  // BUSINESS EFFECTS
  // --------------------------------------------------------------------------

  // MARKETPLACE
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

  // DIGITAL
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

  // ADVERTISING
  if (
    payment.type === 'ADVERTISING' &&
    payment.advertisement
  ) {
    await tx.advertisement.update({
      where: {
        id: payment.advertisement.id,
      },
      data: {
        amountPaid: payment.amount,
        status: 'ACTIVE',
      },
    });
  }

  return updated;
}

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
      } = req.body;

      const amount =
        Number(req.body.amount);

      // ======================================================================
      // ORDER PAYMENTS
      // ======================================================================

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
          return res.status(404).json({ error: 'Order not found' });
        }

        if (
          !isOrderParticipant(req.user.id, order) &&
          !isAdmin(req.user)
        ) {
          return res.status(403).json({ error: 'Not authorized' });
        }

        // ====================================================================
        // MARKETPLACE PAYMENT
        // ====================================================================

        if (type === 'MARKETPLACE') {
          if (order.buyerId !== req.user.id && !isAdmin(req.user)) {
            return res.status(403).json({
              error: 'Only the buyer may create the marketplace payment',
            });
          }

          if (!moneyEqual(amount, order.finalPrice)) {
            return res.status(400).json({
              error: 'Amount must match order final price',
              expectedAmount: Number(order.finalPrice),
            });
          }

          if (order.status === 'COMPLETED') {
            return res.status(400).json({ error: 'This order has already been completed' });
          }
        }

        // ====================================================================
        // TRANSPORT PAYMENT
        // ====================================================================

        if (type === 'TRANSPORT') {
          if (!order.transportJob) {
            return res.status(400).json({ error: 'Transport job required' });
          }

          if (order.transportJob.method === 'OWN_TRUCK') {
            return res.status(400).json({
              error: 'No separate transport payment is required for OWN_TRUCK transport',
            });
          }

          if (order.transportJob.status !== 'ACCEPTED') {
            return res.status(400).json({
              error: 'A transport quote must be accepted before transport payment can be created',
            });
          }

          if (order.transportJob.agreedAmount == null) {
            return res.status(400).json({ error: 'Accepted transport amount is missing' });
          }

          if (!moneyEqual(amount, order.transportJob.agreedAmount)) {
            return res.status(400).json({
              error: 'Amount must match the accepted transport quote',
              expectedAmount: Number(order.transportJob.agreedAmount),
            });
          }

          const allowed =
            order.arrangingParty === 'BUYER'
              ? order.buyerId === req.user.id
              : order.arrangingParty === 'SELLER'
                ? order.sellerId === req.user.id
                : (
                    order.buyerId === req.user.id ||
                    order.sellerId === req.user.id
                  );

          if (!allowed && !isAdmin(req.user)) {
            return res.status(403).json({
              error: 'Only the party who arranged transport may pay for this transport',
            });
          }

          const marketplacePaid =
            await prisma.payment.findFirst({
              where: {
                orderId: order.id,
                type: 'MARKETPLACE',
                status: 'PAID',
              },
            });

          if (!marketplacePaid) {
            return res.status(402).json({
              error: 'Marketplace payment must be PAID before transport payment can be created',
            });
          }
        }
      }

      // ======================================================================
      // DIGITAL
      // ======================================================================

      else if (type === 'DIGITAL') {
        if (!digitalProductId) {
          return res.status(400).json({ error: 'digitalProductId is required' });
        }

        const product =
          await prisma.digitalProduct.findUnique({
            where: { id: digitalProductId },
          });

        if (!product || product.status !== 'ACTIVE') {
          return res.status(404).json({ error: 'Digital product not found' });
        }

        if (product.sellerId === req.user.id) {
          return res.status(400).json({ error: 'You cannot purchase your own product' });
        }

        if (!moneyEqual(amount, product.price)) {
          return res.status(400).json({
            error: 'Amount must match product price',
            expectedAmount: Number(product.price),
          });
        }
      }

      // ======================================================================
      // ADVERTISING
      // ======================================================================

      else if (type === 'ADVERTISING') {
        if (!advertisementId) {
          return res.status(400).json({ error: 'advertisementId is required' });
        }

        const ad =
          await prisma.advertisement.findUnique({
            where: { id: advertisementId },
          });

        if (!ad) {
          return res.status(404).json({ error: 'Advertisement not found' });
        }

        if (ad.advertiserId !== req.user.id && !isAdmin(req.user)) {
          return res.status(403).json({ error: 'Not authorized' });
        }

        if (ad.amountPaid != null && !moneyEqual(amount, ad.amountPaid)) {
          return res.status(400).json({
            error: 'Amount must match advertisement amount',
            expectedAmount: Number(ad.amountPaid),
          });
        }
      }

      // ======================================================================
      // INSPECTOR
      // ======================================================================

      else if (type === 'INSPECTOR') {
        if (!inspectionRequestId) {
          return res.status(400).json({ error: 'inspectionRequestId is required' });
        }

        const request =
          await prisma.inspectionRequest.findUnique({
            where: { id: inspectionRequestId },
          });

        if (!request) {
          return res.status(404).json({ error: 'Inspection request not found' });
        }

        if (request.requestedById !== req.user.id && !isAdmin(req.user)) {
          return res.status(403).json({
            error: 'Only the person who requested the inspection may pay for it',
          });
        }

        if (request.fee == null) {
          return res.status(400).json({ error: 'This inspection has no agreed fee yet' });
        }

        if (!moneyEqual(amount, request.fee)) {
          return res.status(400).json({
            error: 'Amount must match the agreed inspection fee',
            expectedAmount: Number(request.fee),
          });
        }
      }

      // ======================================================================
      // DUPLICATE ACTIVE PAYMENT
      // ======================================================================

      const duplicate =
        await prisma.payment.findFirst({
          where: {
            createdById: req.user.id,
            type,
            status: { in: ['PENDING', 'PAID'] },
            ...(orderId && { orderId }),
            ...(digitalProductId && { digitalProductId }),
            ...(advertisementId && { advertisementId }),
            ...(inspectionRequestId && { inspectionRequestId }),
          },
        });

      if (duplicate) {
        return res.status(409).json({
          error: 'An active payment already exists',
          payment: duplicate,
        });
      }

      // ======================================================================
      // CREATE PAYMENT
      // ======================================================================

      const commission =
        commissionFor(type, amount);

      const net =
        netFor(type, amount);

      const payment =
        await prisma.payment.create({
          data: {
            createdById: req.user.id,
            type,
            amount,
            method,
            reference: reference || null,
            orderId: orderId || null,
            digitalProductId: digitalProductId || null,
            advertisementId: advertisementId || null,
            inspectionRequestId: inspectionRequestId || null,
            commissionRate: commission.rate,
            commissionAmount: commission.commissionAmount,
            netAmount: net.netAmount,
            status: 'PENDING',
          },
        });

      return res.status(201).json({
        message: 'Payment intent created. Call /payments/:id/chapa/initialize to get a checkout link, or wait for admin reconciliation.',
        payment,
        paymentConfirmed: false,
      });
    } catch (error) {
      console.error('CREATE PAYMENT ERROR:', error);
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Could not create payment',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

// ============================================================================
// CHAPA INITIALIZE
// ============================================================================

router.post(
  '/:id/chapa/initialize',
  authenticate,

  [
    param('id').isUUID(),
  ],

  validate,

  async (req, res) => {
    const payment =
      await prisma.payment.findUnique({
        where: { id: req.params.id },
      });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.createdById !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (payment.status !== 'PENDING') {
      return res.status(409).json({
        error: `Payment is already ${payment.status}`,
      });
    }

    const appUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const apiUrl = (process.env.API_BASE_URL || '').replace(/\/$/, '');

    if (!appUrl || !apiUrl) {
      return res.status(500).json({
        error: 'APP_BASE_URL and API_BASE_URL must be configured to use Chapa checkout',
      });
    }

    try {
      const { checkoutUrl } =
        await chapa.initializeTransaction({
          txRef: payment.id,
          amount: payment.amount,
          email: req.user.email,
          firstName: (req.user.name || 'MarketBridge').split(' ')[0],
          lastName: (req.user.name || '').split(' ').slice(1).join(' ') || 'User',
          phoneNumber: req.user.phone || undefined,
          callbackUrl: `${apiUrl}/api/payments/webhooks/chapa`,
          returnUrl: `${appUrl}/payments/${payment.id}/return`,
          title: payment.type,
          description: `MarketBridge ${payment.type} payment`,
        });

      await prisma.payment.update({
        where: { id: payment.id },
        data: { provider: 'chapa' },
      });

      return res.json({ checkoutUrl });
    } catch (error) {
      console.error('CHAPA INITIALIZE ERROR:', error.chapaResponse || error.message);
      return res.status(error.status || 500).json({
        error: 'Could not start Chapa checkout',
        details: error.message,
      });
    }
  }
);

// ============================================================================
// CHAPA VERIFY
// ============================================================================

router.get(
  '/:id/chapa/verify',
  authenticate,
  [param('id').isUUID()],
  validate,

  async (req, res) => {
    const payment =
      await prisma.payment.findUnique({
        where: { id: req.params.id },
      });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.createdById !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (payment.status === 'PAID') {
      return res.json({ status: 'PAID', payment });
    }

    try {
      const { status, raw } =
        await chapa.verifyTransaction(payment.id);

      if (status === 'success') {
        const updated =
          await prisma.$transaction(
            (tx) =>
              markPaymentPaid(tx, payment.id, {
                provider: 'chapa',
                providerTransactionId: raw?.data?.reference || raw?.data?.tx_ref,
              })
          );

        return res.json({ status: 'PAID', payment: updated });
      }

      return res.json({
        status: status === 'failed' ? 'FAILED' : 'PENDING',
        payment,
        chapaStatus: status,
      });
    } catch (error) {
      console.error('CHAPA VERIFY ERROR:', error.chapaResponse || error.message);
      return res.status(error.status || 500).json({
        error: 'Could not verify Chapa transaction',
        details: error.message,
      });
    }
  }
);

// ============================================================================
// CHAPA WEBHOOK
// ============================================================================

router.post(
  '/webhooks/chapa',
  async (req, res) => {
    const signature =
      req.headers['chapa-signature'] ||
      req.headers['x-chapa-signature'];

    const rawBody = req.rawBody;

    if (!rawBody || !chapa.verifyWebhookSignature(rawBody, signature)) {
      console.error('CHAPA WEBHOOK: invalid signature');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const txRef = req.body?.tx_ref || req.body?.reference;
    const eventStatus = req.body?.status;

    if (!txRef) {
      return res.status(400).json({ error: 'Invalid webhook payload — no tx_ref' });
    }

    try {
      if (eventStatus === 'success' || eventStatus === 'successful') {
        const updated =
          await prisma.$transaction(
            (tx) =>
              markPaymentPaid(tx, txRef, {
                provider: 'chapa',
                providerTransactionId: req.body?.reference,
              })
          );

        return res.json({ ok: true, payment: updated });
      }

      return res.json({ ok: true, ignored: true, eventStatus });
    } catch (error) {
      console.error('CHAPA WEBHOOK PROCESSING ERROR:', error);
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Chapa webhook processing failed',
      });
    }
  }
);

// ============================================================================
// GENERIC WEBHOOK
// ============================================================================

router.post(
  '/webhooks/generic',
  express.json({ limit: '100kb' }),

  async (req, res) => {
    if (!verifySignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const {
      paymentId,
      status,
      reference,
      provider,
      providerTransactionId,
    } = req.body;

    if (!paymentId || !['PAID', 'FAILED', 'REFUNDED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    try {
      if (status === 'PAID') {
        const updated =
          await prisma.$transaction(
            (tx) =>
              markPaymentPaid(tx, paymentId, {
                reference,
                provider,
                providerTransactionId,
              })
          );

        return res.json({ ok: true, payment: updated });
      }

      // Handle FAILED / REFUNDED
      const result =
        await prisma.$transaction(
          async (tx) => {
            const payment =
              await tx.payment.findUnique({
                where: { id: paymentId },
                include: { digitalPurchase: true },
              });

            if (!payment) {
              throw Object.assign(new Error('Payment not found'), { status: 404 });
            }

            if (payment.status === 'REFUNDED' && status !== 'REFUNDED') {
              throw Object.assign(new Error('Refunded payment cannot be reopened'), { status: 409 });
            }

            const updated =
              await tx.payment.update({
                where: { id: payment.id },
                data: {
                  status,
                  reference: reference || payment.reference,
                  provider: provider || payment.provider,
                  providerTransactionId: providerTransactionId || payment.providerTransactionId,
                },
              });

            // Handle refund effects
            if (status === 'REFUNDED') {
              // Refund digital purchase
              if (payment.digitalPurchase) {
                await tx.digitalPurchase.update({
                  where: { id: payment.digitalPurchase.id },
                  data: { status: 'REFUNDED' },
                });
              }

              // Refund ledger entries
              await tx.paymentLedgerEntry.create({
                data: {
                  paymentId: payment.id,
                  type: 'REFUND',
                  amount: -Number(payment.amount),
                  currency: payment.currency || 'ETB',
                  description: 'Payment refund',
                },
              });
            }

            return updated;
          }
        );

      return res.json({ ok: true, payment: result });
    } catch (error) {
      console.error('GENERIC WEBHOOK ERROR:', error);
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Webhook processing failed',
      });
    }
  }
);

// ============================================================================
// ADMIN — PAYMENT QUEUE
// ============================================================================

router.get(
  '/',
  authenticate,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Only an administrator can view all payments' });
    }

    const { status } = req.query;

    const payments =
      await prisma.payment.findMany({
        where: {
          ...(status && { status }),
        },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          order: { select: { id: true, finalPrice: true } },
          digitalProduct: { select: { id: true, title: true } },
          advertisement: { select: { id: true, type: true } },
          inspectionRequest: { select: { id: true, fee: true } },
          commission: true,
          ledgerEntries: true,
        },
        orderBy: { createdAt: 'desc' },
      });

    return res.json({ payments, count: payments.length });
  }
);

// ============================================================================
// COMMISSION SUMMARY
// ============================================================================

router.get(
  '/commissions/summary',
  authenticate,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Only an administrator can view commission records' });
    }

    const paid =
      await prisma.payment.findMany({
        where: { status: 'PAID' },
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
      const type = byType[payment.type] || { volume: 0, commission: 0, count: 0 };

      type.volume += Number(payment.amount);
      type.commission += Number(payment.commissionAmount || 0);
      type.count += 1;

      byType[payment.type] = type;
      totalVolume += Number(payment.amount);
      totalCommission += Number(payment.commissionAmount || 0);
    }

    return res.json({ totalVolume, totalCommission, byType });
  }
);

// ============================================================================
// ADMIN MANUAL CONFIRMATION
// ============================================================================

router.patch(
  '/:id/confirm',
  authenticate,
  async (req, res) => {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Only an administrator can perform manual payment reconciliation' });
    }

    const existing =
      await prisma.payment.findUnique({
        where: { id: req.params.id },
      });

    if (!existing) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (existing.status !== 'PENDING') {
      return res.status(409).json({ error: `Payment is already ${existing.status}` });
    }

    if (existing.provider) {
      return res.status(409).json({
        error: `This payment is linked to ${existing.provider} — confirm it through that gateway's verification, not manually`,
      });
    }

    try {
      const updated =
        await prisma.$transaction(
          (tx) =>
            markPaymentPaid(tx, req.params.id)
        );

      return res.json({ message: 'Payment manually reconciled.', payment: updated });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Could not reconcile payment',
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
  [param('orderId').isUUID()],
  validate,
  async (req, res) => {
    const order =
      await prisma.order.findUnique({
        where: { id: req.params.orderId },
      });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const payments =
      await prisma.payment.findMany({
        where: { orderId: order.id },
        include: {
          commission: true,
          ledgerEntries: true,
        },
        orderBy: { createdAt: 'desc' },
      });

    return res.json({ payments, count: payments.length });
  }
);

// ============================================================================
// PAYMENT BY ID
// ============================================================================

router.get(
  '/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    const payment =
      await prisma.payment.findUnique({
        where: { id: req.params.id },
        include: {
          order: true,
          digitalPurchase: true,
          commission: true,
          ledgerEntries: true,
        },
      });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const owner = payment.createdById === req.user.id;
    const orderParticipant = payment.order && isOrderParticipant(req.user.id, payment.order);

    if (!owner && !orderParticipant && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    return res.json({ payment });
  }
);

module.exports = router;
