'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// Stub the cancellation service's collaborators, then drive it with a fake transaction.
const calls = { refunds: [], cancelPayouts: null, audit: [] };
const stubs = {
  '../utils/audit': { recordAuditEvent: async (_tx, e) => calls.audit.push(e) },
  './orderEventService': { recordOrderEvent: async () => {} },
  './inventoryService': { releaseListingQuantity: async () => true },
  './paymentRefundService': { requestRefund: async (_tx, a) => { calls.refunds.push(a.paymentId); return { id: `refund-${a.paymentId}` }; } },
  './installmentService': { isInstallmentParent: () => false },
  './payoutService': { cancelPayoutsForOrder: async (_tx, a) => { calls.cancelPayouts = a; return []; } },
  './orderStateMachine': { transitionOrderStatus: async () => {} },
};
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && /orderCancellationService\.js$/.test(parent.filename) && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};
const { cancelOrderInTransaction } = require('../src/services/orderCancellationService');
Module._load = originalLoad;

function fakeTx({ completedRequests = [], payments = [] }) {
  const tx = {
    inspectionRequestUpdate: null,
    order: { updateMany: async () => ({}), findUnique: async () => ({ id: 'o1', status: 'CANCELLED' }) },
    paymentObligation: { updateMany: async () => ({}) },
    listing: { update: async () => ({}) },
    transportJob: { update: async () => ({}) },
    transportQuote: { updateMany: async () => ({}) },
    truck: { updateMany: async () => ({}) },
    inspectionRequest: {
      findMany: async () => completedRequests,
      updateMany: async (args) => { tx.inspectionRequestUpdate = args; return { count: 1 }; },
    },
    inspectionQuote: { updateMany: async () => ({}) },
    payment: {
      findMany: async ({ where }) => (where.transportJobId ? [] : payments),
      updateMany: async () => ({}),
    },
    offer: { updateMany: async () => ({}), findMany: async () => [] },
  };
  return tx;
}

const order = { id: 'o1', status: 'IN_PROGRESS', listingId: 'l1', payments: [], transportJob: null, agreedOfferId: null };

test('cancelling after the report: completed inspection stays COMPLETED, fee is not refunded, payout is retained', async () => {
  calls.refunds.length = 0; calls.cancelPayouts = null; calls.audit.length = 0;
  const tx = fakeTx({
    completedRequests: [{ id: 'req1' }],
    payments: [
      { id: 'pay-goods', type: 'MARKETPLACE', amount: 1000, status: 'PAID', inspectionRequestId: null },
      { id: 'pay-inspect', type: 'INSPECTOR', amount: 300, status: 'PAID', inspectionRequestId: 'req1' },
    ],
  });
  await cancelOrderInTransaction(tx, { order, actorId: 'buyer1', reason: 'Cancel after inspection', cancelledByRole: 'BUYER' });

  assert.deepEqual(calls.refunds, ['pay-goods']);                                  // inspection fee NOT refunded
  assert.deepEqual(calls.cancelPayouts.retainInspectionRequestIds, ['req1']);      // payout retained
  assert.deepEqual(tx.inspectionRequestUpdate.where.id, { notIn: ['req1'] });      // stays COMPLETED
  const audit = calls.audit.find((a) => a.action === 'ORDER_CANCELLED');
  assert.deepEqual(audit.metadata.retainedInspectionPaymentIds, ['pay-inspect']);
  assert.deepEqual(audit.metadata.refundedPaymentIds, ['pay-goods']);
});

test('an unfinished inspection is still cancelled and its fee still refunded', async () => {
  calls.refunds.length = 0; calls.cancelPayouts = null;
  const tx = fakeTx({
    completedRequests: [],
    payments: [
      { id: 'pay-goods', type: 'MARKETPLACE', amount: 1000, status: 'PAID', inspectionRequestId: null },
      { id: 'pay-inspect', type: 'INSPECTOR', amount: 300, status: 'PAID', inspectionRequestId: 'req2' },
    ],
  });
  await cancelOrderInTransaction(tx, { order, actorId: 'buyer1', reason: 'Changed mind', cancelledByRole: 'BUYER' });
  assert.deepEqual(calls.refunds.sort(), ['pay-goods', 'pay-inspect']);
  assert.deepEqual(calls.cancelPayouts.retainInspectionRequestIds, []);
  assert.equal('id' in tx.inspectionRequestUpdate.where, false);                   // everything is cancelled as before
});
