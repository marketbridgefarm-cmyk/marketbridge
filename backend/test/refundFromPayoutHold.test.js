'use strict';

// Payout hold -> refund flow. Stubbed transactions (no database), same style
// as test/payoutService.test.js.
//
// Covers the two gaps that used to leave a buyer's money with nobody:
//   1. A dispute resolved with payoutDecision=CANCEL cancelled the payouts but
//      never requested the buyer's refund.
//   2. Cancelling an order requested refunds but left the payouts HELD, so
//      releaseDuePayouts could later release money for a refunded order.

const test = require('node:test');
const assert = require('node:assert/strict');

const payoutService = require('../src/services/payoutService');
const { requestRefundsForPayouts } = require('../src/services/paymentRefundService');

function makeTx({ payments = [], payouts = [] } = {}) {
  const state = { payments, payouts, refunds: [], audit: [], orderEvents: [] };
  const tx = {
    payment: {
      findUnique: async ({ where }) => state.payments.find((p) => p.id === where.id) || null,
      update: async ({ where, data }) => {
        const payment = state.payments.find((p) => p.id === where.id);
        Object.assign(payment, data);
        return payment;
      },
      updateMany: async ({ where, data }) => {
        const payment = state.payments.find((p) => p.id === where.id && (!where.status || p.status === where.status));
        if (!payment) return { count: 0 };
        Object.assign(payment, data);
        return { count: 1 };
      },
    },
    paymentRefund: {
      findFirst: async ({ where }) =>
        state.refunds.find(
          (r) => r.paymentId === where.paymentId && where.status.in.includes(r.status)
        ) || null,
      create: async ({ data }) => {
        const refund = { id: `refund-${state.refunds.length + 1}`, status: 'REQUESTED', ...data };
        state.refunds.push(refund);
        return refund;
      },
    },
    payout: {
      findMany: async ({ where }) => {
        const wanted = where.status.in || [where.status];
        return state.payouts.filter((p) => p.orderId === where.orderId && wanted.includes(p.status));
      },
      update: async ({ where, data }) => {
        const payout = state.payouts.find((p) => p.id === where.id);
        Object.assign(payout, data);
        return { ...payout };
      },
    },
    orderEvent: {
      create: async ({ data }) => {
        const event = { id: `event-${state.orderEvents.length + 1}`, ...data };
        state.orderEvents.push(event);
        return event;
      },
    },
    // No order row -> notification recipients resolve to nobody.
    order: { findUnique: async () => null },
    auditEvent: {
      create: async ({ data }) => {
        state.audit.push(data);
        return { id: `audit-${state.audit.length}`, ...data };
      },
    },
  };
  return { tx, state };
}

const paid = (id, amount, type = 'MARKETPLACE') => ({
  id,
  amount,
  currency: 'ETB',
  status: 'PAID',
  orderId: 'order-1',
  type,
});

const payout = (id, paymentId, payeeRole, status) => ({
  id,
  orderId: 'order-1',
  paymentId,
  payeeRole,
  status,
});

test('requestRefundsForPayouts requests a full refund for each PAID payment behind the payouts', async () => {
  const { tx, state } = makeTx({
    payments: [paid('pay-goods', '5000.00'), paid('pay-truck', '800.00', 'TRANSPORT')],
  });

  const refunds = await requestRefundsForPayouts(tx, {
    payouts: [
      payout('po-1', 'pay-goods', 'SELLER', 'CANCELLED'),
      payout('po-2', 'pay-truck', 'TRANSPORTER', 'CANCELLED'),
    ],
    reason: 'Dispute d-1 resolved: payout cancelled',
    requestedById: 'admin-1',
  });

  assert.equal(refunds.length, 2);
  assert.deepEqual(
    state.refunds.map((r) => [r.paymentId, Number(r.amount), r.status, r.requestedById]),
    [
      ['pay-goods', 5000, 'REQUESTED', 'admin-1'],
      ['pay-truck', 800, 'REQUESTED', 'admin-1'],
    ]
  );
  assert.ok(state.payments.every((p) => p.status === 'REFUND_PENDING'));
  assert.equal(state.refunds[0].reason, 'Dispute d-1 resolved: payout cancelled');
});

test('requestRefundsForPayouts skips payments that are no longer PAID instead of throwing', async () => {
  const { tx, state } = makeTx({
    payments: [
      paid('pay-goods', '5000.00'),
      { ...paid('pay-truck', '800.00', 'TRANSPORT'), status: 'REFUND_PENDING' },
      { ...paid('pay-insp', '270.00', 'INSPECTOR'), status: 'REFUNDED' },
    ],
  });

  const refunds = await requestRefundsForPayouts(tx, {
    payouts: [
      payout('po-1', 'pay-goods', 'SELLER', 'CANCELLED'),
      payout('po-2', 'pay-truck', 'TRANSPORTER', 'CANCELLED'),
      payout('po-3', 'pay-insp', 'INSPECTOR', 'CANCELLED'),
      { id: 'po-4', payeeRole: 'SELLER', status: 'CANCELLED' }, // no paymentId
    ],
    reason: 'x',
    requestedById: 'admin-1',
  });

  assert.equal(refunds.length, 1);
  assert.equal(state.refunds[0].paymentId, 'pay-goods');
});

test('requestRefundsForPayouts is idempotent when run twice', async () => {
  const { tx, state } = makeTx({ payments: [paid('pay-goods', '5000.00')] });
  const input = {
    payouts: [payout('po-1', 'pay-goods', 'SELLER', 'CANCELLED')],
    reason: 'x',
    requestedById: 'admin-1',
  };

  await requestRefundsForPayouts(tx, input);
  const second = await requestRefundsForPayouts(tx, input);

  assert.equal(state.refunds.length, 1);
  assert.equal(second.length, 0, 'second run finds the payment already REFUND_PENDING and skips it');
});

test('cancelPayoutsForOrder cancels every unpaid payout and leaves PAID_OUT / CANCELLED alone', async () => {
  const { tx, state } = makeTx({
    payouts: [
      payout('po-held', 'p1', 'SELLER', 'HELD'),
      payout('po-released', 'p2', 'INSPECTOR', 'RELEASED'),
      payout('po-frozen', 'p3', 'TRANSPORTER', 'ON_HOLD_DISPUTE'),
      payout('po-paid', 'p4', 'SELLER', 'PAID_OUT'),
      payout('po-cancelled', 'p5', 'SELLER', 'CANCELLED'),
    ],
  });

  const cancelled = await payoutService.cancelPayoutsForOrder(tx, {
    orderId: 'order-1',
    actorId: 'buyer-1',
    reason: 'Buyer cancelled',
  });

  assert.deepEqual(cancelled.map((p) => p.id).sort(), ['po-frozen', 'po-held', 'po-released']);
  const statusOf = (id) => state.payouts.find((p) => p.id === id).status;
  assert.equal(statusOf('po-held'), 'CANCELLED');
  assert.equal(statusOf('po-released'), 'CANCELLED');
  assert.equal(statusOf('po-frozen'), 'CANCELLED');
  assert.equal(statusOf('po-paid'), 'PAID_OUT');
  assert.equal(state.audit.length, 3);
  assert.ok(state.audit.every((a) => a.action === 'PAYOUT_CANCELLED_ORDER_CANCELLED'));
});

test('dispute CANCEL path: frozen payouts are cancelled and the buyer refunds are requested together', async () => {
  const { tx, state } = makeTx({
    payments: [paid('pay-goods', '5000.00'), paid('pay-truck', '800.00', 'TRANSPORT')],
    payouts: [
      payout('po-1', 'pay-goods', 'SELLER', 'ON_HOLD_DISPUTE'),
      payout('po-2', 'pay-truck', 'TRANSPORTER', 'ON_HOLD_DISPUTE'),
    ],
  });

  // Same two calls, in the same order, that PATCH /disputes/:id/resolve makes.
  const cancelled = await payoutService.cancelAfterDispute(tx, { orderId: 'order-1', actorId: 'admin-1' });
  const refunds = await requestRefundsForPayouts(tx, {
    payouts: cancelled,
    reason: 'Dispute d-1 resolved: payout cancelled',
    requestedById: 'admin-1',
  });

  assert.ok(state.payouts.every((p) => p.status === 'CANCELLED'));
  assert.equal(refunds.length, 2);
  assert.ok(state.payments.every((p) => p.status === 'REFUND_PENDING'));
});
