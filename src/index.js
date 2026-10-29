// src/index.js
// Role: entry point. Loads config, sets up the three OTel signal providers,
// runs the emit loops for EMIT_DURATION_SECONDS, then flushes and shuts down
// everything cleanly (including on SIGINT/SIGTERM).

import { loadConfig } from './config.js';
import { setupLogs, startLogLoop } from './logs.js';
import { setupMetrics } from './metrics.js';
import { setupTraces, startTraceLoop } from './traces.js';

async function main() {
  const cfg = loadConfig();

  console.log(
    `[config] endpoint=${cfg.endpoint} service=${cfg.serviceName} namespace=${cfg.serviceNamespace} ` +
      `window=${cfg.durationSeconds}s logs/s=${cfg.logsPerSecond} spans/s=${cfg.spansPerSecond} ` +
      `metricInterval=${cfg.metricIntervalMs}ms`,
  );

  const logsApi = setupLogs({ endpoint: cfg.endpoint, serviceName: cfg.serviceName });
  const metricsApi = setupMetrics({ endpoint: cfg.endpoint, metricIntervalMs: cfg.metricIntervalMs, serviceName: cfg.serviceName });
  const tracesApi = setupTraces({ endpoint: cfg.endpoint, serviceName: cfg.serviceName });

  const logLoop = startLogLoop({
    logger: logsApi.logger,
    logsPerSecond: cfg.logsPerSecond,
    serviceNamespace: cfg.serviceNamespace,
  });
  const traceLoop = startTraceLoop({
    tracer: tracesApi.tracer,
    spansPerSecond: cfg.spansPerSecond,
    serviceNamespace: cfg.serviceNamespace,
  });

  let metricTicks = 0;
  const metricTimer = setInterval(() => {
    metricsApi.tick(metricTicks++);
  }, cfg.metricIntervalMs);
  metricsApi.tick(metricTicks++); // immediate first tick

  // Graceful shutdown: stop loops, flush providers, shut down exporters.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal ?? 'window complete'} — stopping loops`);
    clearInterval(logLoop.timerHandle ?? undefined);
    logLoop.stop();
    traceLoop.stop();
    clearInterval(metricTimer);
    // Let in-flight span trees finish: children/parents end via setTimeout up to
    // ~30ms after start, so give them a brief drain before flushing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await metricsApi.provider.forceFlush();
      await logsApi.provider.forceFlush();
      await tracesApi.provider.forceFlush();
      await metricsApi.provider.shutdown();
      await logsApi.provider.shutdown();
      await tracesApi.provider.shutdown();
      console.log('shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] error during flush/shutdown:', err);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Progress line once per second during the window.
  let second = 0;
  const progress = setInterval(() => {
    second++;
    console.log(`[progress] ${second}/${cfg.durationSeconds}s logs=${logLoop.total()} spans=${traceLoop.total()}`);
    if (second >= cfg.durationSeconds) {
      clearInterval(progress);
      void shutdown('window complete');
    }
  }, 1000);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
