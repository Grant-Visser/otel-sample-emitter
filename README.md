# otel-sample-emitter

A small Node.js 26 app that emits OpenTelemetry telemetry (logs, metrics, and traces) over OTLP/HTTP at controlled, configurable rates for a fixed time window.

It exists for one purpose: testing a downstream OpenTelemetry Collector (or any OTLP-capable receiver) with a known amount of labelled telemetry. You choose the rates and the window length, run the app once, and then verify that the receiver saw exactly what you expected.

## Prerequisites

- Node.js >= 26
- An OTLP/HTTP receiver reachable at the configured endpoint (a local OpenTelemetry Collector on `:4318`, or the throwaway sink shown under [Verifying output](#verifying-output))

## Quickstart

```bash
cd otel-sample-emitter
npm install
node src/index.js
```

With no environment variables set, the app:

- exports OTLP/HTTP to `http://localhost:4318` (paths `/v1/logs`, `/v1/metrics`, `/v1/traces`)
- runs for 60 seconds
- emits 5 log records per second
- starts 2 traces per second (each trace is a tree of 3 spans)
- emits one point for each of its 3 metrics every 5 seconds
- then shuts down and flushes.

Run with custom rates and window length:

```bash
EMIT_DURATION_SECONDS=120 LOGS_PER_SECOND=10 SPANS_PER_SECOND=4 METRIC_INTERVAL_MS=2000 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
node src/index.js
```

Point it at a different receiver by changing the endpoint:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector-host:4318 node src/index.js
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base OTLP/HTTP endpoint. The app posts to `<endpoint>/v1/logs`, `/v1/metrics`, and `/v1/traces`. |
| `OTEL_SERVICE_NAME` | `otel-sample-emitter` | Value of the `service.name` resource attribute on all signals. |
| `EMIT_DURATION_SECONDS` | `60` | How long the app emits before shutting down. The window starts immediately on launch. |
| `LOGS_PER_SECOND` | `5` | Log records emitted per second during the window. |
| `SPANS_PER_SECOND` | `2` | Traces started per second during the window. Each trace produces a tree of 3 spans (see [Traces](#traces)). |
| `METRIC_INTERVAL_MS` | `5000` | Interval, in milliseconds, between metric emission ticks. Each tick emits one point per metric (3 metrics). |
| `SERVICE_NAMESPACE` | `demo` | Value of the `service.namespace` attribute carried on all signals. |

## Signals emitted

### Common attributes

Every signal (log record, metric point, span) carries these attributes:

| Attribute | Values |
| --- | --- |
| `service.namespace` | `SERVICE_NAMESPACE` (default `demo`) |
| `region` | one of `eu-west`, `us-east`, `af-south` |
| `tenant` | one of `tenant-a`, `tenant-b`, `tenant-c` |
| `environment` | `dev` |

In addition, `service.name` is set at resource level from `OTEL_SERVICE_NAME` (default `otel-sample-emitter`) and appears on all signals via the resource.

### Logs

- Emitted at `LOGS_PER_SECOND` for the whole window.
- Standard OpenTelemetry log records (severity text/number plus a message body).
- The exact mix of severities and sample message shapes is defined in `src/index.js` — treat the code as the source of truth.
- Attributes: `service.namespace`, `region`, `tenant`, `environment` (see table above); `service.name` via the resource.

### Metrics

One point per metric per `METRIC_INTERVAL_MS` tick:

| Metric name | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `app.events.processed` | Counter (monotonic) | events | `service.namespace`, `region`, `tenant`, `environment` |
| `app.request.duration` | Histogram | milliseconds | `service.namespace`, `region`, `tenant`, `environment` |
| `app.queue.depth` | Gauge (last value) | items | `service.namespace`, `region`, `tenant`, `environment` |

`service.name` is attached via the resource on every metric export.

### Traces

Each trace is a fixed 3-span tree:

```
parent.operation
├── child.db.query
├── child.http.call
```

`SPANS_PER_SECOND` traces are started per second, so span production is roughly `3 x SPANS_PER_SECOND` spans per second. Every span carries the four common attributes listed above plus the standard span fields (name, kind, status, timings).

## Shutdown and flush

- When `EMIT_DURATION_SECONDS` elapses, the app stops emitting, shuts down the tracer/meter/logger providers, and flushes any batched exports before exiting.
- Export batching is handled by the OTel SDK: the final flush usually completes within a couple of seconds after the window ends. Let the process exit on its own.
- If the process is interrupted hard (kill -9, or the receiver stops accepting), any buffered but unexported telemetry can be lost — a run that is cut short will therefore produce fewer events than the nominal rates predict.

## Verifying output

### 1. Check the receiver accepts OTLP/HTTP

Send one minimal log record with `curl` and confirm the receiver answers `200`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4318/v1/logs \
  -H "Content-Type: application/json" \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"curl-test"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"0","severityText":"INFO","severityNumber":9,"body":{"stringValue":"hello from curl"}}]}]}]}'
```

Expected: `200`. A `404` means you are pointed at the wrong port (for example a gRPC-only listener); connection refused means nothing is listening there at all.

### 2. Watch what the emitter actually posts

If you do not yet have a collector, run this throwaway sink instead (see [docs/collector-setup.md](docs/collector-setup.md) for a full walkthrough of standing up a real OpenTelemetry Collector). It listens on `:4318` and prints one line per OTLP request:

```bash
node -e "require('http').createServer((req,res)=>{let n=0;req.on('data',c=>n+=c.length);req.on('end',()=>{console.log(new Date().toISOString(),req.method,req.url,n+' bytes');res.statusCode=200;res.end();});}).listen(4318,()=>console.log('OTLP sink listening on http://localhost:4318'))"
```

Then start the emitter. You should see lines like:

```
2026-10-29T14:37:01.100Z POST /v1/logs 4312 bytes
2026-10-29T14:37:01.115Z POST /v1/traces 3890 bytes
2026-10-29T14:37:05.110Z POST /v1/metrics 2201 bytes
```

The sink shows you the endpoints and traffic volume but does not decode payloads — use a real collector to inspect record contents.

### 3. Count what arrived

Compare the events the receiver stored against the expected totals:

| Signal | Expected count per run |
| --- | --- |
| Logs | `LOGS_PER_SECOND x (EMIT_DURATION_SECONDS + 1)` — an immediate batch at startup plus one batch per second |
| Spans | `3 x SPANS_PER_SECOND x (EMIT_DURATION_SECONDS + 1)` — 3 spans per tree, same immediate-first-batch rule |
| Metric points | `~19 x (EMIT_DURATION_SECONDS x 1000 / METRIC_INTERVAL_MS)` — each tick emits 9 counter points (region x tenant x outcome), 9 histogram points, and 1 gauge point; a few extra counter points appear over time as the outcome attribute flips between success/failure |

With defaults: 305 logs, 366 spans, ~228 metric points per 60-second run (12 ticks x ~19 points).

Metric exports use cumulative temporality: counter and histogram values grow monotonically, and the final flush at shutdown re-exports the cumulative state, so a receiver may see the last totals twice. Count distinct data points, not export batches.

## Troubleshooting

- **Connection refused (`ECONNREFUSED`)** — nothing is listening at `OTEL_EXPORTER_OTLP_ENDPOINT`. Start the collector first, and confirm the host and port. The app posts to `/v1/*` paths over HTTP; a gRPC-only port will not answer these POSTs.
- **Requests succeed but no data downstream** — the receiver may be answering but dropping or routing records. Check the collector's own logs/metrics, then inspect the pipeline between receiver and backend. Confirm the run window actually overlapped with the time you were watching (the app exits after `EMIT_DURATION_SECONDS` and sends nothing afterwards).
- **Fewer records than the rate formulas predict** — most often the run was interrupted before the window ended, so the final flush was cut short. Re-run undisturbed and let the process exit by itself. Large `METRIC_INTERVAL_MS` values also mean few metric points by design: a 60-second run at the default 5000 ms only produces 12 ticks per instrument.
- **Too many records** — check that you did not leave a higher `LOGS_PER_SECOND`/`SPANS_PER_SECOND` from a previous test in the shell environment.
