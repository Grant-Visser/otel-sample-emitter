# Sending otel-sample-emitter telemetry to an OpenTelemetry Collector

Step-by-step guide for pointing the emitter at an OpenTelemetry Collector acting as the OTLP receiver, wiring per-signal exporters, and validating the flow end to end. Copy-paste steps for a standard `otelcol` deployment (binary or Docker).

## 1. Run a Collector with an OTLP/HTTP receiver

The emitter speaks OTLP/HTTP (protobuf POSTs to `/v1/logs`, `/v1/metrics`, `/v1/traces`), conventionally on port `4318`. A minimal config that receives all three signals and prints them:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    traces:
      receivers: [otlp]
      exporters: [debug]
```

Run it with Docker:

```bash
docker run --rm -p 4317:4317 -p 4318:4318 \
  -v "$PWD/otel-collector-config.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest \
  --config=/etc/otelcol/config.yaml
```

Or as a binary: download the `otelcol` release for your platform from the OpenTelemetry Collector releases page and run `otelcol --config=otel-collector-config.yaml`.

Notes:

- Enable at least the `http` protocol. A gRPC-only listener will silently never receive this app's POSTs.
- If you move the collector to a different port, update `OTEL_EXPORTER_OTLP_ENDPOINT` to match.

The emitter is configured per deployment, so no app-side changes are needed beyond the endpoint environment variable (next section).

## 2. Point the emitter at the Collector

Set the OTLP endpoint to the Collector host's OTLP/HTTP port:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318 \
OTEL_SERVICE_NAME=otel-sample-emitter \
EMIT_DURATION_SECONDS=60 \
LOGS_PER_SECOND=5 \
SPANS_PER_SECOND=2 \
METRIC_INTERVAL_MS=5000 \
node src/index.js
```

The app posts to `<endpoint>/v1/logs`, `<endpoint>/v1/metrics`, and `<endpoint>/v1/traces`. Do not append those paths to the endpoint yourself.

## 3. Fan the three signal types out to different exporters

The Collector's pipelines are already split by signal type (`logs`, `metrics`, `traces`), so fan-out is a matter of pointing each pipeline at its own exporter. Example:

```yaml
exporters:
  file/metrics:
    path: /tmp/otel-metrics.json
  file/traces:
    path: /tmp/otel-traces.json
  otlp/backend:
    endpoint: <your-backend-host>:4317
    tls:
      insecure: true

service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [otlp/backend]
    metrics:
      receivers: [otlp]
      exporters: [file/metrics]
    traces:
      receivers: [otlp]
      exporters: [file/traces]
```

To reshape or filter before exporting, add a `processors:` block (e.g. `batch`, `attributes`, `filter`) and list it in the pipeline's `processors:` entry. Restart the collector after config changes.

For a quick test where you just want to see data arrive, keep every pipeline on the `debug` exporter instead.

## 4. Validate end to end

1. **Collector logs**: with the emitter running and the `debug` exporter enabled, you should see export batches arriving within a few seconds, tagged with the resource attributes of each signal.
2. **Confirm the labelling** by filtering on the expected attribute names in the debug output or your destination:
   - `service.name` = `otel-sample-emitter` (resource-level, from `OTEL_SERVICE_NAME`)
   - `service.namespace` = `demo` (from `SERVICE_NAMESPACE`)
   - `region` = one of `eu-west`, `us-east`, `af-south`
   - `tenant` = one of `tenant-a`, `tenant-b`, `tenant-c`
   - `environment` = `dev`
   - Metric names: `app.events.processed` (counter), `app.request.duration` (histogram), `app.queue.depth` (gauge).
3. **Count what arrived**: with a `file` exporter, each exported record lands as a line in the output file, so `wc -l` / `jq` over the file gives you per-signal totals to compare against the formulas below. Alternatively count records in the destination backend.
4. **Destination spot-check**: query the backend you routed to (e.g. filter `service.name="otel-sample-emitter"`) and confirm counts roughly match the rates you configured.

## 5. Rate planning

Use these formulas to size the window so a test produces a known volume:

| Signal | Events per run |
| --- | --- |
| Logs | `LOGS_PER_SECOND x (EMIT_DURATION_SECONDS + 1)` (immediate first batch plus one per second) |
| Spans | `3 x SPANS_PER_SECOND x (EMIT_DURATION_SECONDS + 1)` (3 spans per tree, immediate first batch) |
| Metric points | `~19 x (EMIT_DURATION_SECONDS x 1000 / METRIC_INTERVAL_MS)` — 9 counter + 9 histogram + 1 gauge points per tick |

Examples:

- Defaults (60 s window, 5 logs/s, 2 traces/s, 5000 ms interval): 305 logs, 366 spans, ~228 metric points.
- 10-minute soak (600 s, 50 logs/s, 5 traces/s, 5000 ms interval): 30,050 logs, 9,015 spans, ~2,280 metric points.

Metric exports are cumulative: counter/histogram totals grow monotonically and the shutdown flush re-exports the final state, so expect the last totals to appear twice. Validate on distinct data points rather than raw export batches.

For collector load tests, prefer more spans/logs over a very small `METRIC_INTERVAL_MS` — the metric tick interval is fixed per run and very small values produce mostly metric noise rather than useful cardinality variation.

## 6. Troubleshooting

- **Port conflicts**: if the collector's OTLP listener fails to bind because something else already owns 4317/4318 (another collector, a local app), move one of them to a different port and update `OTEL_EXPORTER_OTLP_ENDPOINT` accordingly.
- **gRPC vs HTTP mismatch**: the emitter speaks OTLP/HTTP (protobuf POSTs to `/v1/logs`, `/v1/metrics`, `/v1/traces`). If the receiver is configured gRPC-only, or you point the emitter at a gRPC-only port, requests will fail or never arrive. Make sure the `http` protocol is enabled and the port in the endpoint matches it.
- **Config rejected at startup**: the collector validates the config on boot and exits on unknown exporter/receiver/processor names or wrong pipeline wiring. Each pipeline must list at least one receiver and one exporter. Fix the reported component and restart.
- **Requests succeed but no data downstream**: the collector is answering but records are not reaching the exporter. Check that the signal's pipeline exists (a signal with no pipeline is dropped by default), that the exporter is reachable, and that no `filter` processor is dropping the records.
- **No data at all**: check the emitter's own stderr for connection errors first, then the collector's logs. If the emitter prints `ECONNREFUSED`, the endpoint or port is wrong; if the emitter runs clean but the collector shows nothing, verify the collector actually started with the config file you edited (`--config` path) and that its OTLP receiver is on the port you expect.
