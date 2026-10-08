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
    listing: { category: 'AGRICULTURAL', inspectionRequired: true },
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

const preparedJob = (overrides = {}) => ({
  id: 'job-1',
  status: 'ACCEPTED',
  method: 'HIRE_TRANSPORTER',
  agreedAmount: 400,
  truckOwnerId: 'truck-1',
  sellerPickupConfirmedAt: new Date('2026-09-18T08:00:00Z'),
  buyerLoadingConfirmedAt: null,
  loadingReport: null,
  quotes: [],
  ...overrides,
});

test('after the inspection report the buyer may cancel or arrange transport, but BUY is not yet available', () => {
  const workflow = computeOrderWorkflow(baseOrder(), 'buyer-1', ['BUYER']);
  assert.equal(workflow.currentStage, 'ARRANGING_TRANSPORT');
  assert.equal(workflow.buyerDecision, null);

  const buy = workflow.actions.find((a) => a.code === 'BUYER_DECISION_BUY');
  const cancel = workflow.actions.find((a) => a.code === 'BUYER_DECISION_CANCEL');
  const pay = workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE');

  assert.equal(buy.enabled, false);
  assert.match(buy.reason, /transporter/i);
  assert.equal(cancel.enabled, true);
  assert.equal(pay.enabled, false);
});

test('final BUY unlocks only after the seller confirms transporter preparation, then goods payment, then transport payment', () => {
  const unprepared = computeOrderWorkflow(baseOrder({ transportJob: preparedJob({ sellerPickupConfirmedAt: null }) }), 'buyer-1', ['BUYER']);
  assert.equal(unprepared.currentStage, 'TRANSPORT_PREPARATION_CONFIRMATION');
  assert.equal(unprepared.actions.find((a) => a.code === 'BUYER_DECISION_BUY').enabled, false);

  const ready = computeOrderWorkflow(baseOrder({ transportJob: preparedJob() }), 'buyer-1', ['BUYER']);
  assert.equal(ready.currentStage, 'BUYER_DECISION');
  assert.equal(ready.actions.find((a) => a.code === 'BUYER_DECISION_BUY').enabled, true);

  const bought = computeOrderWorkflow(
    baseOrder({ transportJob: preparedJob(), buyerDecision: 'BUY', buyerDecisionAt: new Date() }),
    'buyer-1',
    ['BUYER']
  );
  assert.equal(bought.currentStage, 'GOODS_PAYMENT');
  assert.equal(bought.actions.find((a) => a.code === 'PAY_MARKETPLACE').enabled, true);
  const transportPay = bought.actions.find((a) => a.code === 'PAY_TRANSPORT');
  if (transportPay) assert.equal(transportPay.enabled, false);
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
  assert.equal(quoted.currentStage, 'INSPECTION_SELLER_CONFIRMATION');
  assert.equal(quoted.actions.find(a => a.code === 'PAY_INSPECTION').enabled, false);
  assert.equal(quoted.actions.find(a => a.code === 'CONFIRM_INSPECTION').enabled, false);

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


test('agricultural order exposes seller confirmation before inspection payment', () => {
  const workflow = computeOrderWorkflow(
    baseOrder({
      inspectionRequests: [{
        id: 'inspection-1',
        createdAt: new Date(),
        status: 'ACCEPTED',
        requestedById: 'buyer-1',
        inspectorId: 'inspector-1',
        fee: 550,
        sellerConfirmedAt: null,
        report: null,
        payments: [],
        quotes: [],
      }],
    }),
    'seller-1',
    ['SELLER']
  );

  assert.equal(workflow.currentStage, 'INSPECTION_SELLER_CONFIRMATION');
  assert.equal(workflow.actions.find((a) => a.code === 'PAY_INSPECTION').enabled, false);
  assert.equal(workflow.actions.find((a) => a.code === 'CONFIRM_INSPECTION').enabled, true);
});

test('confirmed agricultural inspector unlocks only the designated inspection payer', () => {
  const obligations = [{
    id: 'ob-1', type: 'INSPECTOR', inspectionRequestId: 'inspection-1',
    payerId: 'buyer-1', amount: 275, status: 'OPEN', payment: null,
  }];
  const workflow = computeOrderWorkflow(
    baseOrder({
      paymentObligations: obligations,
      inspectionRequests: [{
        id: 'inspection-1', createdAt: new Date(), status: 'ACCEPTED',
        requestedById: 'buyer-1', inspectorId: 'inspector-1', fee: 550,
        sellerConfirmedAt: new Date(), report: null, payments: [], quotes: [],
      }],
    }),
    'buyer-1',
    ['BUYER']
  );

  assert.equal(workflow.currentStage, 'INSPECTION_PAYMENT');
  const pay = workflow.actions.find((a) => a.code === 'PAY_INSPECTION');
  assert.equal(pay.enabled, true);
  assert.equal(pay.route.body.amount, 275);
});

test('physical PRODUCT orders use the normal payment workflow and never expose the agricultural BUY decision gate', () => {
  const workflow = computeOrderWorkflow(
    baseOrder({ listing: { category: 'PRODUCT' }, inspectionRequests: [] }),
    'buyer-1',
    ['BUYER']
  );
  assert.equal(workflow.actions.some((a) => a.code === 'BUYER_DECISION_BUY'), false);
  assert.equal(workflow.actions.some((a) => a.code === 'BUYER_DECISION_CANCEL'), false);
  assert.equal(workflow.actions.find((a) => a.code === 'PAY_MARKETPLACE').enabled, true);
});


test('provisional inspector agreement exposes seller confirmation as the next commercial gate', () => {
  const workflow = computeOrderWorkflow(
    baseOrder({
      inspectionRequests: [{
        id: 'i-confirm',
        createdAt: new Date(),
        status: 'ACCEPTED',
        requestedById: 'buyer-1',
        inspectorId: 'inspector-1',
        fee: 550,
        sellerConfirmedAt: null,
        report: null,
        payments: [],
        quotes: [],
      }],
    }),
    'seller-1',
    ['SELLER']
  );

  assert.equal(workflow.currentStage, 'INSPECTION_SELLER_CONFIRMATION');
  assert.equal(workflow.actions.find(a => a.code === 'PAY_INSPECTION').enabled, false);
  assert.match(workflow.actions.find(a => a.code === 'PAY_INSPECTION').reason, /seller must confirm/i);
});

test('seller sees both confirm and decline for a provisional inspection, buyer sees neither as performable', () => {
  const order = baseOrder({ inspectionRequests: [{ id: 'i', createdAt: new Date(), status: 'ACCEPTED', requestedById: 'buyer-1', inspectorId: 'inspector-1', fee: 550, report: null, payments: [], quotes: [], workflowDueAt: new Date(Date.now() + 3600e3) }] });
  const seller = computeOrderWorkflow(order, 'seller-1', ['SELLER']);
  assert.equal(seller.actions.find((a) => a.code === 'CONFIRM_INSPECTION').enabled, true);
  const decline = seller.actions.find((a) => a.code === 'DECLINE_INSPECTION');
  assert.equal(decline.enabled, true);
  assert.equal(decline.route.path, '/inspections/i/seller-decline');
  const buyer = computeOrderWorkflow(order, 'buyer-1', ['BUYER']);
  assert.equal(buyer.actions.find((a) => a.code === 'DECLINE_INSPECTION').enabled, false);
});
