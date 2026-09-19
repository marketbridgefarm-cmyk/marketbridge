'use strict';

/**
 * POST /api/growth/telegram-promo broadcasts to MarketBridge's public
 * Telegram channel with the platform bot token, so it must be staff-only.
 * It previously only required a signed-in user.
 *
 * This inspects the real router's middleware chain (no database, network or
 * Telegram call). It needs the app's normal dependencies (express, prisma
 * client), so it skips itself if they are not installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let router = null;
let loadError = null;
try {
  router = require('../src/routes/growth');
} catch (error) {
  loadError = error;
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// Runs the layer that sits immediately after `authenticate` with a given
// authenticated user, and reports what it did.
function runRoleGate(handlers, user) {
  const res = mockRes();
  let nextCalled = false;
  handlers[1]({ user }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('POST /telegram-promo is admin-only and the role gate runs right after authenticate', { skip: loadError ? `dependencies unavailable: ${loadError.code || loadError.message}` : false }, () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/telegram-promo' && l.route.methods.post);
  assert.ok(layer, 'route must exist');
  const handlers = layer.route.stack.map((l) => l.handle);
  assert.ok(handlers.length >= 3, 'authenticate + role gate + handler');

  for (const roles of [['BUYER'], ['SELLER'], ['BUYER', 'SELLER', 'TRUCK_OWNER'], []]) {
    const { res, nextCalled } = runRoleGate(handlers, { id: 'u1', roles });
    assert.equal(nextCalled, false, `roles ${JSON.stringify(roles)} must not pass`);
    assert.equal(res.statusCode, 403);
  }

  const admin = runRoleGate(handlers, { id: 'a1', roles: ['ADMIN'] });
  assert.equal(admin.nextCalled, true, 'ADMIN must pass the gate');
  assert.equal(admin.res.statusCode, null);
});
