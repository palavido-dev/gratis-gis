# Prometheus metrics

portal-api can serve Prometheus metrics at `GET /metrics`. It is off by
default. An install that never sets `METRICS_TOKEN` has no metrics
route, runs no collectors, and answers `/metrics` with the same 404 as
any unknown path.

## Turn it on

1. Make a token of at least 32 characters:

   ```sh
   openssl rand -hex 32
   ```

2. Set it for portal-api and restart portal-api.
   - VPS stack: add `METRICS_TOKEN=<token>` to `infra/.env.prod`, then
     `docker compose -f infra/docker-compose.prod.yml up -d portal-api`.
   - NAS stack: add `METRICS_TOKEN=<token>` to the app's environment
     (Dockge env box or TrueNAS app settings), then restart.

3. Check it from inside the stack:

   ```sh
   docker compose -f infra/docker-compose.prod.yml exec portal-api node -e \
     "fetch('http://localhost:4000/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(t=>console.log(t.slice(0,400)))"
   ```

The log line `Prometheus metrics enabled at /metrics` confirms it. A
token shorter than 32 characters is ignored with a warning, and the
route stays off.

## Who can reach it

- Requests need `Authorization: Bearer <METRICS_TOKEN>`. The token is
  compared in constant time. A missing or wrong token gets 401, and a
  client that keeps guessing gets 429 for the rest of the minute.
- The route is outside the `/api` prefix. Neither shipped Caddy config
  routes it, and both answer `/metrics` with 404 at the edge on
  purpose. Do not add a Caddy route for it. Prometheus scrapes each API
  replica directly on the docker network; through Caddy, every scrape
  would land on whichever replica the load balancer picked, so the
  numbers would jump between processes.
- portal-api is also on the scripts network, so user scripts can open a
  connection to `portal-api:4000`. The token is what keeps them out;
  it is never passed to the script containers.
- Rotate the token by changing it in both the env file and the
  Prometheus secret file, then restarting portal-api.

## Scrape config

Run Prometheus on the stack's `gratis-net` network. The VPS stack's
network is `gratis-gis-prod_gratis-net`; on the NAS, `docker network ls`
shows the name. Put the token in a file Prometheus can read, for example
`/etc/prometheus/gratisgis_token`.

```yaml
scrape_configs:
  - job_name: gratisgis-portal-api
    metrics_path: /metrics
    scheme: http
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/gratisgis_token
    # One target per replica. Docker's DNS returns every portal-api
    # container for the service name.
    dns_sd_configs:
      - names: [portal-api]
        type: A
        port: 4000
        refresh_interval: 30s
```

With one API container (the NAS stack), a static target does the same:

```yaml
    static_configs:
      - targets: ['portal-api:4000']
```

A compose override that attaches Prometheus to the VPS network:

```yaml
services:
  prometheus:
    image: prom/prometheus:v3.5.0
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./gratisgis_token:/etc/prometheus/gratisgis_token:ro
    networks: [gratis-net]
```

Do not publish the Prometheus port to the internet either.

## What it reports

Labels hold fixed values or route templates only. No metric carries an
org, item, layer, user or job identifier, a raw path, or a query
string.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `process_*`, `nodejs_*` | | Memory, CPU, open handles, event loop lag, GC (the client's default set). |
| `gratisgis_http_request_duration_seconds` | `method`, `route`, `status_class` | Request time by route template, such as `/api/items/:id`. `_count` is the request count. Unknown paths are `route="unmatched"`. Scrapes of `/metrics` are not counted. |
| `gratisgis_tile_requests_total` | `kind` (vector, raster), `surface` (public, portal), `status_class` | Tile requests. `public` is `/api/public/*`. |
| `gratisgis_tile_cache_hits_total`, `_misses_total`, `_evictions_total`, `_coalesced_total`, `_rejected_overload_total`, `_invalidations_total` | | The in-process tile cache counters. The same cache holds dashboard aggregates, so they are included. |
| `gratisgis_tile_cache_entries`, `_bytes`, `_max_bytes`, `_in_flight` | | Tile cache size and work in progress. |
| `gratisgis_db_pool_connections` | `state` (in_use, idle) | Prisma's Postgres pool in this process. |
| `gratisgis_db_pool_waiting`, `gratisgis_db_pool_max` | | Queries waiting for a connection, and `DB_POOL_MAX`. |
| `gratisgis_jobs` | `type`, `state` (queued, running) | Background jobs waiting or in progress. |
| `gratisgis_jobs_oldest_queued_seconds` | `type` | Age of the oldest queued job. A number that keeps growing means no worker is picking jobs up. |
| `gratisgis_jobs_failed_recent` | `type` | Jobs that failed in the last hour. |
| `gratisgis_jobs_query_error` | | 1 when the job query failed; the job gauges then hold the last good values. |

Job `type` is one of `import`, `ago_import`, `analysis`, `script`,
`offline_package`.

### Notes for queries and alerts

- Job numbers come from the database, so every API replica reports the
  same portal-wide values. Use `max by (type, state) (gratisgis_jobs)`,
  not `sum`. The query runs at most once every 15 seconds per replica,
  under a 2 second statement timeout.
- Everything else is per process. Sum across replicas, for example
  `sum(rate(gratisgis_http_request_duration_seconds_count[5m]))`.
- Tile cache hit ratio:
  `sum(rate(gratisgis_tile_cache_hits_total[5m])) / (sum(rate(gratisgis_tile_cache_hits_total[5m])) + sum(rate(gratisgis_tile_cache_misses_total[5m])))`.
- p95 latency per route:
  `histogram_quantile(0.95, sum by (le, route) (rate(gratisgis_http_request_duration_seconds_bucket[5m])))`.

portal-worker, the script runner and the point cloud worker have no
HTTP listener, and this change does not add one. Their queues are the
job metrics above; container memory and CPU come from the container
runtime (cAdvisor or `docker stats`).
