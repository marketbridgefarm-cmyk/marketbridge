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
  expect(paymentService).toContain('buyerLoadingConfirmedAt');
  expect(paymentService).toContain('BUYER_LOADING_CONFIRMATION_REQUIRED');
});

test('transport payment route requires buyer loading approval', () => {
  expect(paymentsRoute).toContain('The buyer must approve the loading report before the transporter can be paid.');
  expect(paymentsRoute).toContain("payment.type === 'TRANSPORT'");
});

test('resuming an old pending transport payment is also gated', () => {
  expect(paymentsRoute).toContain('A transport payment intent may be resumed only after the buyer has');
});

test('cancelled transport can be rearranged and gets a fresh workflow deadline', () => {
  expect(transportRoute).toContain("order.status === 'TRANSPORT_ARRANGED'");
  expect(transportRoute).toContain('computeTransportWorkflowDueAt()');
  expect(transportRoute).toContain('buyerLoadingConfirmedAt: null');
});

test('workflow treats cancelled transport as absent', () => {
  expect(workflow).toContain("order.transportJob?.status === 'CANCELLED' ? null");
});

test('frontend hides transport payment until loading approval', () => {
  expect(orderDetail).toContain('Boolean(transportJob.buyerLoadingConfirmedAt)');
  expect(orderDetail).toContain('Approve the loading report before paying the transporter');
});
