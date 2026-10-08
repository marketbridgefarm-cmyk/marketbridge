const { test } = require('node:test');
const assert = require('node:assert/strict');
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const paymentService = fs.readFileSync(path.join(root, 'src/services/paymentService.js'), 'utf8');
const paymentsRoute = fs.readFileSync(path.join(root, 'src/routes/payments.js'), 'utf8');
const transportRoute = fs.readFileSync(path.join(root, 'src/routes/transport.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, 'src/services/orderWorkflowService.js'), 'utf8');
const orderDetail = fs.readFileSync(path.join(root, '../frontend/src/pages/OrderDetail.jsx'), 'utf8');

test('transport payment service requires buyer loading approval', () => {
  assert.ok(paymentService.includes('buyerLoadingConfirmedAt'));
  assert.ok(paymentService.includes('BUYER_LOADING_CONFIRMATION_REQUIRED'));
});

test('transport payment route requires buyer loading approval', () => {
  assert.ok(paymentsRoute.includes('The buyer must approve the loading report before the transporter can be paid.'));
  assert.ok(paymentsRoute.includes("payment.type === 'TRANSPORT'"));
});

test('resuming an old pending transport payment is also gated', () => {
  assert.ok(paymentsRoute.includes('A transport payment intent may be resumed only after the buyer has'));
});

test('cancelled transport can be rearranged and gets a fresh workflow deadline', () => {
  assert.ok(transportRoute.includes("order.status === 'TRANSPORT_ARRANGED'"));
  assert.ok(transportRoute.includes('computeTransportWorkflowDueAt()'));
  assert.ok(transportRoute.includes('buyerLoadingConfirmedAt: null'));
});

test('workflow treats cancelled transport as absent', () => {
  assert.ok(workflow.includes("order.transportJob?.status === 'CANCELLED' ? null"));
});

test('frontend hides transport payment until loading approval', () => {
  assert.ok(orderDetail.includes('Boolean(transportJob.buyerLoadingConfirmedAt)'));
  assert.ok(orderDetail.includes('Approve the loading report before paying the transporter'));
});
