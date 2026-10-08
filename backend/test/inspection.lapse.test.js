'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// The lapse service depends on modules that live elsewhere in the project.
// Stub just those so the closing logic can be tested in isolation.
const calls = [];
const stubs = {
  '../utils/audit': { recordAuditEvent: async (_tx, e) => calls.push(['audit', e.action]) },
  './orderEventService': { recordOrderEvent: async (_tx, e) => calls.push(['orderEvent', e.type]) },
  './orderCancellationService': { cancelOrderInTransaction: async (_tx, a) => calls.push(['cancelOrder', a.cancelledByRole, a.reason]) },
  './inspectionCoordinationService': { closeCoordination: async (_tx, id, why) => calls.push(['closeCoordination', id, why]) },
};
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && /inspectionLapseService\.js$/.test(parent.filename) && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};
const { lapseInspectionAgreement } = require('../src/services/inspectionLapseService');
Module._load = originalLoad;

function fakeTx({ payments = [], order } = {}) {
  const updates = [];
  return {
    updates,
    inspectionRequest: {
      findUnique: async () => ({ id: 'insp-1', orderId: 'order-1', status: 'ACCEPTED', payments }),
      update: async (a) => updates.push(['inspectionRequest', a.data.status]),
    },
    inspectionQuote: { updateMany: async () => updates.push(['quotes', 'EXPIRED']) },
    paymentObligation: { updateMany: async (a) => updates.push(['obligations', a.data.status]) },
    order: { findUnique: async () => order },
    offerNotification: { create: async (a) => updates.push(['notice', a.data.userId, a.data.type]) },
  };
}

const openOrder = { id: 'order-1', buyerId: 'buyer-1', listingId: 'l1', agreedOfferId: 'o1', status: 'PENDING_PAYMENT', buyerDecision: null, payments: [] };

test('lapse closes the agreement, the order, coordination and notifies the buyer', async () => {
  calls.length = 0;
  const tx = fakeTx({ order: openOrder });
  const out = await lapseInspectionAgreement(tx, { inspectionRequestId: 'insp-1', code: 'SELLER_CONFIRMATION_EXPIRED' });
  assert.equal(out.lapsed, true);
  assert.deepEqual(tx.updates.map((u) => u.join(':')), ['inspectionRequest:CANCELLED', 'quotes:EXPIRED', 'obligations:CANCELLED', 'notice:buyer-1:ORDER_CLOSED']);
  assert.ok(calls.some((c) => c[0] === 'closeCoordination'));
  assert.ok(calls.some((c) => c[0] === 'cancelOrder' && c[1] === 'SYSTEM'));
});

test('seller decline cancels the order as SELLER', async () => {
  calls.length = 0;
  const tx = fakeTx({ order: openOrder });
  await lapseInspectionAgreement(tx, { inspectionRequestId: 'insp-1', code: 'SELLER_DECLINED', actorId: 'seller-1', actorRole: 'SELLER' });
  assert.ok(calls.some((c) => c[0] === 'cancelOrder' && c[1] === 'SELLER'));
});

test('lapse never cancels when inspection money has been paid', async () => {
  calls.length = 0;
  const tx = fakeTx({ order: openOrder, payments: [{ id: 'p1', type: 'INSPECTOR', status: 'PAID' }] });
  const out = await lapseInspectionAgreement(tx, { inspectionRequestId: 'insp-1', code: 'INSPECTION_PAYMENT_EXPIRED' });
  assert.deepEqual(out, { lapsed: false, skipped: 'PAYMENT_IN_FLIGHT' });
  assert.equal(tx.updates.length, 0);
  assert.equal(calls.length, 0);
});

test('lapse leaves an order alone once the buyer has decided or paid for goods', async () => {
  calls.length = 0;
  const tx = fakeTx({ order: { ...openOrder, buyerDecision: 'BUY' } });
  await lapseInspectionAgreement(tx, { inspectionRequestId: 'insp-1', code: 'INSPECTION_PAYMENT_EXPIRED' });
  assert.ok(!calls.some((c) => c[0] === 'cancelOrder'));
});
