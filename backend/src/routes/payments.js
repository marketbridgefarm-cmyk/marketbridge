const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin, isOrderParticipant } = require('../utils/authorization');
const chapa = require('../config/chapa');
const { paymentLimiter } = require('../middleware/rateLimit');
const paymentService = require('../services/paymentService');

const router = express.Router();

// ============ VALIDATION ============
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  next();
};

// ============ HELPERS ============
function timingSafeEqual(a, b) {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifySignature(req) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return false;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const supplied = req.headers['x-marketbridge-signature'];
  return typeof supplied === 'string' && timingSafeEqual(supplied, expected);
}

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

// ============ PAYMENT METHODS (for frontend) ============
router.get('/methods', authenticate, (req, res) => {
  res.json({
    methods: [
      { code: 'TELEBIRR', label: 'Telebirr via Chapa' },
      { code: 'CBE', label: 'CBE' },
      { code: 'QR', label: 'QR Code' },
      { code: 'OTHER', label: 'Other' },
    ],
  });
});

// ============ CREATE PAYMENT ============
router.post('/', authenticate, paymentLimiter, [
  body('type').isIn(['MARKETPLACE', 'TRANSPORT', 'INSPECTOR', 'ADVERTISING', 'DIGITAL']),
  body('amount').isFloat({ gt: 0 }),
  body('method').isIn(['TELEBIRR', 'CBE', 'QR', 'OTHER']),
  body('orderId').optional().isUUID(),
  body('digitalProductId').optional().isUUID(),
  body('advertisementId').optional().isUUID(),
  body('inspectionRequestId').optional().isUUID(),
  body('reference').optional().isString().trim().isLength({ max: 200 }),
], validate, async (req, res) => {
  try {
    const { type, orderId, digitalProductId, advertisementId, inspectionRequestId, reference } = req.body;
    const { method } = req.body;
    const amount = Number(req.body.amount);

    // ---------- AUTHORIZATION & VALIDATION ----------
    if (type === 'MARKETPLACE' || type === 'TRANSPORT') {
      if (!orderId) return res.status(400).json({ error: `${type} payment requires orderId` });
      const order = await prisma.order.findUnique({ where: { id: orderId }, include: { transportJob: true } });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });

      if (type === 'MARKETPLACE') {
        if (order.buyerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Only the buyer may create the marketplace payment' });
        if (!moneyEqual(amount, order.finalPrice)) return res.status(400).json({ error: 'Amount must match order final price', expectedAmount: Number(order.finalPrice) });
        if (order.status === 'COMPLETED') return res.status(400).json({ error: 'Order already completed' });
      }

      if (type === 'TRANSPORT') {
        if (!order.transportJob) return res.status(400).json({ error: 'Transport job required' });
        if (order.transportJob.method === 'OWN_TRUCK') return res.status(400).json({ error: 'No separate transport payment for OWN_TRUCK' });
        if (order.transportJob.status !== 'ACCEPTED') return res.status(400).json({ error: 'Transport must be accepted before payment' });
        if (order.transportJob.agreedAmount == null) return res.status(400).json({ error: 'Agreed amount missing' });
        if (!moneyEqual(amount, order.transportJob.agreedAmount)) return res.status(400).json({ error: 'Amount mismatch', expectedAmount: Number(order.transportJob.agreedAmount) });
        const allowed = order.arrangingParty === 'BUYER' ? order.buyerId === req.user.id : order.arrangingParty === 'SELLER' ? order.sellerId === req.user.id : (order.buyerId === req.user.id || order.sellerId === req.user.id);
        if (!allowed && !isAdmin(req.user)) return res.status(403).json({ error: 'Only arranging party may pay transport' });
        const marketplacePaid = await prisma.payment.findFirst({ where: { orderId: order.id, type: 'MARKETPLACE', status: 'PAID' } });
        if (!marketplacePaid) return res.status(402).json({ error: 'Marketplace payment must be PAID first' });
      }
    } else if (type === 'DIGITAL') {
      if (!digitalProductId) return res.status(400).json({ error: 'digitalProductId required' });
      const product = await prisma.digitalProduct.findUnique({ where: { id: digitalProductId } });
      if (!product || product.status !== 'ACTIVE') return res.status(404).json({ error: 'Digital product not found' });
      if (product.sellerId === req.user.id) return res.status(400).json({ error: 'Cannot purchase own product' });
      if (!moneyEqual(amount, product.price)) return res.status(400).json({ error: 'Amount mismatch', expectedAmount: Number(product.price) });
    } else if (type === 'ADVERTISING') {
      if (!advertisementId) return res.status(400).json({ error: 'advertisementId required' });
      const ad = await prisma.advertisement.findUnique({ where: { id: advertisementId } });
      if (!ad) return res.status(404).json({ error: 'Ad not found' });
      if (ad.advertiserId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
      if (ad.amountPaid != null && !moneyEqual(amount, ad.amountPaid)) return res.status(400).json({ error: 'Amount mismatch', expectedAmount: Number(ad.amountPaid) });
    } else if (type === 'INSPECTOR') {
      if (!inspectionRequestId) return res.status(400).json({ error: 'inspectionRequestId required' });
      const request = await prisma.inspectionRequest.findUnique({ where: { id: inspectionRequestId } });
      if (!request) return res.status(404).json({ error: 'Inspection request not found' });
      if (request.requestedById !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Only requester may pay' });
      if (request.fee == null) return res.status(400).json({ error: 'No agreed fee' });
      if (!moneyEqual(amount, request.fee)) return res.status(400).json({ error: 'Amount mismatch', expectedAmount: Number(request.fee) });
    }

    // Duplicate check
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
    if (duplicate) return res.status(409).json({ error: 'Active payment already exists', payment: duplicate });

    // Create payment using paymentService
    const payment = await paymentService.createPayment({
      createdById: req.user.id,
      type,
      amount,
      method,
      reference: reference || null,
      orderId: orderId || null,
      digitalProductId: digitalProductId || null,
      advertisementId: advertisementId || null,
      inspectionRequestId: inspectionRequestId || null,
    });

    return res.status(201).json({
      message: 'Payment intent created. Use /payments/:id/chapa/initialize for checkout.',
      payment,
      paymentConfirmed: false,
    });
  } catch (error) {
    console.error('CREATE PAYMENT ERROR:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Could not create payment' });
  }
});

// ============ CHAPA INITIALIZE ============
router.post('/:id/chapa/initialize', authenticate, [param('id').isUUID()], validate, async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.createdById !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
  if (payment.status !== 'PENDING') return res.status(409).json({ error: `Payment is ${payment.status}` });
  const appUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const apiUrl = (process.env.API_BASE_URL || '').replace(/\/$/, '');
  if (!appUrl || !apiUrl) return res.status(500).json({ error: 'APP_BASE_URL and API_BASE_URL required' });
  try {
    const { checkoutUrl } = await chapa.initializeTransaction({
      txRef: payment.id, amount: payment.amount, email: req.user.email,
      firstName: (req.user.name || 'MarketBridge').split(' ')[0],
      lastName: (req.user.name || '').split(' ').slice(1).join(' ') || 'User',
      phoneNumber: req.user.phone || undefined,
      callbackUrl: `${apiUrl}/api/payments/webhooks/chapa`,
      returnUrl: `${appUrl}/payments/${payment.id}/return`,
      title: payment.type, description: `MarketBridge ${payment.type} payment`,
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { provider: 'chapa' } });
    return res.json({ checkoutUrl });
  } catch (error) {
    console.error('CHAPA INIT ERROR:', error);
    return res.status(error.status || 500).json({ error: 'Could not start Chapa checkout' });
  }
});

// ============ CHAPA VERIFY ============
router.get('/:id/chapa/verify', authenticate, [param('id').isUUID()], validate, async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.createdById !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
  if (payment.status === 'PAID') return res.json({ status: 'PAID', payment });
  try {
    const { status, raw } = await chapa.verifyTransaction(payment.id);
    if (status === 'success') {
      const settled = await paymentService.settlePayment({
        paymentId: payment.id,
        status: 'PAID',
        provider: 'chapa',
        providerTransactionId: raw?.data?.reference || raw?.data?.tx_ref,
        reference: payment.reference,
        eventId: `chapa-verify-${payment.id}`,
        payload: { amount: payment.amount, currency: payment.currency || 'ETB' },
      });
      return res.json({ status: 'PAID', payment: settled });
    }
    return res.json({ status: status === 'failed' ? 'FAILED' : 'PENDING', payment, chapaStatus: status });
  } catch (error) {
    console.error('CHAPA VERIFY ERROR:', error);
    return res.status(error.status || 500).json({ error: 'Could not verify Chapa transaction' });
  }
});

// ============ CHAPA WEBHOOK ============
router.post('/webhooks/chapa', async (req, res) => {
  const signature = req.headers['chapa-signature'] || req.headers['x-chapa-signature'];
  const rawBody = req.rawBody;
  if (!rawBody || !chapa.verifyWebhookSignature(rawBody, signature)) {
    console.error('CHAPA WEBHOOK: invalid signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  const txRef = req.body?.tx_ref || req.body?.reference;
  const eventStatus = req.body?.status;
  if (!txRef) return res.status(400).json({ error: 'Invalid payload' });
  try {
    if (eventStatus === 'success' || eventStatus === 'successful') {
      const settled = await paymentService.settlePayment({
        paymentId: txRef,
        status: 'PAID',
        provider: 'chapa',
        providerTransactionId: req.body?.reference || txRef,
        eventId: req.body?.event_id || `chapa-webhook-${txRef}`,
        payload: req.body,
      });
      return res.json({ ok: true, payment: settled });
    }
    return res.json({ ok: true, ignored: true, eventStatus });
  } catch (error) {
    console.error('CHAPA WEBHOOK ERROR:', error);
    return res.status(error.status || 500).json({ error: 'Webhook processing failed' });
  }
});

// ============ GENERIC WEBHOOK ============
router.post('/webhooks/generic', express.json({ limit: '100kb' }), async (req, res) => {
  if (!verifySignature(req)) return res.status(401).json({ error: 'Invalid signature' });
  const { paymentId, status, reference, provider, providerTransactionId } = req.body;
  if (!paymentId || !['PAID', 'FAILED', 'REFUNDED'].includes(status)) return res.status(400).json({ error: 'Invalid payload' });
  try {
    const settled = await paymentService.settlePayment({
      paymentId,
      status,
      provider: provider || 'generic',
      providerTransactionId,
      reference: reference || null,
      eventId: `generic-${paymentId}-${Date.now()}`,
      payload: req.body,
    });
    return res.json({ ok: true, payment: settled });
  } catch (error) {
    console.error('GENERIC WEBHOOK ERROR:', error);
    return res.status(error.status || 500).json({ error: 'Webhook processing failed' });
  }
});

// ============ ADMIN PAYMENT QUEUE ============
router.get('/', authenticate, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const { status } = req.query;
  const payments = await prisma.payment.findMany({
    where: { ...(status && { status }) },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      order: { select: { id: true, finalPrice: true } },
      digitalProduct: { select: { id: true, title: true } },
      advertisement: { select: { id: true, type: true } },
      inspectionRequest: { select: { id: true, fee: true } },
      transportJob: { select: { id: true, method: true, agreedAmount: true } },
      commission: true,
      ledgerEntries: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ payments, count: payments.length });
});

// ============ COMMISSION SUMMARY ============
router.get('/commissions/summary', authenticate, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const paid = await prisma.payment.findMany({ where: { status: 'PAID' }, select: { type: true, amount: true, commissionAmount: true } });
  const byType = {}; let totalCommission = 0, totalVolume = 0;
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
});

// ============ ADMIN MANUAL CONFIRMATION ============
router.patch('/:id/confirm', authenticate, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Payment not found' });
  if (existing.status !== 'PENDING') return res.status(409).json({ error: `Payment is ${existing.status}` });
  if (existing.provider) return res.status(409).json({ error: `Payment linked to ${existing.provider} — verify via gateway` });
  try {
    const settled = await paymentService.settlePayment({
      paymentId: existing.id,
      status: 'PAID',
      provider: 'admin',
      eventId: `admin-${existing.id}`,
      payload: { amount: existing.amount, currency: existing.currency || 'ETB' },
    });
    return res.json({ message: 'Payment manually reconciled.', payment: settled });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not reconcile' });
  }
});

// ============ PAYMENTS FOR ORDER ============
router.get('/order/:orderId', authenticate, [param('orderId').isUUID()], validate, async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isOrderParticipant(req.user.id, order) && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
  const payments = await prisma.payment.findMany({
    where: { orderId: order.id },
    include: { commission: true, ledgerEntries: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ payments, count: payments.length });
});

// ============ PAYMENT BY ID ============
router.get('/:id', authenticate, [param('id').isUUID()], validate, async (req, res) => {
  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
    include: { order: true, digitalPurchase: true, commission: true, ledgerEntries: true, transportJob: true },
  });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  const owner = payment.createdById === req.user.id;
  const orderParticipant = payment.order && isOrderParticipant(req.user.id, payment.order);
  if (!owner && !orderParticipant && !isAdmin(req.user)) return res.status(403).json({ error: 'Not authorized' });
  return res.json({ payment });
});

module.exports = router;
