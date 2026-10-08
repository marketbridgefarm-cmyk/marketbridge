const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const timing = fs.readFileSync(path.join(root, 'src/utils/orderTiming.js'), 'utf8');
const maintenance = fs.readFileSync(path.join(root, 'src/services/maintenanceService.js'), 'utf8');
const orders = fs.readFileSync(path.join(root, 'src/routes/orders.js'), 'utf8');
const transport = fs.readFileSync(path.join(root, 'src/routes/transport.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, 'src/services/orderWorkflowService.js'), 'utf8');
const notifications = fs.readFileSync(path.join(root, 'src/services/notificationService.js'), 'utf8');

test('Priority 1 defines 24h buyer, seller-preparation, and loading-approval clocks', () => {
  assert.ok(timing.includes('DEFAULT_BUYER_DECISION_TIMEOUT_HOURS = 24'));
  assert.ok(timing.includes('DEFAULT_SELLER_TRANSPORT_PREPARATION_TIMEOUT_HOURS = 24'));
  assert.ok(timing.includes('DEFAULT_LOADING_APPROVAL_TIMEOUT_HOURS = 24'));
});

test('seller confirmation starts the buyer decision clock', () => {
  assert.ok(transport.includes('buyerDecisionDueAt: computeBuyerDecisionDueAt()'));
});

test('loading report starts the loading approval clock', () => {
  assert.ok(transport.includes('workflowDueAt: computeLoadingApprovalDueAt()'));
});

test('buyer decision clears its deadline', () => {
  assert.ok(orders.includes('buyerDecisionDueAt: null'));
});

test('loading approval clears the transport deadline', () => {
  assert.ok(transport.includes('buyerLoadingConfirmedAt: new Date(), workflowDueAt: null'));
});

test('maintenance expires buyer decision and transport phases', () => {
  assert.ok(maintenance.includes('expireBuyerDecisionWorkflows'));
  assert.ok(maintenance.includes('SELLER_TRANSPORT_PREPARATION_TIMEOUT'));
  assert.ok(maintenance.includes('BUYER_LOADING_APPROVAL_TIMEOUT'));
  assert.ok(maintenance.includes("faultParty = phase === 'SELLER_PREPARATION' ? 'SELLER' : 'BUYER'"));
});

test('workflow does not expose transport payment before loading approval', () => {
  assert.ok(workflow.includes('Boolean(job.buyerLoadingConfirmedAt)'));
  assert.ok(workflow.includes('Approve the loading report before paying the transporter'));
});

test('timeout notifications cover buyer, seller, and transporter', () => {
  assert.ok(notifications.includes('BUYER_DECISION_TIMEOUT'));
  assert.ok(notifications.includes('SELLER_TRANSPORT_PREPARATION_TIMEOUT'));
  assert.ok(notifications.includes('BUYER_LOADING_APPROVAL_TIMEOUT'));
});
