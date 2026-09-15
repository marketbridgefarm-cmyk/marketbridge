'use strict';

// Lightweight Prometheus-compatible metrics with no additional runtime
// dependency. Metrics are process-local; aggregate them across instances in
// the monitoring system rather than assuming a single process.

const counters = new Map();
const histograms = new Map();

function labelKey(labels = {}) {
  return Object.keys(labels).sort().map((key) => `${key}=${String(labels[key])}`).join(',');
}

function inc(name, labels = {}, value = 1) {
  const key = `${name}|${labelKey(labels)}`;
  counters.set(key, (counters.get(key) || 0) + Number(value));
}

function observe(name, labels = {}, value) {
  const key = `${name}|${labelKey(labels)}`;
  let metric = histograms.get(key);
  if (!metric) {
    metric = { count: 0, sum: 0 };
    histograms.set(key, metric);
  }
  metric.count += 1;
  metric.sum += Number(value);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function collectHttpMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route?.path || req.path || 'unknown';
    const labels = { method: req.method, route, status: res.statusCode };
    inc('marketbridge_http_requests_total', labels);
    observe('marketbridge_http_request_duration_ms', { method: req.method, route }, durationMs);
  });
  next();
}

function render() {
  const lines = [
    '# HELP marketbridge_process_uptime_seconds Process uptime in seconds.',
    '# TYPE marketbridge_process_uptime_seconds gauge',
    `marketbridge_process_uptime_seconds ${process.uptime()}`,
    '# HELP marketbridge_process_memory_bytes Process memory usage by Node.js.',
    '# TYPE marketbridge_process_memory_bytes gauge',
  ];
  for (const [key, value] of Object.entries(process.memoryUsage())) {
    lines.push(`marketbridge_process_memory_bytes{type="${key}"} ${value}`);
  }

  lines.push('# HELP marketbridge_http_requests_total Total completed HTTP requests.', '# TYPE marketbridge_http_requests_total counter');
  for (const [key, value] of counters) {
    const [name, rawLabels] = key.split('|');
    lines.push(`${name}${rawLabels ? formatLabels(Object.fromEntries(rawLabels.split(',').filter(Boolean).map((pair) => pair.split('=')))) : ''} ${value}`);
  }

  lines.push('# HELP marketbridge_http_request_duration_ms HTTP request duration in milliseconds.', '# TYPE marketbridge_http_request_duration_ms summary');
  for (const [key, metric] of histograms) {
    const [name, rawLabels] = key.split('|');
    const labels = rawLabels ? Object.fromEntries(rawLabels.split(',').filter(Boolean).map((pair) => pair.split('='))) : {};
    lines.push(`${name}_count${formatLabels(labels)} ${metric.count}`);
    lines.push(`${name}_sum${formatLabels(labels)} ${metric.sum}`);
  }

  return `${lines.join('\n')}\n`;
}

function metricsHandler(req, res) {
  const configuredToken = process.env.METRICS_TOKEN;
  if (process.env.NODE_ENV === 'production' && !configuredToken) {
    return res.status(404).end();
  }
  if (configuredToken && req.headers.authorization !== `Bearer ${configuredToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return res.status(200).send(render());
}

module.exports = { inc, observe, collectHttpMetrics, metricsHandler, render };
