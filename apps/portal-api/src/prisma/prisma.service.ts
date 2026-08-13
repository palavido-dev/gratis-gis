// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 moved connection management out of schema.prisma and
 * into a Driver Adapter that the application wires into the
 * PrismaClient constructor explicitly. We use @prisma/adapter-pg
 * (node-postgres under the hood, the same driver pg-copy-streams
 * + the engine's COPY writer already speak) so the rest of the
 * stack keeps one connection-management story.
 *
 * `DATABASE_URL` must be present in the environment at module
 * init; the constructor throws loudly if it isn't, matching the
 * pre-7 behaviour where a missing URL surfaced as a Prisma
 * validation error on first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL must be set before PrismaService can construct its adapter.',
      );
    }
    // Pool sizing. The Prisma 7 driver adapter delegates to
    // `pg.Pool`, whose default `max` is 10. That worked for the
    // pre-MVT request pattern (1-2 queries per /items/* request),
    // but every MVT tile request runs assertV3Layer (item lookup
    // + share check + auth upsert -- 5-8 queries) and MapLibre
    // fires 20-40 tile requests at once on a pan/zoom. With max=10
    // per replica that queues 100+ queries on 20 connections and
    // each tile waits ~half a second just for a pool slot, before
    // any actual compute starts. Bumping to 25 cuts the queue
    // depth to ~2x. The prod DB budget against max_connections=100:
    // portal-api runs 2 replicas at 25 (=50), and the worker
    // processes are capped lower via DB_POOL_MAX in
    // docker-compose.prod.yml (portal-worker 8, script-runner 4) so
    // that plus Keycloak (which shares this Postgres) and the nightly
    // pg_dump stays inside 100. Override via DB_POOL_MAX per service.
    const poolMax = Number(process.env.DB_POOL_MAX ?? 25);
    super({
      adapter: new PrismaPg({ connectionString: url, max: poolMax }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
