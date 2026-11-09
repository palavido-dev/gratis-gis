// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boots a real Nest + Express app on a random port and talks HTTP to
// it, because the things worth proving live in Express: what req.route
// holds when the response finishes, that /metrics sits outside the /api
// prefix, and that an unset token leaves Nest's normal 404 in place.

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Controller, Get, type INestApplication, Module, Param } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { PrismaService } from '../prisma/prisma.service';
import { installMetrics } from './install-metrics';
import { MIN_METRICS_TOKEN_LENGTH } from './metrics-auth';
import {
  DB_POOL_STATS,
  MetricsService,
  TILE_CACHE_STATS,
  type TileCacheCounters,
} from './metrics.service';

const TOKEN = 'k'.repeat(MIN_METRICS_TOKEN_LENGTH + 8);
const ITEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LAYER_NAME = 'secret-parcels';

@Controller('items')
class ItemsTestController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

@Controller('public')
class TilesTestController {
  @Get('items/:id/layers/:layerId/tile/:z/:x/:y.mvt')
  tile() {
    return 'tile';
  }
}

const tileStats: TileCacheCounters = {
  hits: 7,
  misses: 3,
  evictions: 1,
  coalesced: 2,
  rejectedOverload: 0,
  invalidations: 4,
  entries: 5,
  bytes: 1024,
  maxBytes: 4096,
  inFlight: 0,
};

const prismaStub = {
  $transaction: jest.fn(async () => [
    0,
    [
      { t: 'import', bucket: 'queued', n: 2, oldest: 30 },
      { t: 'script', bucket: 'failed', n: 1, oldest: 0 },
    ],
  ]),
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

@Module({
  controllers: [ItemsTestController, TilesTestController],
  providers: [
    MetricsService,
    { provide: PrismaService, useValue: prismaStub },
    { provide: TILE_CACHE_STATS, useValue: { getStats: () => tileStats } },
    {
      provide: DB_POOL_STATS,
      useValue: { poolStats: () => ({ total: 4, idle: 1, waiting: 2, max: 25 }) },
    },
  ],
})
class TestAppModule {}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function boot(token: string | undefined): Promise<{ app: INestApplication; port: number }> {
  const app = await NestFactory.create(TestAppModule, { logger: false });
  // Same order as main.ts.
  installMetrics(app, token);
  app.setGlobalPrefix('api', { exclude: ['/health', '/docs'] });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /metrics when METRICS_TOKEN is unset', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    ({ app, port } = await boot(undefined));
  });
  afterAll(() => app.close());

  it('is the normal 404, with or without a token', async () => {
    expect((await get(port, '/metrics')).status).toBe(404);
    expect((await get(port, '/metrics', { Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await get(port, '/api/metrics')).status).toBe(404);
  });

  it('turns nothing on', () => {
    expect(app.get(MetricsService).enabled).toBe(false);
  });

  it('ignores a token that is too short', async () => {
    const short = await boot('short-token');
    try {
      expect((await get(short.port, '/metrics', { Authorization: 'Bearer short-token' })).status).toBe(404);
    } finally {
      await short.app.close();
    }
  });
});

describe('GET /metrics when METRICS_TOKEN is set', () => {
  let app: INestApplication;
  let port: number;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    ({ app, port } = await boot(TOKEN));
  });
  afterAll(() => app.close());

  it('answers 401 without a token or with the wrong one', async () => {
    const missing = await get(port, '/metrics');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.body).toBe('');
    expect((await get(port, '/metrics', { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await get(port, '/metrics', { Authorization: `Basic ${TOKEN}` })).status).toBe(401);
  });

  it('is not served under the /api prefix', async () => {
    expect((await get(port, '/api/metrics', auth)).status).toBe(404);
  });

  it('answers 200 in the Prometheus text format with the expected metrics', async () => {
    const res = await get(port, '/metrics', auth);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    for (const name of [
      'process_cpu_seconds_total',
      'process_resident_memory_bytes',
      'nodejs_eventloop_lag_seconds',
      'nodejs_heap_size_used_bytes',
      'gratisgis_http_request_duration_seconds',
      'gratisgis_tile_requests_total',
      'gratisgis_tile_cache_hits_total 7',
      'gratisgis_tile_cache_misses_total 3',
      'gratisgis_tile_cache_bytes 1024',
      'gratisgis_db_pool_connections{state="in_use"} 3',
      'gratisgis_db_pool_connections{state="idle"} 1',
      'gratisgis_db_pool_waiting 2',
      'gratisgis_jobs{type="import",state="queued"} 2',
      'gratisgis_jobs_oldest_queued_seconds{type="import"} 30',
      'gratisgis_jobs_failed_recent{type="script"} 1',
      'gratisgis_jobs_query_error 0',
    ]) {
      expect(res.body).toContain(name);
    }
  });

  it('labels requests with the route template and never the raw path', async () => {
    const hit = await get(port, `/api/items/${ITEM_ID}?name=${LAYER_NAME}`);
    expect(hit.status).toBe(200);
    expect((await get(port, `/api/public/items/${ITEM_ID}/layers/${LAYER_NAME}/tile/3/2/1.mvt`)).status).toBe(200);
    expect((await get(port, `/api/no-such-route/${ITEM_ID}`)).status).toBe(404);

    const res = await get(port, '/metrics', auth);
    expect(res.body).toMatch(
      /gratisgis_http_request_duration_seconds_count\{method="GET",route="\/api\/items\/:id",status_class="2xx"\} 1/,
    );
    expect(res.body).toContain('route="/api/public/items/:id/layers/:layerId/tile/:z/:x/:y.mvt"');
    expect(res.body).toMatch(
      /gratisgis_http_request_duration_seconds_count\{method="GET",route="unmatched",status_class="4xx"\} [1-9]/,
    );
    expect(res.body).toMatch(
      /gratisgis_tile_requests_total\{kind="vector",surface="public",status_class="2xx"\} 1/,
    );
    expect(res.body).not.toContain(ITEM_ID);
    expect(res.body).not.toContain(LAYER_NAME);
    expect(res.body).not.toContain('no-such-route');
    // Scrapes are not counted in the numbers they report.
    expect(res.body).not.toContain('route="/metrics"');
  });

  it('answers 429 to a client that keeps guessing', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (await get(port, '/metrics', { Authorization: 'Bearer wrong' })).status;
    }
    expect(last).toBe(429);
  });
});
