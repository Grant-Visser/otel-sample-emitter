// src/logs.js
// Role: OTel Logs SDK setup (LoggerProvider + BatchLogRecordProcessor + OTLP-http
// exporter) and a rate-based structured log emitter with deterministic labels.

import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const REGIONS = ['eu-west', 'us-east', 'af-south'];
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];
const SEVS = [
  { n: SeverityNumber.INFO, s: 'INFO' },
  { n: SeverityNumber.WARN, s: 'WARN' },
  { n: SeverityNumber.ERROR, s: 'ERROR' },
];

export function setupLogs({ endpoint, serviceName }) {
  const exporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    processors: [new BatchLogRecordProcessor(exporter)],
  });
  logs.setGlobalLoggerProvider(provider);
  const logger = logs.getLogger('otel-sample-emitter-core', '1.0.0');
  return { provider, logger };
}

/**
 * Emit one structured log record. `i` is the global iteration number.
 * Severity cycles INFO -> WARN -> ERROR deterministically.
 */
export function emitLog(logger, i, { serviceNamespace }) {
  const region = REGIONS[i % REGIONS.length];
  const tenant = TENANTS[i % TENANTS.length];
  const sev = SEVS[i % SEVS.length];
  const outcomes = { 2: 'completed with errors', 1: 'slow response detected', 0: 'processed successfully' };
  logger.emit({
    severityNumber: sev.n,
    severityText: sev.s,
    body: `iteration ${i}: job ${sev.s.toLowerCase()} - ${outcomes[i % 3]}`,
    attributes: {
      'event.name': 'sample.log',
      'service.namespace': serviceNamespace,
      region,
      tenant,
      environment: 'dev',
      'sample.iteration': i,
    },
  });
}

/** Run the per-second log loop: logsPerSecond emits each second. */
export function startLogLoop({ logger, logsPerSecond, serviceNamespace, onTick }) {
  let globalIter = 0;
  const timer = setInterval(() => {
    for (let k = 0; k < logsPerSecond; k++) {
      emitLog(logger, globalIter++, { serviceNamespace });
    }
    onTick?.();
  }, 1000);
  // Emit the first batch immediately so short runs still produce data.
  for (let k = 0; k < logsPerSecond; k++) {
    emitLog(logger, globalIter++, { serviceNamespace });
  }
  return { stop: () => clearInterval(timer), total: () => globalIter };
}
