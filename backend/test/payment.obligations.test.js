'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncOrderPaymentObligations } = require('../src/services/paymentObligationService');

// Minimal in-memory transaction covering exactly what the sync touches.
function fakeTx(order, obligations) {
  const matches = (o, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(o[k]);
    if (v && typeof v === 'object' && 'notIn' in v) return !v.notIn.includes(o[k]);
    return o[k] === v;
  });
  return {
    obligations,
    order: { findUnique: async () => order },
    payment: { update: async () => ({}) },
    paymentObligation: {
      findUnique: async ({ where }) => obligations.find((o) => o.obligationKey === where.obligationKey) || null,
      create: async ({ data }) => { const row = { id: `ob-${obligations.length + 1}`, ...data }; obligations.push(row); return row; },
      update: async ({ where, data }) => { const row = obligations.find((o) => o.id === where.id); Object.assign(row, data); return row; },
      updateMany: async ({ where, data }) => { const rows = obligations.filter((o) => matches(o, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
    },
  };
}

function orderWith(inspection) {
  return {
    id: 'order-1', buyerId: 'buyer-1', sellerId: 'seller-1', finalPrice: 3100,
    payments: [], transportJob: null,
    inspectionRequests: [{ id: 'insp-1', status: 'ACCEPTED', inspectorId: 'insp-user', fee: 500, mode: 'BUYER_REQUESTED', payments: [], sellerConfirmedAt: new Date(), ...inspection }],
  };
}

const inspectorObligations = (tx) => tx.obligations.filter((o) => o.type === 'INSPECTOR');

test('changing the fee payer from BUYER to SPLIT retires the old full-amount obligation', async () => {
  const obligations = [];
  await syncOrderPaymentObligations(fakeTx(orderWith({ feePayer: 'BUYER' }), obligations), 'order-1');
  assert.equal(inspectorObligations({ obligations }).filter((o) => o.status === 'OPEN').length, 1);
  assert.equal(inspectorObligations({ obligations })[0].amount, 500);

  await syncOrderPaymentObligations(fakeTx(orderWith({ feePayer: 'SPLIT' }), obligations), 'order-1');
  const open = inspectorObligations({ obligations }).filter((o) => o.status === 'OPEN');
  assert.equal(open.length, 2);
  assert.equal(open.reduce((sum, o) => sum + Number(o.amount), 0), 500);
  const old = obligations.find((o) => o.obligationKey === 'ORDER:order-1:INSPECTOR:insp-1');
  assert.equal(old.status, 'CANCELLED');
});

test('PAID inspection obligations are never cancelled by the cleanup', async () => {
  const obligations = [{ id: 'ob-x', orderId: 'order-1', type: 'INSPECTOR', status: 'PAID', obligationKey: 'ORDER:order-1:INSPECTOR:legacy' }];
  await syncOrderPaymentObligations(fakeTx(orderWith({ feePayer: 'BUYER' }), obligations), 'order-1');
  assert.equal(obligations.find((o) => o.id === 'ob-x').status, 'PAID');
});

test('an OPEN obligation of a cancelled inspection request is retired', async () => {
  const obligations = [];
  await syncOrderPaymentObligations(fakeTx(orderWith({ feePayer: 'BUYER' }), obligations), 'order-1');
  const cancelledOrder = { ...orderWith({}), inspectionRequests: [] }; // cancelled requests are excluded by the query
  await syncOrderPaymentObligations(fakeTx(cancelledOrder, obligations), 'order-1');
  assert.equal(inspectorObligations({ obligations })[0].status, 'CANCELLED');
});
