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
const { directCharge, verifyPayment, chapaPaymentType, getChapaConfig } = require('../config/chapa');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
}

function generateTxRef() {
  return `MB-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).trim();

  // Ethiopia: 09xxxxxxxx -> 2519xxxxxxxx
  if (/^0[79]\d{8}$/.test(value)) {
    value = `251${value.slice(1)}`;
  }

  if (value.startsWith('+')) {
    value = value.slice(1);
  }

  return value;
}

function amountMatches(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 0.01;
}

function getUserPhone(req) {
  return normalizePhone(req.user?.phone);
}

async function resolvePaymentTarget(req, {
  type,
  orderId,
  digitalProductId,
  advertisementId,
  inspectionRequestId,
}) {
  const amount = { value: null, order: null, digitalProduct: null, advertisement: null, inspectionRequest: null };

  if (type === 'MARKETPLACE' || type === 'TRANSPORT') {
    if (!orderId) {
      throw Object.assign(new Error(`${type} payment requires orderId`), { status: 400 });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { transportJob: true },
    });

    if (!order) {
      throw Object.assign(new Error('Order not found'), { status: 404 });
    }

    if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) {
      throw Object.assign(new Error('Not authorized'), { status: 403 });
    }

    if (type === 'MARKETPLACE') {
      if (order.buyerId !== req.user.id && !isAdmin(req.user)) {
        throw Object.assign(new Error('Only the buyer may create the marketplace payment'), { status: 403 });
      }

      if (order.status !== 'PENDING_PAYMENT') {
        throw Object.assign(new Error(`This order is not awaiting marketplace payment. Current status: ${order.status}`), { status: 409 });
      }

      amount.value = Number(order.finalPrice);
    }

    if (type === 'TRANSPORT') {
      if (!order.transportJob) {
        throw Object.assign(new Error('Transport job required'), { status: 400 });
      }

      const job = order.transportJob;

      if (job.method === 'OWN_TRUCK') {
        throw Object.assign(new Error('Own-truck arrangements do not use MarketBridge transport payment'), { status: 400 });
      }

      if (!job.truckOwnerId) {
        throw Object.assign(new Error('A transporter must be selected before transport payment'), { status: 400 });
      }

      if (job.agreedAmount == null) {
        throw Object.assign(new Error('This transport job has no accepted quote yet'), { status: 400 });
      }

      const allowed =
        order.arrangingParty === 'BUYER'
          ? order.buyerId === req.user.id
          : order.arrangingParty === 'SELLER'
            ? order.sellerId === req.user.id
            : order.buyerId === req.user.id || order.sellerId === req.user.id;

      if (!allowed && !isAdmin(req.user)) {
        throw Object.assign(new Error('Not authorized to pay for this transport'), { status: 403 });
      }

      amount.value = Number(job.agreedAmount);
    }

    amount.order = order;
    return amount;
  }

  if (type === 'DIGITAL') {
    if (!digitalProductId) {
      throw Object.assign(new Error('digitalProductId is required'), { status: 400 });
    }

    const product = await prisma.digitalProduct.findUnique({
      where: { id: digitalProductId },
    });

    if (!product || product.status !== 'ACTIVE') {
      throw Object.assign(new Error('Digital product not found'), { status: 404 });
    }

    if (product.sellerId === req.user.id) {
      throw Object.assign(new Error('You cannot purchase your own product'), { status: 400 });
    }

    amount.value = Number(product.price);
    amount.digitalProduct = product;

    return amount;
  }

  if (type === 'ADVERTISING') {
    if (!advertisementId) {
      throw Object.assign(new Error('advertisementId is required'), { status: 400 });
    }

    const advertisement = await prisma.advertisement.findUnique({
      where: { id: advertisementId },
    });

    if (!advertisement) {
      throw Object.assign(new Error('Advertisement not found'), { status: 404 });
    }

    if (advertisement.advertiserId !== req.user.id && !isAdmin(req.user)) {
      throw Object.assign(new Error('Not authorized'), { status: 403 });
    }

    if (advertisement.amountPaid == null) {
      throw Object.assign(new Error('Advertisement payment amount has not been configured'), { status: 400 });
    }

    amount.value = Number(advertisement.amountPaid);
    amount.advertisement = advertisement;

    return amount;
  }

  if (type === 'INSPECTOR') {
    if (!inspectionRequestId) {
      throw Object.assign(new Error('inspectionRequestId is required'), { status: 400 });
    }

    const request = await prisma.inspectionRequest.findUnique({
      where: { id: inspectionRequestId },
    });

    if (!request) {
      throw Object.assign(new Error('Inspection request not found'), { status: 404 });
    }

    if (request.requestedById !== req.user.id && !isAdmin(req.user)) {
      throw Object.assign(new Error('Only the person who requested the inspection may pay'), { status: 403 });
    }

    if (request.fee == null) {
      throw Object.assign(new Error('This inspection has no agreed fee yet'), { status: 400 });
    }

    amount.value = Number(request.fee);
    amount.inspectionRequest = request;

    return amount;
  }

  throw Object.assign(new Error('Unsupported payment type'), { status: 400 });
}

// POST /chapa/charge
router.post(
  '/charge',
  authenticate,
  [
    body('type').isIn(['MARKETPLACE', 'TRANSPORT', 'INSPECTOR', 'ADVERTISING', 'DIGITAL']),
    body('method').isIn(['TELEBIRR', 'CBE']),
    body('orderId').optional().isUUID(),
    body('digitalProductId').optional().isUUID(),
    body('advertisementId').optional().isUUID(),
    body('inspectionRequestId').optional().isUUID(),
    body('amount').isFloat({ gt: 0 }),
    body('phone').optional().isString().trim().isLength({ min: 9, max: 20 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { type, method, orderId, digitalProductId, advertisementId, inspectionRequestId } = req.body;
      const requestedAmount = Number(req.body.amount);
      const chapaType = chapaPaymentType(method);

      if (!chapaType) {
        return res.status(400).json({
          error: 'This endpoint currently supports only Telebirr and CBE Direct Charge.',
        });
      }

      const phone = normalizePhone(req.body.phone) || getUserPhone(req);

      if (!phone) {
        return res.status(400).json({
          error: 'A Telebirr/CBE mobile number is required. Add a phone number to your MarketBridge account or provide one for this payment.',
        });
      }

      const target = await resolvePaymentTarget(req, {
        type,
        orderId,
        digitalProductId,
        advertisementId,
        inspectionRequestId,
      });

      if (!amountMatches(requestedAmount, target.value)) {
        return res.status(400).json({
          error: 'Amount does not match the amount due',
          expectedAmount: target.value,
        });
      }

      // Prevent duplicate active payments
      const duplicate = await prisma.payment.findFirst({
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
          error: 'An active payment already exists for this transaction',
          payment: duplicate,
        });
      }

      const txRef = generateTxRef();

      const commission = commissionFor(type, requestedAmount);
      const net = netFor(type, requestedAmount);

      const payment = await prisma.payment.create({
        data: {
          createdById: req.user.id,
          type,
          amount: requestedAmount,
          method,
          status: 'PENDING',
          reference: txRef,
          orderId: orderId || null,
          digitalProductId: digitalProductId || null,
          advertisementId: advertisementId || null,
          inspectionRequestId: inspectionRequestId || null,
          commissionRate: commission.rate,
          commissionAmount: commission.commissionAmount,
          netAmount: net.netAmount,
          provider: 'CHAPA',
        },
      });

      try {
        const chapaResponse = await directCharge({
          type: chapaType,
          amount: requestedAmount,
          mobile: phone,
          txRef,
          currency: 'ETB',
        });

        const providerTransactionId =
          chapaResponse?.data?.id ||
          chapaResponse?.data?.transaction_id ||
          chapaResponse?.transaction_id ||
          chapaResponse?.id ||
          null;

        const updatedPayment = await prisma.payment.update({
          where: { id: payment.id },
          data: {
            provider: 'CHAPA',
            providerTransactionId: providerTransactionId ? String(providerTransactionId) : null,
            reference: txRef,
            status: 'PENDING',
          },
        });

        return res.status(201).json({
          message: 'Chapa payment initiated. Authorization is required before payment can be confirmed.',
          payment: updatedPayment,
          chapa: {
            mode: getChapaConfig().mode,
            method,
            chapaType,
            txRef,
            response: chapaResponse,
          },
          paymentConfirmed: false,
          nextStep: 'Authorize the Chapa transaction and then verify its final status.',
        });
      } catch (chapaError) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', provider: 'CHAPA' },
        });

        return res.status(chapaError.status >= 400 && chapaError.status < 600 ? chapaError.status : 502).json({
          error: 'Chapa Direct Charge could not be initiated',
          details: chapaError.response || chapaError.message,
          paymentId: payment.id,
          txRef,
        });
      }
    } catch (error) {
      console.error('Chapa charge error:', error);
      return res.status(error.status || 500).json({
        error: error.message || 'Could not initiate Chapa payment',
      });
    }
  }
);

// GET /chapa/config
router.get('/config', authenticate, (req, res) => {
  const config = getChapaConfig();
  res.json({
    mode: config.mode,
    publicKey: config.publicKey,
    secretKeyConfigured: config.secretKeyConfigured,
    encryptionKeyConfigured: config.encryptionKeyConfigured,
  });
});

// POST /chapa/verify
router.post(
  '/verify',
  authenticate,
  [body('paymentId').isUUID(), body('txRef').isString().trim().isLength({ min: 5, max: 200 })],
  validate,
  async (req, res) => {
    try {
      const { paymentId, txRef } = req.body;

      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { order: true, digitalPurchase: true, advertisement: true },
      });

      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      const owner = payment.createdById === req.user.id;
      const orderParticipant = payment.order && isOrderParticipant(req.user.id, payment.order);

      if (!owner && !orderParticipant && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      if (payment.provider !== 'CHAPA') {
        return res.status(400).json({ error: 'This payment is not a Chapa payment' });
      }

      if (payment.reference && payment.reference !== txRef) {
        return res.status(400).json({ error: 'Transaction reference does not match the MarketBridge payment' });
      }

      const result = await verifyPayment(txRef);

      const data = result?.data || result;
      const chapaStatus = String(data?.status || result?.status || '').toUpperCase();
      const chapaAmount = data?.amount ?? result?.amount ?? null;
      const chapaCurrency = data?.currency ?? result?.currency ?? null;
      const chapaTxRef = data?.tx_ref ?? data?.txRef ?? result?.tx_ref ?? result?.txRef ?? null;

      if (chapaTxRef && String(chapaTxRef) !== String(payment.reference)) {
        return res.status(409).json({ error: 'Chapa transaction reference mismatch', paymentId: payment.id });
      }

      if (chapaAmount != null && !amountMatches(Number(chapaAmount), Number(payment.amount))) {
        return res.status(409).json({
          error: 'Chapa amount does not match MarketBridge payment amount',
          expectedAmount: Number(payment.amount),
          chapaAmount: Number(chapaAmount),
        });
      }

      if (chapaCurrency && String(chapaCurrency).toUpperCase() !== 'ETB') {
        return res.status(409).json({
          error: 'Chapa returned an unexpected currency',
          expectedCurrency: 'ETB',
          chapaCurrency,
        });
      }

      if (['SUCCESS', 'COMPLETED', 'PAID'].includes(chapaStatus)) {
        const updated = await prisma.$transaction(async (tx) => {
          const current = await tx.payment.findUnique({
            where: { id: payment.id },
            include: { digitalPurchase: true, advertisement: true },
          });

          if (!current) {
            throw Object.assign(new Error('Payment no longer exists'), { status: 404 });
          }

          if (current.status === 'REFUNDED') {
            throw Object.assign(new Error('A refunded payment cannot be reopened'), { status: 409 });
          }

          if (current.status === 'PAID') {
            return current;
          }

          const commission = commissionFor(current.type, current.amount);
          const net = netFor(current.type, current.amount);

          const paid = await tx.payment.update({
            where: { id: current.id },
            data: {
              status: 'PAID',
              provider: 'CHAPA',
              reference: current.reference || txRef,
              providerTransactionId: current.providerTransactionId || String(txRef),
              commissionRate: commission.rate,
              commissionAmount: commission.commissionAmount,
              netAmount: net.netAmount,
            },
          });

          // Create commission record
          if (commission.commissionAmount > 0 && ['MARKETPLACE', 'TRANSPORT', 'INSPECTOR', 'DIGITAL'].includes(current.type)) {
            await tx.commission.create({
              data: {
                paymentId: current.id,
                orderId: current.orderId,
                transportJobId: current.transportJobId,
                type: current.type,
                rate: commission.rate,
                amount: commission.commissionAmount,
                currency: current.currency || 'ETB',
                status: 'RECORDED',
              },
            });
          }

          // Create ledger entries
          if (commission.commissionAmount > 0) {
            await tx.paymentLedgerEntry.create({
              data: {
                paymentId: current.id,
                type: 'PLATFORM_COMMISSION',
                amount: commission.commissionAmount,
                currency: current.currency || 'ETB',
                description: `${current.type} commission`,
              },
            });
          }

          // Marketplace order update
          if (current.type === 'MARKETPLACE' && current.orderId) {
            await tx.order.updateMany({
              where: { id: current.orderId, status: 'PENDING_PAYMENT' },
              data: { status: 'CONFIRMED' },
            });
          }

          // Digital purchase update
          if (current.type === 'DIGITAL' && current.digitalPurchase) {
            await tx.digitalPurchase.update({
              where: { id: current.digitalPurchase.id },
              data: { status: 'COMPLETED' },
            });
          }

          // Advertising update
          if (current.type === 'ADVERTISING' && current.advertisementId) {
            await tx.advertisement.update({
              where: { id: current.advertisementId },
              data: { amountPaid: current.amount },
            });
          }

          return paid;
        });

        return res.json({
          message: 'Chapa payment verified successfully',
          payment: updated,
          chapa: result,
          paymentConfirmed: true,
        });
      }

      if (['FAILED', 'CANCELLED', 'CANCELED', 'REVERSED'].includes(chapaStatus)) {
        const updated = await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', provider: 'CHAPA', providerTransactionId: payment.providerTransactionId || String(txRef) },
        });

        return res.json({
          message: 'Chapa payment was not successful',
          payment: updated,
          chapa: result,
          paymentConfirmed: false,
        });
      }

      return res.json({
        message: 'Chapa payment has not reached a final successful state yet',
        payment,
        chapa: result,
        paymentConfirmed: false,
      });
    } catch (error) {
      console.error('Chapa verification error:', error);
      return res.status(error.status || 502).json({
        error: error.message || 'Could not verify Chapa payment',
      });
    }
  }
);

// GET /chapa/payment/:id
router.get(
  '/payment/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: {
        order: true,
        digitalProduct: true,
        advertisement: true,
        inspectionRequest: true,
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

    res.json({ payment });
  }
);

module.exports = router;
