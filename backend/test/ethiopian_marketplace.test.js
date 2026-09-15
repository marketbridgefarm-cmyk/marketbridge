const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm } = require('../src/utils/geo');

test('geographic distance is zero for identical coordinates', () => assert.equal(haversineKm(9.03, 38.74, 9.03, 38.74), 0));
test('geographic distance increases with separation', () => assert.ok(haversineKm(9.03, 38.74, 9.1, 38.8) > haversineKm(9.03, 38.74, 9.04, 38.75)));
