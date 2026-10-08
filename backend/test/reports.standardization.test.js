'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
const inspectionRoute = fs.readFileSync(path.join(root, 'src/routes/inspections.js'), 'utf8');
const transportRoute = fs.readFileSync(path.join(root, 'src/routes/transport.js'), 'utf8');
const ordersRoute = fs.readFileSync(path.join(root, 'src/routes/orders.js'), 'utf8');
const maintenance = fs.readFileSync(path.join(root, 'src/services/maintenanceService.js'), 'utf8');

test('both reports use the same buyer review lifecycle contract', () => {
  assert.match(schema, /enum BuyerReportReviewStatus \{[\s\S]*?PENDING[\s\S]*?ACCEPTED[\s\S]*?DECLINED[\s\S]*?\}/);
  for (const model of ['InspectionReport', 'TransportLoadingReport']) {
    const start = schema.indexOf(`model ${model}`);
    assert.notEqual(start, -1, model);
    const block = schema.slice(start, schema.indexOf('\n}', start) + 2);
    for (const field of ['reportVersion', 'submittedAt', 'buyerReviewStatus', 'buyerReviewedAt', 'buyerReviewedById', 'buyerReviewNotes']) {
      assert.match(block, new RegExp(`\\b${field}\\b`), `${model}.${field}`);
    }
  }
});

test('inspection report exposes the common report envelope and records buyer review', () => {
  assert.match(inspectionRoute, /buildBuyerReportEnvelope\(report, 'INSPECTION'\)/);
  assert.match(ordersRoute, /buyerReviewStatus: 'ACCEPTED'/);
  assert.match(ordersRoute, /buyerReviewStatus: 'DECLINED'/);
});

test('loading report exposes the common report envelope and records buyer approval', () => {
  assert.match(transportRoute, /buildBuyerReportEnvelope\(report, 'TRANSPORT_LOADING'\)/);
  assert.match(transportRoute, /buyerReviewStatus: 'ACCEPTED'/);
});

test('loading approval timeout declines the pending loading report', () => {
  assert.match(maintenance, /buyerReviewStatus: 'DECLINED'/);
  assert.match(maintenance, /Buyer loading-approval deadline expired/);
});
