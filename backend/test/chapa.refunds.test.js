'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const chapa = require('../src/config/chapa');

test('Chapa refund submission uses the original tx_ref and form-urlencoded body', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.CHAPA_SECRET_KEY;
  process.env.CHAPA_SECRET_KEY = 'CHASECK_TEST-refund-test';

  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      status: 'success',
      data: { ref_id: 'REF-123', status: 'initiated' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await chapa.refundTransaction({
      txRef: 'payment-123_1727000000000',
      amount: 1250,
      reason: 'Order cancellation',
      reference: 'MB-REFUND-refund-123',
      meta: { marketbridge_refund_id: 'refund-123' },
    });

    assert.equal(result.refId, 'REF-123');
    assert.equal(result.status, 'initiated');
    assert.match(captured.url, /\/v1\/refund\/payment-123_1727000000000$/);
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const body = new URLSearchParams(captured.options.body);
    assert.equal(body.get('amount'), '1250.00');
    assert.equal(body.get('reason'), 'Order cancellation');
    assert.equal(body.get('reference'), 'MB-REFUND-refund-123');
    assert.equal(body.get('meta[marketbridge_refund_id]'), 'refund-123');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CHAPA_SECRET_KEY;
    else process.env.CHAPA_SECRET_KEY = originalKey;
  }
});

test('Chapa refund verification normalizes asynchronous states', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.CHAPA_SECRET_KEY;
  process.env.CHAPA_SECRET_KEY = 'CHASECK_TEST-refund-test';

  const responses = ['initiated', 'processing', 'refunded', 'reversed'];
  let index = 0;
  global.fetch = async () => new Response(JSON.stringify({
    status: 'success',
    data: { ref_id: 'REF-123', status: responses[index++] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    assert.equal((await chapa.verifyRefund('REF-123')).status, 'processing');
    assert.equal((await chapa.verifyRefund('REF-123')).status, 'processing');
    assert.equal((await chapa.verifyRefund('REF-123')).status, 'refunded');
    assert.equal((await chapa.verifyRefund('REF-123')).status, 'reversed');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CHAPA_SECRET_KEY;
    else process.env.CHAPA_SECRET_KEY = originalKey;
  }
});
