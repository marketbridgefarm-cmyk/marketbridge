'use strict';

/**
 * Durable payment obligations are the commercial source of truth.
 * Payment rows are attempts/intents that settle one obligation.
 */
async function syncOrderPaymentObligations(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      payments: true,
      inspectionRequests: {
        where: { status: { not: 'CANCELLED' } },
        include: { payments: true },
      },
      transportJob: true,
    },
  });
  if (!order) return [];

  // Inspection payment obligations do not exist commercially until the
  // seller has confirmed the provisional inspector agreement. Cancel any
  // legacy/open obligations left by an older sync so they cannot be used as
  // a payment bypass. Once sellerConfirmedAt is set, the same stable keys
  // are recreated/reopened below.
  const unconfirmedInspections = (order.inspectionRequests || []).filter(
    (r) => !r.sellerConfirmedAt
  );
  if (unconfirmedInspections.length) {
    await tx.paymentObligation.updateMany({
      where: {
        orderId: order.id,
        type: 'INSPECTOR',
        inspectionRequestId: { in: unconfirmedInspections.map((r) => r.id) },
        status: 'OPEN',
      },
      data: { status: 'CANCELLED' },
    });
  }

  // The MARKETPLACE (goods) obligation only becomes live once the
  // transporter's loading-preparation report has been approved by the buyer.
  // For hire-transport orders, the unlock is `buyerLoadingConfirmedAt`.
  // For own-truck arrangements (no loading report exists), fall back to the
  // seller's pickup readiness confirmation.
  const goodsPaymentUnlocked = order.transportJob
    ? (order.transportJob.method === 'HIRE_TRANSPORTER'
        ? Boolean(order.transportJob.buyerLoadingConfirmedAt)
        : Boolean(order.transportJob.sellerPickupConfirmedAt))
    : false;

  const desired = [];

  if (goodsPaymentUnlocked) {
    desired.push({
      obligationKey: `ORDER:${order.id}:MARKETPLACE`,
      type: 'MARKETPLACE',
      payerId: order.buyerId,
      beneficiaryId: order.sellerId,
      amount: order.finalPrice,
      inspectionRequestId: null,
      transportJobId: null,
    });
  }

  for (const r of order.inspectionRequests || []) {
    // The inspection fee is not a live payment obligation until the seller
    // confirms the selected inspector and agreed fee.
    if (!r.sellerConfirmedAt) continue;
    if (r.fee == null || Number(r.fee) <= 0 || !r.inspectorId) continue;
    const totalFee = Number(r.feeTermsLockedAt && r.lockedFee != null ? r.lockedFee : r.fee);
    const payerMode = r.feeTermsLockedAt && r.lockedFeePayer
      ? r.lockedFeePayer
      : (r.feePayer || (r.mode === 'SELLER_REQUESTED' ? 'SELLER' : 'BUYER'));
    const buyerShare = r.feeTermsLockedAt && r.lockedBuyerFeeAmount != null
      ? Number(r.lockedBuyerFeeAmount)
      : payerMode === 'SELLER' ? 0 : payerMode === 'SPLIT' ? Math.round(totalFee * 50) / 100 : totalFee;
    const sellerShare = r.feeTermsLockedAt && r.lockedSellerFeeAmount != null
      ? Number(r.lockedSellerFeeAmount)
      : payerMode === 'BUYER' ? 0 : payerMode === 'SPLIT' ? Math.round((totalFee - buyerShare) * 100) / 100 : totalFee;
    const addInspection = (role, payerId, amount) => {
      if (!amount || amount <= 0) return;
      desired.push({
        obligationKey: payerMode === 'SPLIT' ? `ORDER:${order.id}:INSPECTOR:${r.id}:${role}` : `ORDER:${order.id}:INSPECTOR:${r.id}`,
        type: 'INSPECTOR', payerId, beneficiaryId: r.inspectorId, amount,
        inspectionRequestId: r.id, transportJobId: null,
      });
    };
    if (buyerShare > 0) addInspection('BUYER', order.buyerId, buyerShare);
    if (sellerShare > 0) addInspection('SELLER', order.sellerId, sellerShare);
  }

  const job = order.transportJob;
  const transportStillAgreed = Boolean(
    job?.method === 'HIRE_TRANSPORTER' &&
    job.agreedAmount != null &&
    Number(job.agreedAmount) > 0 &&
    job.truckOwnerId
  );
  if (transportStillAgreed) {
    desired.push({
      obligationKey: `ORDER:${order.id}:TRANSPORT`,
      type: 'TRANSPORT',
      payerId: order.buyerId,
      beneficiaryId: job.truckOwnerId,
      amount: job.agreedAmount,
      inspectionRequestId: null,
      transportJobId: job.id,
    });
  }

  const result = [];
  for (const item of desired) {
    let obligation = await tx.paymentObligation.findUnique({
      where: { obligationKey: item.obligationKey },
      include: { payment: true },
    });

    const matchingPayment = item.type === 'INSPECTOR'
      ? (order.inspectionRequests || [])
          .find(r => r.id === item.inspectionRequestId)
          ?.payments?.find(p => p.type === 'INSPECTOR' && p.createdById === item.payerId && ['PENDING','PAID'].includes(p.status))
      : order.payments.find(p =>
          p.type === item.type &&
          ['PENDING','PAID'].includes(p.status) &&
          (item.type !== 'TRANSPORT' || p.transportJobId === item.transportJobId)
        );

    // A previously cancelled obligation may be safely reopened when the
    // seller has now confirmed the inspection. Stable obligation keys prevent
    // duplicate commercial obligations.
    const status = matchingPayment?.status === 'PAID' || obligation?.payment?.status === 'PAID'
      ? 'PAID'
      : 'OPEN';

    const data = {
      type: item.type,
      payerId: item.payerId,
      beneficiaryId: item.beneficiaryId,
      amount: item.amount,
      currency: 'ETB',
      inspectionRequestId: item.inspectionRequestId,
      transportJobId: item.transportJobId,
      status,
    };

    obligation = obligation
      ? await tx.paymentObligation.update({ where: { id: obligation.id }, data, include: { payment: true } })
      : await tx.paymentObligation.create({
          data: { ...data, orderId: order.id, obligationKey: item.obligationKey },
          include: { payment: true },
        });

    // Legacy payments created before this model are linked opportunistically.
    if (matchingPayment && !obligation.payment) {
      try {
        await tx.payment.update({
          where: { id: matchingPayment.id },
          data: { obligationId: obligation.id },
        });
      } catch (_) {
        // Another concurrent sync may have linked it. The obligation remains valid.
      }
    }

    result.push(obligation);
  }

  // Retire the MARKETPLACE obligation if goods payment has not been unlocked,
  // so a stale one from an earlier sync cannot survive. PAID is never touched.
  if (!goodsPaymentUnlocked) {
    await tx.paymentObligation.updateMany({
      where: {
        orderId: order.id,
        type: 'MARKETPLACE',
        status: 'OPEN',
        obligationKey: `ORDER:${order.id}:MARKETPLACE`,
      },
      data: { status: 'CANCELLED' },
    });
  }

  // Retire the TRANSPORT obligation when no transporter is agreed any more
  // (released, reopened or cancelled). Otherwise the old fee stays payable.
  if (!transportStillAgreed) {
    await tx.paymentObligation.updateMany({
      where: { orderId: order.id, type: 'TRANSPORT', status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
  }

  // Retire inspection obligations that are no longer wanted (e.g. fee payer
  // mode changed BUYER -> SPLIT, or the request was cancelled). PAID
  // obligations are never touched.
  await tx.paymentObligation.updateMany({
    where: {
      orderId: order.id,
      type: 'INSPECTOR',
      status: 'OPEN',
      obligationKey: { notIn: desired.map((d) => d.obligationKey) },
    },
    data: { status: 'CANCELLED' },
  });
  return result;
}

async function findPaymentObligation(tx, {
  orderId, type, inspectionRequestId = null, payerId = null,
}) {
  if (!orderId) return null;
  const key = type === 'INSPECTOR'
    ? `ORDER:${orderId}:INSPECTOR:${inspectionRequestId}`
    : type === 'TRANSPORT'
      ? `ORDER:${orderId}:TRANSPORT`
      : `ORDER:${orderId}:${type}`;
  if (type === 'INSPECTOR' && payerId) {
    const byPayer = await tx.paymentObligation.findFirst({ where: { orderId, type: 'INSPECTOR', inspectionRequestId, payerId } });
    if (byPayer) return byPayer;
  }
  return tx.paymentObligation.findUnique({ where: { obligationKey: key } });
}

module.exports = { syncOrderPaymentObligations, findPaymentObligation };
