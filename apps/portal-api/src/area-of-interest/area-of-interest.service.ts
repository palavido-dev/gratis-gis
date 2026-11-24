// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { validateGeoJson } from '../common/geometry-validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseAreaInput, parseAreaId } from './area-input.js';

/** Rows nobody has used for this long go on the next registration. */
const UNUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResolvedArea {
  /** Name for this area on the aggregate reads (`?area=`). */
  id: string;
  /** The area as the reads use it: unioned, made valid, buffered. */
  geometry: Record<string, unknown>;
  /** Ground area in square meters. 0 for a point or a line. */
  squareMeters: number;
  bbox: [number, number, number, number];
}

/**
 * Areas of interest for What's Here (#796).
 *
 * A screen asks the same area of eight or twelve layers, again on
 * every edit. Sending the polygon with each read would put up to
 * 256 KiB in every URL, which proxies refuse long before that, and
 * would mean the public (GET only) aggregate mirror could not take
 * part. So the area is resolved once here: picked features unioned,
 * the shape made valid, the distance applied on the geography so it
 * is true meters. The reads then name it by id.
 *
 * The id is a hash of the resolved geometry, so the same area is one
 * row however many people screen it. A row holds a shape and nothing
 * else: no feature data, no owner, no org. Registering one reveals
 * nothing, and a read that names one still runs under the caller's
 * own access to each layer.
 */
@Injectable()
export class AreaOfInterestService {
  private readonly log = new Logger(AreaOfInterestService.name);

  constructor(private readonly prisma: PrismaService) {}

  async register(body: unknown): Promise<ResolvedArea> {
    const { geometry, distanceMeters } = parseAreaInput(body);
    validateGeoJson(geometry);
    const json = JSON.stringify(geometry);
    // ST_UnaryUnion merges picked parcels into one shape, so a
    // feature touching two of them is counted once and shared edges
    // do not double the area. ST_MakeValid first, because a drawn
    // shape that crosses itself is the common case, not the edge
    // case, and an invalid polygon makes the later ST_Intersection
    // throw. Seven decimals is about a centimeter. Sixteen segments
    // per quarter circle keeps a buffered point within 0.2% of a true
    // circle's area; the default eight is 0.6% short.
    const rows = await this.prisma.$queryRaw<
      Array<{
        geojson: string | null;
        m2: number | null;
        w: number | null;
        s: number | null;
        e: number | null;
        n: number | null;
        empty: boolean | null;
      }>
    >`
      WITH src AS (
        SELECT ST_UnaryUnion(
          ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))
        ) AS g
      ), aoi AS (
        SELECT CASE WHEN ${distanceMeters}::double precision > 0
          THEN ST_Buffer(g::geography, ${distanceMeters}::double precision, 'quad_segs=16')::geometry
          ELSE g
        END AS g
        FROM src
      )
      SELECT ST_AsGeoJSON(g, 7) AS geojson,
             ST_Area(g::geography) AS m2,
             ST_XMin(g) AS w, ST_YMin(g) AS s, ST_XMax(g) AS e, ST_YMax(g) AS n,
             ST_IsEmpty(g) AS empty
      FROM aoi
    `;
    const row = rows[0];
    if (!row || row.empty !== false || !row.geojson) {
      throw new BadRequestException(
        'That area is empty. Draw a shape, or set a distance around a point or line.',
      );
    }
    const resolved = JSON.parse(row.geojson) as Record<string, unknown>;
    // The resolved shape is what the reads intersect with, so it is
    // held to the same limits as any geometry a caller sends. A buffer
    // can add vertices; this keeps the stored row inside the bound.
    validateGeoJson(resolved);
    const id = createHash('sha256').update(row.geojson).digest('hex').slice(0, 32);
    const squareMeters = Number(row.m2 ?? 0);
    await this.prisma.$executeRaw`
      INSERT INTO area_of_interest (id, geom, square_meters)
      VALUES (
        ${id},
        ST_SetSRID(ST_GeomFromGeoJSON(${row.geojson}::text), 4326),
        ${squareMeters}
      )
      ON CONFLICT (id) DO UPDATE SET last_used_at = now()
    `;
    // Prune here rather than adding a cron, the same way upload grants
    // are pruned on the next presign. Best effort: a failure leaves a
    // few stale rows for the next registration to clear.
    void this.prisma.areaOfInterest
      .deleteMany({
        where: { lastUsedAt: { lt: new Date(Date.now() - UNUSED_TTL_MS) } },
      })
      .catch((e: unknown) =>
        this.log.warn(`area_of_interest prune failed: ${String(e)}`),
      );
    return {
      id,
      geometry: resolved,
      squareMeters,
      bbox: [Number(row.w), Number(row.s), Number(row.e), Number(row.n)],
    };
  }

  /**
   * Check an `?area=` id before a read uses it, and mark it used.
   *
   * A read whose area row has gone would intersect with NULL, match
   * nothing, and report zero for every layer: a confident wrong
   * answer. 410 tells the client to register the shape again, which
   * it can, because it still holds the shape.
   */
  async touch(raw: unknown): Promise<string | undefined> {
    const id = parseAreaId(raw);
    if (id === undefined) return undefined;
    const { count } = await this.prisma.areaOfInterest.updateMany({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
    if (count === 0) {
      throw new GoneException('This area has expired. Pick it again.');
    }
    return id;
  }
}
