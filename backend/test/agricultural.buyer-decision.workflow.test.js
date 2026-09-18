'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOrderWorkflow } = require('../src/services/orderWorkflowService');

function baseOrder(overrides = {}) {
  return {
    id: 'order-1',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    finalPrice: 3100,
    status: 'PENDING_PAYMENT',
    agreedOfferId: 'offer-1',
    agreedAt: new Date('2026-09-17T10:05:00Z'),
    buyerDecision: null,
    buyerDecisionAt: null,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    payments: [],
    paymentObligations: [],
    events: [],
    listing: { category: 'AGRICULTURAL' },
    inspectionRequests: [{
      id: 'inspection-1',
      createdAt: new Date('2026-09-17T10:10:00Z'),
      status: 'COMPLETED',
      requestedById: 'buyer-1',
      inspectorId: 'inspector-1',
      fee: 550,
      report: { id: 'report-1' },
      payments: [{ type: 'INSPECTOR', status: 'PAID' }],
      quotes: [],
    }],
    transportJob: null,
    ...overrides,
  };
}

test('agricultural order waits for explicit buyer decision after inspection report', () => {
  const workflow = computeOrderWorkflow(baseOrder(), 'buyer-1', ['BUYER']);
  assert.equal(workflow.currentStage, 'BUYER_DECISION');
  assert.equal(workflow.buyerDecision, null);

  const buy = workflow.actions.find((a) => a.code === 'BUYER_DECISION_BUY');
  const cancel = workflow.actions.find((a) => a.code === 'BUYER_DECISION_CANCEL');
  const pay = workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE');

  assert.equal(buy.enabled, true);
  assert.equal(cancel.enabled, true);
  assert.equal(pay.enabled, false);
  assert.match(pay.reason, /choose BUY/i);
});

test('agricultural order unlocks seller payment and transport arrangement only after BUY', () => {
  const workflow = computeOrderWorkflow(
    baseOrder({ buyerDecision: 'BUY', buyerDecisionAt: new Date() }),
    'buyer-1',
    ['BUYER']
  );

  assert.equal(workflow.currentStage, 'GOODS_PAYMENT');
  assert.equal(workflow.buyerDecision, 'BUY');
  assert.equal(workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE').enabled, true);
  assert.equal(workflow.actions.find((a) => a.code === 'ARRANGE_TRANSPORT').enabled, false);

  const paid = computeOrderWorkflow(baseOrder({ status: 'CONFIRMED', buyerDecision: 'BUY', buyerDecisionAt: new Date(), payments: [{ type: 'MARKETPLACE', status: 'PAID' }], paymentObligations: [{ type: 'MARKETPLACE', status: 'PAID', amount: 3100 }] }), 'buyer-1', ['BUYER']);
  assert.equal(paid.currentStage, 'ARRANGING_TRANSPORT');
  assert.equal(paid.actions.find((a) => a.code === 'ARRANGE_TRANSPORT').enabled, true);
});

test('agricultural order does not expose BUY decision until inspection report is complete', () => {
  const order = baseOrder({
    inspectionRequests: [{
      id: 'inspection-1',
      createdAt: new Date(),
      status: 'IN_PROGRESS',
      requestedById: 'buyer-1',
      inspectorId: 'inspector-1',
      fee: 550,
      report: null,
      payments: [{ type: 'INSPECTOR', status: 'PAID' }],
      quotes: [],
    }],
  });

  const workflow = computeOrderWorkflow(order, 'buyer-1', ['BUYER']);
  assert.equal(workflow.currentStage, 'INSPECTION');
  assert.equal(workflow.actions.find((a) => a.code === 'BUYER_DECISION_BUY').enabled, false);
});

test('agricultural order follows inspection request, payment, report, decision, goods payment and transport gates', () => {
  const noInspection = computeOrderWorkflow(baseOrder({ inspectionRequests: [] }), 'buyer-1', ['BUYER']);
  assert.equal(noInspection.currentStage, 'INSPECTION_REQUEST');
  assert.equal(noInspection.actions.find(a => a.code === 'REQUEST_INSPECTION').enabled, true);
  assert.equal(noInspection.actions.find(a => a.code === 'BUYER_DECISION_BUY').enabled, false);

  const quoted = computeOrderWorkflow(baseOrder({ inspectionRequests: [{ id: 'i', createdAt: new Date(), status: 'ACCEPTED', requestedById: 'buyer-1', inspectorId: 'inspector-1', fee: 550, report: null, payments: [], quotes: [] }] }), 'buyer-1', ['BUYER']);
  assert.equal(quoted.currentStage, 'INSPECTION_PAYMENT');
  assert.equal(quoted.actions.find(a => a.code === 'PAY_INSPECTION').enabled, true);

  const paidInspection = computeOrderWorkflow(baseOrder({ inspectionRequests: [{ id: 'i', createdAt: new Date(), status: 'IN_PROGRESS', requestedById: 'buyer-1', inspectorId: 'inspector-1', fee: 550, report: null, payments: [{ type: 'INSPECTOR', status: 'PAID' }], quotes: [] }] }), 'buyer-1', ['BUYER']);
  assert.equal(paidInspection.currentStage, 'INSPECTION');
});


test('agricultural BUY action carries the exact server endpoint and never unlocks goods payment early', () => {
  const workflow = computeOrderWorkflow(baseOrder(), 'buyer-1', ['BUYER']);
  const buy = workflow.actions.find((a) => a.code === 'BUYER_DECISION_BUY');
  assert.deepEqual(buy.route, {
    method: 'PATCH',
    path: '/orders/order-1/buyer-decision',
    body: { decision: 'BUY' },
  });
  assert.equal(workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE').enabled, false);
});


test('physical PRODUCT orders use the normal payment workflow and never expose the agricultural BUY decision gate', () => {
  const workflow = computeOrderWorkflow(
    baseOrder({ listing: { category: 'PRODUCT' } }),
    'buyer-1',
    ['BUYER']
  );
  assert.equal(workflow.actions.some((a) => a.code === 'BUYER_DECISION_BUY'), false);
  assert.equal(workflow.actions.some((a) => a.code === 'BUYER_DECISION_CANCEL'), false);
  assert.equal(workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE').enabled, true);
});
