// src/config.js
// Role: parse & validate all env vars with sensible defaults.
// Exits with a clear message on any invalid value.

const NUM_RE = /^\d+$/;

/** Parse a non-negative integer env var; returns { ok, value?, error? } */
function numInt(name, def, min) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return { ok: true, value: def };
  if (!NUM_RE.test(raw)) {
    return { ok: false, error: `${name} must be a non-negative integer, got: "${raw}"` };
  }
  const v = Number(raw);
  if (!Number.isSafeInteger(v)) {
    return { ok: false, error: `${name} is out of safe integer range: "${raw}"` };
  }
  if (v < min) {
    return { ok: false, error: `${name} must be >= ${min}, got: ${v}` };
  }
  return { ok: true, value: v };
}

export function loadConfig() {
  const errors = [];
  const vals = {};

  // Endpoint (standard OTEL var; exporter also honours it, we read it for the summary)
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim() || 'http://localhost:4318';
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    errors.push(`OTEL_EXPORTER_OTLP_ENDPOINT must be a valid http(s) URL, got: "${endpoint}"`);
  }
  vals.endpoint = endpoint;

  const svc = (process.env.OTEL_SERVICE_NAME ?? '').trim() || 'otel-sample-emitter';
  vals.serviceName = svc;

  for (const [name, def, min, key] of [
    ['EMIT_DURATION_SECONDS', 60, 1, 'durationSeconds'],
    ['LOGS_PER_SECOND', 5, 0, 'logsPerSecond'],
    ['SPANS_PER_SECOND', 2, 0, 'spansPerSecond'],
  ]) {
    const r = numInt(name, def, min);
    if (r.ok) vals[key] = r.value;
    else errors.push(r.error);
  }

  const mi = numInt('METRIC_INTERVAL_MS', 5000, 1);
  if (mi.ok) vals.metricIntervalMs = mi.value;
  else errors.push(mi.error);

  vals.serviceNamespace = (process.env.SERVICE_NAMESPACE ?? '').trim() || 'demo';

  if (errors.length) {
    console.error('Configuration error(s):');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  return vals;
}
