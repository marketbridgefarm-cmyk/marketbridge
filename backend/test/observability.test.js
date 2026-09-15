'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../src/utils/metrics');

test('metrics renderer exposes process and HTTP metrics', () => {
  metrics.inc('marketbridge_http_requests_total', { method: 'GET', route: '/health', status: 200 });
  metrics.observe('marketbridge_http_request_duration_ms', { method: 'GET', route: '/health' }, 12.5);
  const output = metrics.render();
  assert.match(output, /marketbridge_process_uptime_seconds/);
  assert.match(output, /marketbridge_http_requests_total/);
  assert.match(output, /marketbridge_http_request_duration_ms_count/);
  assert.match(output, /marketbridge_http_request_duration_ms_sum/);
});
