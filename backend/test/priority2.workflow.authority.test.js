'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('inspection terms have an explicit immutable payment snapshot', () => {
  const schema = read('prisma/schema.prisma');
  const route = read('src/routes/inspections.js');
  const obligations = read('src/services/paymentObligationService.js');
  for (const field of ['feeTermsLockedAt', 'lockedFee', 'lockedFeePayer', 'lockedBuyerFeeAmount', 'lockedSellerFeeAmount']) {
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  }
  assert.match(route, /feeTermsLockedAt: now/);
  assert.match(route, /lockedFee: request\.fee/);
  assert.match(route, /lockedFeePayer: request\.feePayer/);
  assert.match(obligations, /r\.feeTermsLockedAt && r\.lockedFee/);
  assert.match(obligations, /r\.feeTermsLockedAt && r\.lockedFeePayer/);
});

test('transport payment readiness requires buyer loading approval in both server and UI', () => {
  const workflow = read('src/services/orderWorkflowService.js');
  const ui = fs.readFileSync(path.join(root, '../frontend/src/pages/OrderDetail.jsx'), 'utf8');
  assert.match(workflow, /payments\.marketplace\.paid && order\.buyerDecision === 'BUY' && Boolean\(job\.buyerLoadingConfirmedAt\)/);
  assert.match(ui, /order\?\.buyerDecision === 'BUY' && marketplacePaid && Boolean\(transportJob\.buyerLoadingConfirmedAt\)/);
});

test('workflow actions declare server authority and deadlines', () => {
  const workflow = read('src/services/orderWorkflowService.js');
  assert.match(workflow, /authority: 'SERVER_WORKFLOW'/);
  assert.match(workflow, /deadlineAt: order\.buyerDecisionDueAt \|\| null/);
  assert.match(workflow, /code: 'CONFIRM_TRANSPORT_PREPARATION'/);
  assert.match(workflow, /deadlineAt: job\.sellerPreparationDueAt \|\| job\.workflowDueAt \|\| null/);
});

test('priority 2 migration creates the inspection terms lock snapshot', () => {
  const migration = read('prisma/migrations/202610080003_priority2_inspection_terms_lock/migration.sql');
  assert.match(migration, /ADD COLUMN "feeTermsLockedAt"/);
  assert.match(migration, /ADD COLUMN "lockedFee"/);
  assert.match(migration, /ADD COLUMN "lockedFeePayer"/);
  assert.match(migration, /WHERE "sellerConfirmedAt" IS NOT NULL/);
});

test('timeout metadata uses the standardized workflow envelope', () => {
  const helper = read('src/services/workflowEventService.js');
  const maintenance = read('src/services/maintenanceService.js');
  const lapse = read('src/services/inspectionLapseService.js');
  assert.match(helper, /eventVersion: 1/);
  assert.match(helper, /workflowPhase/);
  assert.match(helper, /faultParty/);
  assert.match(helper, /consequence/);
  assert.match(maintenance, /recordWorkflowTimeout/);
  assert.match(lapse, /eventVersion: 1/);
  assert.match(lapse, /faultParty:/);
});
