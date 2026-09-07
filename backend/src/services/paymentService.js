'use strict';

const prisma = require('../config/db');

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_STATUSES = ['PENDING', 'PAID'];
const TERMINAL_STATUSES = ['PAID', 'REFUNDED'];

// ============================================================================
// MONEY HELPERS
// ============================================================================

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

// ============================================================================
// COMMISSION CONFIGURATION
// ============================================================================

function envRate(name) {
  const number = Number(process.env[name] ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 100) return 0;
  return number;
}

function commissionRateFor(type) {
  const rates = {
    MARKETPLACE: envRate('MARKETPLACE_COMMISSION_RATE'),
    TRANSPORT: envRate('TRANSPORT_COMMISSION_RATE'),
    INSPECTOR: envRate('INSPECTION_COMMISSION_RATE'),
    ADVERTISING: envRate('ADVERTISING_COMMISSION_RATE'),
    DIGITAL: envRate('DIGITAL_COMMISSION_RATE'),
  };
  return rates[type] ?? 0;
}

function commissionAmount(amount, rate) {
  return roundMoney(Number(amount) * Number(rate) / 100);
}

// ============================================================================
// CREATE PAYMENT
// ============================================================================

async function createPayment(data) {
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Payment amount must be greater than zero'), { status: 400 });
  }

  const rate = data.commissionRate ?? commissionRateFor(data.type);
  const commission = commissionAmount(amount, rate);
  const netAmount = roundMoney(Math.max(0, amount - commission));

  return prisma.payment.create({
    data: {
      ...data,
      amount,
      currency: data.currency || 'ETB',
      commissionRate: rate,
      commissionAmount: commission,
      netAmount,
      status: 'PENDING',
    },
  });
}

// ============================================================================
// LEDGER HELPERS
// ============================================================================

async function ledgerEntryExists(tx, paymentId, type) {
  const existing = await tx.paymentLedgerEntry.findFirst({
    where: { paymentId, type },
    select: { id: true },
  });
  return !!existing;
}

async function createLedgerEntryOnce(tx, data) {
  const exists = await ledgerEntryExists(tx, data.paymentId, data.type);
  if (exists) return null;
  return tx.paymentLedgerEntry.create({ data });
}

// ============================================================================
// WRITE FINANCIAL LEDGER
// ============================================================================

async function writeLedger(tx, payment, status) {
  if (status === 'PAID') {
    const amount = Number(payment.amount);
    const commission = roundMoney(Number(payment.commissionAmount || 0));
    const net = roundMoney(Math.max(0, amount - commission));

    // ----- MARKETPLACE -----
    if (payment.type === 'MARKETPLACE' && payment.order) {
      if (net > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId: payment.order.sellerId,
          type: 'SELLER_EARNING',
          amount: net,
          currency: payment.currency,
          description: 'Seller earning from buyer marketplace payment',
        });
      }
      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description: 'Marketplace seller transaction commission',
        });
      }
      return;
    }

    // ----- TRANSPORT -----
    if (payment.type === 'TRANSPORT') {
      const job = payment.transportJob;
      if (job && job.method === 'OWN_TRUCK') return; // no commission

      if (job && job.method === 'HIRE_TRANSPORTER' && job.truckOwnerId) {
        if (net > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId: payment.id,
            userId: job.truckOwnerId,
            type: 'TRANSPORTER_EARNING',
            amount: net,
            currency: payment.currency,
            description: 'Transporter earning from hired transport payment',
          });
        }
        if (commission > 0) {
          await createLedgerEntryOnce(tx, {
            paymentId: payment.id,
            type: 'PLATFORM_COMMISSION',
            amount: commission,
            currency: payment.currency,
            description: 'Hired transporter marketplace commission',
          });
        }
      }
      return;
    }

    // ----- INSPECTOR -----
    if (payment.type === 'INSPECTOR' && payment.inspectionRequest && payment.inspectionRequest.inspectorId) {
      if (net > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId: payment.inspectionRequest.inspectorId,
          type: 'INSPECTOR_EARNING',
          amount: net,
          currency: payment.currency,
          description: 'Inspector service earning',
        });
      }
      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description: 'Inspection marketplace commission',
        });
      }
      return;
    }

    // ----- ADVERTISING -----
    if (payment.type === 'ADVERTISING') {
      await createLedgerEntryOnce(tx, {
        paymentId: payment.id,
        type: 'PLATFORM_REVENUE',
        amount: amount,
        currency: payment.currency,
        description: 'Advertising revenue',
      });
      return;
    }

    // ----- DIGITAL -----
    if (payment.type === 'DIGITAL') {
      if (payment.digitalProduct && payment.digitalProduct.sellerId && net > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          userId: payment.digitalProduct.sellerId,
          type: 'SELLER_EARNING',
          amount: net,
          currency: payment.currency,
          description: 'Digital seller earning',
        });
      }
      if (commission > 0) {
        await createLedgerEntryOnce(tx, {
          paymentId: payment.id,
          type: 'PLATFORM_COMMISSION',
          amount: commission,
          currency: payment.currency,
          description: 'Digital marketplace commission',
        });
      }
    }
  }

  // ----- REFUND -----
  if (status === 'REFUNDED') {
    await createLedgerEntryOnce(tx, {
      paymentId: payment.id,
      type: 'REFUND',
      amount: -Number(payment.amount),
      currency: payment.currency,
      description: 'Payment refund record',
    });
  }
}

// ============================================================================
// SETTLE PAYMENT
// ============================================================================

async function settlePayment({
  paymentId,
  status,
  provider,
  providerTransactionId,
  reference,
  eventId,
  payload = {},
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: true,
        transportJob: true,
        inspectionRequest: true,
        advertisement: true,
        digitalPurchase: true,
        digitalProduct: true,
      },
    });

    if (!payment) {
      throw Object.assign(new Error('Payment not found'), { status: 404 });
    }

    // Amount validation (only if payload provides amount)
    if (payload.amount != null && !moneyEqual(payment.amount, payload.amount)) {
      throw Object.assign(new Error('Payment amount mismatch'), { status: 409 });
    }

    // Currency validation
    if (payload.currency && String(payload.currency).toUpperCase() !== String(payment.currency).toUpperCase()) {
      throw Object.assign(new Error('Payment currency mismatch'), { status: 409 });
    }

    // Idempotent event logging
    if (eventId) {
      try {
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            provider: provider || payment.provider || 'UNKNOWN',
            eventId,
            status,
            payload,
          },
        });
      } catch (error) {
        if (error.code === 'P2002') return payment; // already processed
        throw error;
      }
    }

    // Prevent reopening a refunded payment
    if (payment.status === 'REFUNDED' && status !== 'REFUNDED') {
      return payment;
    }
    if (payment.status === 'PAID' && status === 'FAILED') {
      return payment;
    }

    // Update payment
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status,
        provider: provider || payment.provider,
        providerTransactionId: providerTransactionId || payment.providerTransactionId,
        reference: reference || payment.reference,
      },
    });

    // ----- PAID business effects -----
    if (status === 'PAID') {
      // Marketplace order
      if (payment.type === 'MARKETPLACE' && payment.orderId) {
        await tx.order.updateMany({
          where: { id: payment.orderId, status: 'PENDING_PAYMENT' },
          data: { status: 'CONFIRMED' },
        });
      }

      // Digital purchase
      if (payment.type === 'DIGITAL' && payment.digitalPurchase) {
        await tx.digitalPurchase.update({
          where: { id: payment.digitalPurchase.id },
          data: { status: 'COMPLETED' },
        });
      }

      // Advertising
      if (payment.type === 'ADVERTISING' && payment.advertisement) {
        await tx.advertisement.update({
          where: { id: payment.advertisement.id },
          data: { amountPaid: payment.amount, status: 'ACTIVE' },
        });
      }

      // Financial allocation
      await writeLedger(tx, payment, 'PAID');
    }

    // ----- REFUND business effects -----
    if (status === 'REFUNDED') {
      if (payment.digitalPurchase) {
        await tx.digitalPurchase.update({
          where: { id: payment.digitalPurchase.id },
          data: { status: 'REFUNDED' },
        });
      }
      await writeLedger(tx, payment, 'REFUNDED');
    }

    return updated;
  });
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  moneyEqual,
  commissionRateFor,
  createPayment,
  settlePayment,
};
