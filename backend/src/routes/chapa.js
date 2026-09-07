const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin, isOrderParticipant } = require('../utils/authorization');
const { commissionFor, netFor } = require('../config/commissions');
const { directCharge, verifyPayment, chapaPaymentType, getChapaConfig } = require('../config/chapa');
const paymentService = require('../services/paymentService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  next();
}

function generateTxRef() {
  return `MB-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let value = String(phone).trim();
  if (/^0[79]\d{8}$/.test(value)) value = `251${value.slice(1)}`;
  if (value.startsWith('+')) value = value.slice(1);
  return value;
}

function amountMatches(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 0.01;
}

function getUserPhone(req) {
  return normalizePhone(req.user?.phone);
}

async function resolvePaymentTarget(req, { type, orderId, digitalProductId, advertisementId, inspectionRequestId }) {
  const amount = { value: null, order: null, digitalProduct: null, advertisement: null, inspectionRequest: null };
  if (type === 'MARKETPLACE' || type === 'TRANSPORT') {
    if (!orderId) throw Object.assign(new Error(`${type} payment requires orderId`), { status: 400 });
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { transportJob: true } });
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) throw Object.assign(new Error('Not authorized'), { status: 403 });
    if (type === 'MARKETPLACE') {
      if (order.buyerId !== req.user.id && !isAdmin(req.user)) throw Object.assign(new Error('Only buyer may pay'), { status: 403 });
      if (order.status !== 'PENDING_PAYMENT') throw Object.assign(new Error(`Order not awaiting payment (${order.status})`), { status: 409 });
      amount.value = Number(order.finalPrice);
    }
    if (type === 'TRANSPORT') {
      if (!order.transportJob) throw Object.assign(new Error('Transport job required'), { status: 400 });
      const job = order.transportJob;
      if (job.method === 'OWN_TRUCK') throw Object.assign(new Error('OWN_TRUCK does not use payment'), { status: 400 });
      if (!job.truckOwnerId) throw Object.assign(new Error('Transporter must be selected'), { status: 400 });
      if (job.agreedAmount == null) throw Object.assign(new Error('No accepted quote'), { status: 400 });
      const allowed = order.arrangingParty === 'BUYER' ? order.buyerId === req.user.id : order.arrangingParty === 'SELLER' ? order.sellerId === req.user.id : (order.buyerId === req.user.id || order.sellerId === req.user.id);
      if (!allowed && !isAdmin(req.user)) throw Object.assign(new Error('Not authorized to pay transport'), { status: 403 });
      amount.value = Number(job.agreedAmount);
    }
    amount.order = order;
    return amount;
  }
  if (type === 'DIGITAL') {
    if (!digitalProductId) throw Object.assign(new Error('digitalProductId required'), { status: 400 });
    const product = await prisma.digitalProduct.findUnique({ where: { id: digitalProductId } });
    if (!product || product.status !== 'ACTIVE') throw Object.assign(new Error('Product not found'), { status: 404 });
    if (product.sellerId === req.user.id) throw Object.assign(new Error('Cannot buy own'), { status: 400 });
    amount.value = Number(product.price);
    amount.digitalProduct = product;
    return amount;
  }
  if (type === 'ADVERTISING') {
    if (!advertisementId) throw Object.assign(new Error('advertisementId required'), { status: 400 });
    const advertisement = await prisma.advertisement.findUnique({ where: { id: advertisementId } });
    if (!advertisement) throw Object.assign(new Error('Ad not found'), { status: 404 });
    if (advertisement.advertiserId !== req.user.id && !isAdmin(req.user)) throw Object.assign(new Error('Not authorized'), { status: 403 });
    if (advertisement.amountPaid == null) throw Object.assign(new Error('Amount not configured'), { status: 400 });
    amount.value = Number(advertisement.amountPaid);
    amount.advertisement = advertisement;
    return amount;
  }
  if (type === 'INSPECTOR') {
    if (!inspectionRequestId) throw Object.assign(new Error('inspectionRequestId required'), { status: 400 });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: inspectionRequestId } });
    if (!request) throw Object.assign(new Error('Inspection request not found'), { status: 404 });
    if (request.requestedById !== req.user.id && !isAdmin(req.user)) throw Object.assign(new Error('Not authorized'), { status: 403 });
    if (request.fee == null) throw Object.assign(new Error('No agreed fee'), { status: 400 });
    amount.value = Number(request.fee);
    amount.inspectionRequest = request;
    return amount;
  }
  throw Object.assign(new Error('Unsupported payment type'), { status: 400 });
}

// ============ CHARGE ============
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
      if (!chapaType) return res.status(400).json({ error: 'This endpoint supports only Telebirr and CBE Direct Charge.' });

      const phone = normalizePhone(req.body.phone) || getUserPhone(req);
      if (!phone) return res.status(400).json({ error: 'A valid phone number is required' });

      const target = await resolvePaymentTarget(req, { type, orderId, digitalProductId, advertisementId, inspectionRequestId });
      if (!amountMatches(requestedAmount, target.value)) {
        return res.status(400).json({ error: 'Amount mismatch', expectedAmount: target.value });
      }

      // Check duplicate
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
      if (duplicate) return res.status(409).json({ error: 'Active payment exists', payment: duplicate });

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

        const providerTransactionId = chapaResponse?.data?.id || chapaResponse?.data?.transaction_id || chapaResponse?.transaction_id || chapaResponse?.id || null;
        const updatedPayment = await prisma.payment.update({
          where: { id: payment.id },
          data: {
            provider: 'CHAPA',
            providerTransactionId: providerTransactionId ? String(providerTransactionId) : null,
            reference: txRef,
          },
        });

        return res.status(201).json({
          message: 'Chapa payment initiated. Verify the transaction using /chapa/verify.',
          payment: updatedPayment,
          chapa: {
            mode: getChapaConfig().mode,
            method,
            chapaType,
            txRef,
            response: chapaResponse,
          },
          paymentConfirmed: false,
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
      return res.status(error.status || 500).json({ error: error.message || 'Could not initiate Chapa payment' });
    }
  }
);

// ============ CONFIG ============
router.get('/config', authenticate, (req, res) => {
  const config = getChapaConfig();
  res.json({
    mode: config.mode,
    publicKey: config.publicKey,
    secretKeyConfigured: config.secretKeyConfigured,
    encryptionKeyConfigured: config.encryptionKeyConfigured,
  });
});

// ============ VERIFY ============
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
      if (!payment) return res.status(404).json({ error: 'Payment not found' });
      const owner = payment.createdById === req.user.id;
      const orderParticipant = payment.order && isOrderParticipant(req.user.id, payment.order);
      if (!owner && !orderParticipant && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
      if (payment.provider !== 'CHAPA') return res.status(400).json({ error: 'Not a Chapa payment' });
      if (payment.reference && payment.reference !== txRef) return res.status(400).json({ error: 'Reference mismatch' });

      const result = await verifyPayment(txRef);
      const data = result?.data || result;
      const chapaStatus = String(data?.status || result?.status || '').toUpperCase();
      const chapaAmount = data?.amount ?? result?.amount ?? null;
      const chapaCurrency = data?.currency ?? result?.currency ?? null;
      const chapaTxRef = data?.tx_ref ?? data?.txRef ?? result?.tx_ref ?? result?.txRef ?? null;

      if (chapaTxRef && String(chapaTxRef) !== String(payment.reference)) {
        return res.status(409).json({ error: 'Chapa transaction reference mismatch' });
      }
      if (chapaAmount != null && !amountMatches(Number(chapaAmount), Number(payment.amount))) {
        return res.status(409).json({ error: 'Amount mismatch', expected: Number(payment.amount), got: Number(chapaAmount) });
      }
      if (chapaCurrency && String(chapaCurrency).toUpperCase() !== 'ETB') {
        return res.status(409).json({ error: 'Currency mismatch', expected: 'ETB', got: chapaCurrency });
      }

      if (['SUCCESS', 'COMPLETED', 'PAID'].includes(chapaStatus)) {
        const settled = await paymentService.settlePayment({
          paymentId: payment.id,
          status: 'PAID',
          provider: 'chapa',
          providerTransactionId: chapaTxRef || payment.reference,
          reference: payment.reference,
          eventId: `chapa-verify-${payment.id}`,
          payload: { amount: payment.amount, currency: payment.currency || 'ETB' },
        });
        return res.json({ message: 'Payment verified successfully', payment: settled, paymentConfirmed: true });
      }

      if (['FAILED', 'CANCELLED', 'CANCELED', 'REVERSED'].includes(chapaStatus)) {
        const updated = await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED' },
        });
        return res.json({ message: 'Payment failed', payment: updated, paymentConfirmed: false });
      }

      return res.json({ message: 'Payment pending', payment, paymentConfirmed: false });
    } catch (error) {
      console.error('Chapa verification error:', error);
      return res.status(error.status || 502).json({ error: error.message || 'Could not verify Chapa payment' });
    }
  }
);

// ============ GET PAYMENT ============
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
        transportJob: true,
        commission: true,
        ledgerEntries: true,
      },
    });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const owner = payment.createdById === req.user.id;
    const orderParticipant = payment.order && isOrderParticipant(req.user.id, payment.order);
    if (!owner && !orderParticipant && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
    res.json({ payment });
  }
);

module.exports = router;
