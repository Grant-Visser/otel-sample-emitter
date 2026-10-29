// src/metrics.js
// Role: OTel Metrics SDK setup (MeterProvider + PeriodicExportingMetricReader +
// OTLP-http exporter) and the three sample instruments driven by METRIC_INTERVAL_MS.

import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const REGIONS = ['eu-west', 'us-east', 'af-south'];
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];
const ROUTES = ['/api/orders', '/api/users', '/api/health'];

export function setupMetrics({ endpoint, metricIntervalMs, serviceName }) {
  const exporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: metricIntervalMs,
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    readers: [reader],
  });
  metrics.setGlobalMeterProvider(provider);
  const meter = metrics.getMeter('otel-sample-emitter-core', '1.0.0');

  const eventsProcessed = meter.createCounter('app.events.processed', {
    description: 'Number of sample events processed',
  });
  const requestDuration = meter.createHistogram('app.request.duration', {
    description: 'Sample request duration in ms',
    unit: 'ms',
  });
  let queueDepth = 0;
  const queueDepthGauge = meter.createObservableGauge('app.queue.depth', {
    description: 'Sample background queue depth',
  });
  queueDepthGauge.addCallback((obs) => obs.observe(queueDepth));

  return {
    provider,
    /**
     * One metric "tick": counter + histogram samples across region/tenant/outcome,
     * and a small deterministic-ish queue depth change for the gauge.
     */
    tick(i) {
      for (let r = 0; r < REGIONS.length; r++) {
        for (let t = 0; t < TENANTS.length; t++) {
          const outcome = (i + r + t) % 7 === 0 ? 'failure' : 'success';
          eventsProcessed.add(1, {
            region: REGIONS[r],
            tenant: TENANTS[t],
            outcome,
          });
          requestDuration.record(
            10 + ((i * 13 + r * 7 + t * 3) % 90),
            { region: REGIONS[r], tenant: TENANTS[t], route: ROUTES[(i + r) % ROUTES.length] },
          );
        }
      }
      queueDepth = Math.max(0, queueDepth + ((i % 2 === 0 ? 1 : -1) * (1 + (i % 3))));
    },
  };
}
