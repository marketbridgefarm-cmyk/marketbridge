'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Financial integration tests are opt-in because they require disposable PostgreSQL.
const enabled = process.env.MARKETBRIDGE_E2E === '1' && process.env.E2E_DATABASE_URL;

test('financial hardening suite is explicitly opt-in', { skip: !enabled }, async () => {
  assert.ok(process.env.E2E_DATABASE_URL);
});
