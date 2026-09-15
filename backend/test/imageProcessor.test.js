'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasValidImageSignature, isImageMime, MAX_INPUT_PIXELS } = require('../src/utils/imageProcessor');

test('image processor recognizes supported image MIME types', () => {
  assert.equal(isImageMime('image/jpeg'), true);
  assert.equal(isImageMime('image/png'), true);
  assert.equal(isImageMime('image/webp'), true);
  assert.equal(isImageMime('image/heic'), true);
  assert.equal(isImageMime('text/html'), false);
});

test('image processor rejects fake signatures', () => {
  assert.equal(hasValidImageSignature(Buffer.from('not an image'), 'image/png'), false);
  assert.equal(hasValidImageSignature(Buffer.from('not an image'), 'image/jpeg'), false);
  assert.equal(MAX_INPUT_PIXELS > 0, true);
});

test('image processor accepts a valid PNG signature', () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.equal(hasValidImageSignature(png, 'image/png'), true);
});
