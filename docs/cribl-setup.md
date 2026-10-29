# Sending otel-sample-emitter telemetry to Cribl

Step-by-step guide for pointing the emitter at Cribl Stream (or Cribl Edge) acting as an OpenTelemetry OTLP receiver, fanning the three signal types out to destinations, and validating the flow end to end. Assumes you know Cribl basics (Worker Groups, Sources, Routes, Pipelines) and just want copy-paste steps.

## 1. Create the OpenTelemetry source in Cribl

1. In Cribl Stream, go to **Manage > Data Sources** and click **Add Source** (or select the existing **OpenTelemetry** source type).
2. Pick the **OpenTelemetry** source. It can accept both gRPC and HTTP/protobuf OTLP exports.
3. Key settings:
   - **Source ID**: `otel:in` (used later in routes).
   - **Listen port**: the default is `4317` for the OTLP gRPC listener. This app defaults to OTLP/HTTP, which conventionally uses port `4318`. Either:
     - set the source's HTTP listen port to `4318` and keep the app's default endpoint, or
     - leave Cribl on a single port and set `OTEL_EXPORTER_OTLP_ENDPOINT` to match whatever port you chose.
   - **Protocol**: make sure the HTTP/protobuf option is enabled, not only gRPC. A gRPC-only listener will silently never receive this app's POSTs to `/v1/logs`, `/v1/metrics`, `/v1/traces`.
4. Save and commit the config.

If you are running Cribl Edge instead of a Stream worker group, the same source type is available; the listen port and Source ID work the same way, but the Edge node must be network-reachable from wherever the emitter runs.

The emitter is configured per deployment, so no changes on the app side are needed beyond the endpoint environment variable (next section).

## 2. Point the emitter at Cribl

Set the OTLP endpoint to the Cribl host's OTLP/HTTP port:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://<cribl-host>:4318 \
OTEL_SERVICE_NAME=otel-sample-emitter \
EMIT_DURATION_SECONDS=60 \
LOGS_PER_SECOND=5 \
SPANS_PER_SECOND=2 \
METRIC_INTERVAL_MS=5000 \
node src/index.js
```

The app posts to `<endpoint>/v1/logs`, `<endpoint>/v1/metrics`, and `<endpoint>/v1/traces`. Do not append those paths to the endpoint yourself.

If Cribl runs in Docker, publish the OTLP port, e.g. in a `docker-compose.yml`:

```yaml
services:
  cribl:
    image: cribl/cribl:latest
    ports:
      - "9000:9000"   # Cribl UI
      - "4318:4318"   # OTLP/HTTP for the emitter
```

(or the equivalent `-p 4318:4318` with `docker run`). Restart the source / redeploy after changing ports.

## 3. Route the three signal types

Cribl's OpenTelemetry source emits events with a `__signal` field (`logs`, `metrics`, or `traces`). Use that to fan traffic out to different destinations with Routes.

Create a Pipeline (e.g. `otel-fanout`) or go straight to Routes under **Routing > Routes**. Example route table (evaluate top down):

| Priority | Filter | Output | Notes |
| --- | --- | --- | --- |
| 1 | `__signal == 'metrics'` | `metrics_s3` | Route metrics to S3 or a TSDB-friendly destination. |
| 2 | `__signal == 'traces'` | `traces_splunk_hec` | Route spans to your tracing backend or HEC index. |
| 3 | `__signal == 'logs'` | `logs_splunk_hec` | Route logs to Splunk HEC (or Elastic, Datadog, etc.). |
| 4 | `true` (catch-all) | devnull | Drop anything unexpected so it does not silently pile up. |

Set the route table's output to the Source IDs of destinations you have configured (e.g. a Splunk HEC destination or an S3 destination). If you just want to see data arrive, set the catch-all to a `devnull` output with **Sample** enabled, or route everything to a staging S3 bucket while testing.

To enrich or drop before routing, put a Pipeline (e.g. `otel-fanout`) on the routes; a simple `eval` in that pipeline can reshape `service.name`/`tenant` into fields your destination expects.

Commit the config so the changes reach workers.

## 4. Validate end to end

1. **Live data view**: with the emitter running, open the `otel:in` source in Cribl and use **Live Data** (or the source's Capture view). You should see records arriving within a few seconds, tagged with the Source ID you chose.
2. **Event Breakers**: OTLP events arrive as complete protobuf-decoded events, so no custom Event Breaker is needed. If you route logs to a destination that re-splits, use the source's default breaker; the emitter's log records are one event each.
3. **Filter on the expected attribute names** in Cribl search/capture to confirm labelling came through:
   - `service.name` = `otel-sample-emitter` (resource-level, from `OTEL_SERVICE_NAME`)
   - `service.namespace` = `demo` (from `SERVICE_NAMESPACE`)
   - `region` = one of `eu-west`, `us-east`, `af-south`
   - `tenant` = one of `tenant-a`, `tenant-b`, `tenant-c`
   - `environment` = `dev`
   - Metric names: `app.events.processed` (counter), `app.request.duration` (histogram), `app.queue.depth` (gauge).
4. **Destination spot-check**: in Splunk, search `index=* service.name="otel-sample-emitter"` (or the S3 prefix you routed to) and confirm counts roughly match the rates you configured.

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

- **Port conflicts**: if Cribl's OTLP listener fails to bind because something else (e.g. a local collector) already owns 4317/4318, move one of them to a different port and update `OTEL_EXPORTER_OTLP_ENDPOINT` accordingly.
- **gRPC vs HTTP mismatch**: the emitter speaks OTLP/HTTP (protobuf POSTs to `/v1/logs`, `/v1/metrics`, `/v1/traces`). If the Cribl source is configured gRPC-only, or you point the emitter at a gRPC-only port, requests will fail or never arrive. Make sure the HTTP/protobuf listener is enabled and the port in the endpoint matches it.
- **Cribl worker group vs standalone Edge**: the OpenTelemetry source on a Stream worker group listens on the workers' network interface; if you deployed to Cribl Edge instead, the Edge node needs its own reachable listener on that port. Confirm which deployment actually owns the source before pointing the emitter at it.
- **No data in Cribl**: check the emitter's own stderr for connection errors first, then the source's Live Data view. If the emitter prints `ECONNREFUSED`, the endpoint or port is wrong; if the emitter runs clean but Cribl shows nothing, verify the route table committed and that no catch-all `devnull` route is swallowing events before your real destination.
