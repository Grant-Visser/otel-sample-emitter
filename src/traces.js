// src/traces.js
// Role: Node TracerProvider setup (with OTLP-http span exporter) and a span-tree
// emitter: parent -> child.db.query -> child.http.call, children end before parents.

import { trace, SpanStatusCode, SpanKind, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const REGIONS = ['eu-west', 'us-east', 'af-south'];
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];
const METHODS = ['GET', 'POST'];
const ROUTES = ['/api/orders', '/api/users'];

export function setupTraces({ endpoint, serviceName }) {
  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  const tracer = trace.getTracer('otel-sample-emitter-core', '1.0.0');
  return { provider, tracer };
}

/**
 * Emit one full span tree: parent.operation (SERVER) -> child.db.query (CLIENT)
 * -> child.http.call (CLIENT). Children end before their parents. Durations are
 * small and derived from `i` for deterministic-ish behaviour.
 */
export function emitSpanTree(tracer, i, { serviceNamespace }) {
  const region = REGIONS[i % REGIONS.length];
  const tenant = TENANTS[(i + 1) % TENANTS.length];
  const method = METHODS[i % METHODS.length];
  const route = ROUTES[i % ROUTES.length];
  const attrs = { 'service.namespace': serviceNamespace, region, tenant };

  const parent = tracer.startSpan('parent.operation', {
    kind: SpanKind.SERVER,
    attributes: attrs,
  });
  const parentCtx = trace.setSpan(context.active(), parent);

  const db = tracer.startSpan(
    'child.db.query',
    { kind: SpanKind.CLIENT, attributes: { ...attrs, 'db.system': 'postgresql' } },
    parentCtx,
  );
  const dbCtx = trace.setSpan(parentCtx, db);

  const http = tracer.startSpan(
    'child.http.call',
    { kind: SpanKind.CLIENT, attributes: { ...attrs, 'http.request.method': method, 'url.path': route } },
    dbCtx,
  );

  const dbMs = 2 + (i % 7);
  const httpMs = 5 + ((i * 3) % 20);
  // End in reverse order: grandchild, child, then parent.
  setTimeout(() => http.end(), httpMs);
  setTimeout(() => db.end(), dbMs + httpMs);
  setTimeout(() => {
    parent.setStatus({ code: SpanStatusCode.OK });
    parent.end();
  }, dbMs + httpMs + 2);
}

/** Start the per-second trace loop: spansPerSecond trees per second. */
export function startTraceLoop({ tracer, spansPerSecond, serviceNamespace }) {
  let i = 0;
  const emitBatch = () => {
    for (let k = 0; k < spansPerSecond; k++) emitSpanTree(tracer, i++, { serviceNamespace });
  };
  emitBatch(); // immediate first batch so short runs still emit
  const timer = setInterval(emitBatch, 1000);
  return { stop: () => clearInterval(timer), total: () => i };
}
