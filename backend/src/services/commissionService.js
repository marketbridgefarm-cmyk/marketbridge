'use strict';

const prisma = require('../config/db');

function money(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.round(n * 100) / 100;
}

function rateFromEnvironment(type) {
  const rates = {
    MARKETPLACE:
      process.env.MARKETPLACE_COMMISSION_RATE,

    TRANSPORT:
      process.env.TRANSPORT_COMMISSION_RATE,

    INSPECTOR:
      process.env.INSPECTION_COMMISSION_RATE,

    DIGITAL:
      process.env.DIGITAL_COMMISSION_RATE,
  };

  const rate = Number(rates[type] ?? 0);

  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 100
  ) {
    return 0;
  }

  return rate;
}

function calculateCommission(amount, rate) {
  return money(
    (Number(amount) * Number(rate)) / 100
  );
}

/**
 * Creates exactly one commission for a payment.
 *
 * IMPORTANT:
 * paymentId is UNIQUE in the database.
 *
 * Therefore repeated webhook/reconciliation calls cannot
 * create multiple commissions for the same payment.
 */
async function createCommission(
  tx,
  {
    payment,
    type,
    orderId = null,
    transportJobId = null,
  }
) {
  if (!payment) {
    throw new Error(
      'Payment is required to create commission'
    );
  }

  if (payment.status !== 'PAID') {
    throw new Error(
      'Commission can only be created for a PAID payment'
    );
  }

  if (
    type === 'TRANSPORT' &&
    !transportJobId
  ) {
    throw new Error(
      'Transport commission requires a transport job'
    );
  }

  if (
    type === 'MARKETPLACE' &&
    !orderId
  ) {
    throw new Error(
      'Marketplace commission requires an order'
    );
  }

  const existing =
    await tx.commission.findUnique({
      where: {
        paymentId: payment.id,
      },
    });

  if (existing) {
    return {
      commission: existing,
      created: false,
    };
  }

  const rate =
    payment.commissionRate != null
      ? Number(payment.commissionRate)
      : rateFromEnvironment(type);

  const amount =
    payment.commissionAmount != null
      ? money(payment.commissionAmount)
      : calculateCommission(
          payment.amount,
          rate
        );

  /*
   * OWN_TRUCK must never call this function with TRANSPORT.
   * This is deliberately enforced at the service boundary.
   */
  const commission =
    await tx.commission.create({
      data: {
        paymentId:
          payment.id,

        orderId,

        transportJobId,

        type,

        rate:
          money(rate),

        amount,

        currency:
          payment.currency || 'ETB',

        status:
          'RECORDED',
      },
    });

  return {
    commission,
    created: true,
  };
}

/**
 * Creates the correct commission for a verified payment.
 *
 * MARKETPLACE:
 * buyer -> seller transaction
 *
 * TRANSPORT:
 * only HIRE_TRANSPORTER
 *
 * OWN_TRUCK:
 * absolutely no transport commission
 */
async function createCommissionForPayment(
  tx,
  payment
) {
  if (
    payment.type ===
    'MARKETPLACE'
  ) {
    if (!payment.orderId) {
      throw new Error(
        'Marketplace payment has no order'
      );
    }

    return createCommission(tx, {
      payment,
      type: 'MARKETPLACE',
      orderId:
        payment.orderId,
    });
  }

  if (
    payment.type ===
    'TRANSPORT'
  ) {
    if (!payment.transportJob) {
      throw new Error(
        'Transport payment has no transport job'
      );
    }

    /*
     * This is the most important OWN_TRUCK protection.
     *
     * A TRANSPORT payment belonging to OWN_TRUCK
     * must never produce a transporter commission.
     */
    if (
      payment.transportJob.method ===
      'OWN_TRUCK'
    ) {
      return {
        commission: null,
        created: false,
        skipped:
          'OWN_TRUCK does not generate a transport commission',
      };
    }

    if (
      payment.transportJob.method !==
      'HIRE_TRANSPORTER'
    ) {
      throw new Error(
        'Unsupported transport method for commission'
      );
    }

    return createCommission(tx, {
      payment,
      type: 'TRANSPORT',
      orderId:
        payment.orderId,
      transportJobId:
        payment.transportJobId,
    });
  }

  if (
    payment.type ===
    'INSPECTOR'
  ) {
    return createCommission(tx, {
      payment,
      type: 'INSPECTOR',
      orderId:
        payment.orderId,
    });
  }

  if (
    payment.type ===
    'DIGITAL'
  ) {
    return createCommission(tx, {
      payment,
      type: 'DIGITAL',
      orderId:
        payment.orderId,
    });
  }

  return {
    commission: null,
    created: false,
    skipped:
      'Payment type does not generate commission',
  };
}

module.exports = {
  rateFromEnvironment,
  calculateCommission,
  createCommission,
  createCommissionForPayment,
};
