// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type {
  ToolDependencies,
  ToolEnrichContext,
  ToolGenerator,
  ToolValidateContext,
} from './types.js';
import { NUMERIC_TEXT_REGEX_LITERAL, numericTextSql } from './numeric-text.js';

export interface ContourParams {
  field: string;
  mode: 'auto' | 'manual';
  interval?: number;
  minLevel?: number;
  maxLevel?: number;
  levels?: number[];
  cachedLevels?: number[];
}

const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const MAX_LEVELS = 100;

/**
 * Contour-from-points generator (#88).  Builds a TIN from the
 * upstream point features and emits one line feature per
 * (triangle, level) intersection.  Each output line is tagged with
 * a `level` property carrying the actual contour value.
 *
 * Algorithm (per triangle ABC with field values zA, zB, zC and a
 * target level L):
 *
 *   1. Range check: skip when L < min(zA,zB,zC) or L > max(...).
 *   2. For each edge (A-B, B-C, C-A): if L is between the two
 *      endpoints' values (strict on the lower side, inclusive on
 *      the upper to avoid double-emission at exact vertex
 *      crossings), linearly interpolate the point where the edge
 *      crosses level L.  Specifically:
 *        t = (L - zP) / (zQ - zP)
 *        point = P + t * (Q - P)
 *   3. Exactly two of the three edges will have crossings (or zero
 *      / three in degenerate cases).  Emit a line from p1 to p2
 *      when there are two.  Zero and three cases are skipped.
 *
 * The SQL uses ST_DelaunayTriangles(ST_Collect(geom)) to build the
 * TIN as a single GEOMETRYCOLLECTION of triangles, then unnests it
 * with ST_Dump.  ST_PointN on each ring vertex gives us the
 * triangle corners; ST_Distance from those back to the original
 * points (rounded) maps each corner to its source row so we know
 * which `field` value sits at each vertex.
 *
 * That last step is the expensive bit: O(N triangles * 3 vertices
 * * N points) for nearest-neighbor lookup.  For dense point sets
 * (1000+ samples) this can be slow; the read path's bbox prefilter
 * keeps real workloads bounded.  A future commit could materialize
 * the (point -> value) map in a CTE and use ST_DistanceKNN for
 * faster lookup; the current shape prefers correctness + clarity
 * over raw throughput.
 *
 * Cached levels: the wizard sends `mode: 'auto'` + `interval` + an
 * optional `min/maxLevel`.  At save time `enrich` queries the
 * source's MIN/MAX of the field, generates the level list, and
 * stamps it as `cachedLevels`.  The read path uses cachedLevels
 * directly so the SQL doesn't recompute the range every request.
 */
export const contourGenerator: ToolGenerator<ContourParams> = {
  kind: 'contour',

  validate(raw: unknown, ctx?: ToolValidateContext): ContourParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('contour.params must be an object');
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.field !== 'string' || !FIELD_NAME_RE.test(r.field)) {
      throw new BadRequestException(
        `contour.params.field must match ${FIELD_NAME_RE} (letters / digits / underscore, not starting with a digit)`,
      );
    }
    if (ctx?.sourceSchema) {
      const f = ctx.sourceSchema.find((s) => s.name === r.field);
      if (!f) {
        throw new BadRequestException(
          `contour.params.field "${r.field}" does not exist on the source schema`,
        );
      }
      if (f.type !== 'number') {
        throw new BadRequestException(
          `contour.params.field "${r.field}" must be a number field; found type "${f.type}"`,
        );
      }
    }

    const mode = r.mode;
    if (mode !== 'auto' && mode !== 'manual') {
      throw new BadRequestException(
        "contour.params.mode must be 'auto' or 'manual'",
      );
    }

    let interval: number | undefined;
    let minLevel: number | undefined;
    let maxLevel: number | undefined;
    let levels: number[] | undefined;

    if (mode === 'auto') {
      const i = r.interval;
      if (typeof i !== 'number' || !Number.isFinite(i) || i <= 0) {
        throw new BadRequestException(
          'contour.params.interval must be a positive number when mode=auto',
        );
      }
      interval = i;
      if (r.minLevel !== undefined) {
        if (typeof r.minLevel !== 'number' || !Number.isFinite(r.minLevel)) {
          throw new BadRequestException(
            'contour.params.minLevel must be a finite number',
          );
        }
        minLevel = r.minLevel;
      }
      if (r.maxLevel !== undefined) {
        if (typeof r.maxLevel !== 'number' || !Number.isFinite(r.maxLevel)) {
          throw new BadRequestException(
            'contour.params.maxLevel must be a finite number',
          );
        }
        maxLevel = r.maxLevel;
      }
      if (
        minLevel !== undefined &&
        maxLevel !== undefined &&
        minLevel >= maxLevel
      ) {
        throw new BadRequestException(
          'contour.params.minLevel must be strictly less than maxLevel',
        );
      }
    } else {
      // manual: explicit list of levels
      const raw = r.levels;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new BadRequestException(
          'contour.params.levels must be a non-empty array when mode=manual',
        );
      }
      if (raw.length > MAX_LEVELS) {
        throw new BadRequestException(
          `contour.params.levels supports at most ${MAX_LEVELS} entries`,
        );
      }
      const list: number[] = [];
      for (const v of raw) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new BadRequestException(
            'contour.params.levels entries must all be finite numbers',
          );
        }
        list.push(v);
      }
      for (let i = 1; i < list.length; i++) {
        if (list[i]! <= list[i - 1]!) {
          throw new BadRequestException(
            'contour.params.levels must be sorted ascending with no duplicates',
          );
        }
      }
      levels = list;
    }

    // Accept a cachedLevels stamp coming back through validate at
    // read time (validateAndEnrich does the actual stamping).  At
    // save time the input shouldn't carry one yet; we just pass
    // through whatever's there.
    let cachedLevels: number[] | undefined;
    if (r.cachedLevels !== undefined) {
      if (
        !Array.isArray(r.cachedLevels) ||
        r.cachedLevels.length === 0 ||
        r.cachedLevels.length > MAX_LEVELS ||
        !r.cachedLevels.every(
          (v) => typeof v === 'number' && Number.isFinite(v),
        )
      ) {
        throw new BadRequestException(
          'contour.params.cachedLevels must be a non-empty array of finite numbers',
        );
      }
      cachedLevels = r.cachedLevels.slice() as number[];
    }

    return {
      field: r.field,
      mode,
      ...(interval !== undefined ? { interval } : {}),
      ...(minLevel !== undefined ? { minLevel } : {}),
      ...(maxLevel !== undefined ? { maxLevel } : {}),
      ...(levels !== undefined ? { levels } : {}),
      ...(cachedLevels !== undefined ? { cachedLevels } : {}),
    };
  },

  async enrich(
    params: ContourParams,
    ctx: ToolEnrichContext,
  ): Promise<ContourParams> {
    // Manual mode carries its level list explicitly; just promote
    // it into cachedLevels so the read path has one place to look.
    if (params.mode === 'manual') {
      return {
        ...params,
        cachedLevels: params.levels ? params.levels.slice() : [],
      };
    }

    // Auto: resolve min / max from the source if the wizard didn't
    // supply them, then walk by interval to build the list.
    const safeField = params.field.replace(/'/g, "''");
    let min = params.minLevel;
    let max = params.maxLevel;
    if (min === undefined || max === undefined) {
      const rows = await ctx.queryRaw<{ minv: number | null; maxv: number | null }>(
        `SELECT
           MIN(${numericTextSql(`(properties->>'${safeField}')`)}) AS minv,
           MAX(${numericTextSql(`(properties->>'${safeField}')`)}) AS maxv
         FROM ${ctx.sourceTable}`,
      );
      const r = rows[0];
      if (!r || r.minv === null || r.maxv === null) {
        // Source has no numeric values yet; cache empty levels.
        // The read path emits zero features in that case.
        return { ...params, cachedLevels: [] };
      }
      if (min === undefined) min = Number(r.minv);
      if (max === undefined) max = Number(r.maxv);
    }
    if (!(min < max)) {
      // Degenerate range; nothing to contour.
      return { ...params, cachedLevels: [] };
    }
    const interval = params.interval!;
    const cachedLevels: number[] = [];
    // Snap min UP to the nearest multiple of interval so the levels
    // land on round values (10, 20, 30, ...) rather than weird
    // offsets driven by an outlier point.  Subtle but matches what
    // every contour-from-points tool I've used does.
    const firstLevel = Math.ceil(min / interval) * interval;
    for (let level = firstLevel; level <= max; level += interval) {
      cachedLevels.push(level);
      if (cachedLevels.length >= MAX_LEVELS) break;
    }
    return { ...params, cachedLevels };
  },

  outputSchema(input: FeatureField[], _params: ContourParams): FeatureField[] {
    // Contour output is line features tagged with `level`.  Drop
    // upstream attributes because they no longer correspond 1:1
    // with output rows (each output line is interpolated across
    // multiple source points).  Authors who need to keep an
    // upstream attribute should aggregate it first (e.g.
    // calculate-field a constant).
    void input;
    return [
      {
        name: 'level',
        label: 'Contour level',
        type: 'number',
        nullable: false,
      },
    ];
  },

  outwardReachMeters(): number {
    // Contour lines stay strictly inside the convex hull of the
    // input points, so they cannot reach outward.  Returning 0
    // means the read path's bbox prefilter doesn't get an extra
    // pad on this step's account.
    return 0;
  },

  extractDependencies(): ToolDependencies {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: ContourParams, paramOffset: number) {
    const sqlParams: unknown[] = [];
    const levels = params.cachedLevels ?? [];
    if (levels.length === 0) {
      // No levels = no output.  Emit an empty CTE so downstream
      // tools have something to read FROM without special-casing.
      return {
        sql: `SELECT gen_random_uuid()::text AS global_id,
                NULL::geometry AS geom,
                '{}'::jsonb AS properties
                WHERE FALSE`,
        params: [],
      };
    }

    sqlParams.push(levels);
    const levelsPh = `$${paramOffset + sqlParams.length}::numeric[]`;

    // Safe to inline the field name because validate() restricted
    // it to FIELD_NAME_RE.  Doubled-up single quotes for SQL safety
    // are belt-and-suspenders.
    const safeField = params.field.replace(/'/g, "''");

    // Compose:
    //   pts = upstream rows with their (geom, value) extracted
    //   tin = Delaunay triangulation as a single geom collection,
    //         unnested to one triangle per row
    //   verts = per (triangle, vertex idx) row with the vertex's
    //           geom + its source value, joined back via nearest
    //           sample point (we use ST_DWithin with a generous
    //           tolerance + ORDER BY ST_Distance to pick the
    //           nearest match per vertex)
    //   tri_with_z = pivot back to one row per triangle with three
    //                geom/value pairs
    //   crossings = for each (triangle, level), per-edge crossings
    //               using linear interpolation
    //   lines = pair the two crossing points per (triangle, level)
    //           into an ST_MakeLine output
    //
    // The OUTPUT is `lines`: one row per (triangle, level) that
    // actually crosses, tagged with `level` in properties.
    const sql = `
      WITH pts AS (
        SELECT
          global_id,
          geom,
          ${numericTextSql(`(properties->>'${safeField}')`)}::numeric AS val
        FROM ${inputAlias}
        WHERE geom IS NOT NULL
          AND (properties->>'${safeField}') ~ ${NUMERIC_TEXT_REGEX_LITERAL}
      ),
      -- Number the triangles from the dump itself. row_number() next
      -- to a set-returning call in the select list runs before the
      -- set is expanded, so every triangle used to get id 1.
      tin AS (
        SELECT d.tri_id, d.geom AS tri_geom
        FROM (
          SELECT ST_DelaunayTriangles(ST_Collect(geom), 0.0, 0) AS g
          FROM pts
        ) c
        CROSS JOIN LATERAL ST_Dump(c.g) WITH ORDINALITY AS d(path, geom, tri_id)
      ),
      verts AS (
        SELECT
          t.tri_id,
          v.idx,
          ST_PointN(ST_ExteriorRing(t.tri_geom), v.idx) AS vgeom
        FROM tin t
        CROSS JOIN LATERAL (VALUES (1), (2), (3)) AS v(idx)
      ),
      verts_z AS (
        SELECT
          v.tri_id,
          v.idx,
          v.vgeom,
          (
            SELECT p.val
            FROM pts p
            ORDER BY ST_Distance(p.geom, v.vgeom) ASC
            LIMIT 1
          ) AS val
        FROM verts v
      ),
      tri AS (
        SELECT
          tri_id,
          -- Pivot the three vertices by position. MAX() on a geometry
          -- only ran through an implicit text cast.
          (array_agg(vgeom ORDER BY idx))[1] AS a_geom,
          (array_agg(val ORDER BY idx))[1] AS a_z,
          (array_agg(vgeom ORDER BY idx))[2] AS b_geom,
          (array_agg(val ORDER BY idx))[2] AS b_z,
          (array_agg(vgeom ORDER BY idx))[3] AS c_geom,
          (array_agg(val ORDER BY idx))[3] AS c_z
        FROM verts_z
        GROUP BY tri_id
      ),
      levels AS (
        SELECT unnest(${levelsPh}) AS level
      ),
      crossings AS (
        SELECT
          t.tri_id,
          l.level,
          -- Per-edge crossing: when the level falls between the
          -- two endpoints' values, interpolate the point.  We
          -- include both ordering directions ((p<L<=q) AND
          -- (q<L<=p) cases) so a level equal to a vertex value
          -- only emits on one edge, avoiding duplicate segments
          -- at exact-vertex crossings.
          (
            SELECT array_agg(
              ST_MakePoint(
                ST_X(p_geom) + ((l.level - p_z) / (q_z - p_z)) * (ST_X(q_geom) - ST_X(p_geom)),
                ST_Y(p_geom) + ((l.level - p_z) / (q_z - p_z)) * (ST_Y(q_geom) - ST_Y(p_geom))
              )
            )
            FROM (
              SELECT t.a_geom AS p_geom, t.a_z AS p_z, t.b_geom AS q_geom, t.b_z AS q_z
              UNION ALL
              SELECT t.b_geom, t.b_z, t.c_geom, t.c_z
              UNION ALL
              SELECT t.c_geom, t.c_z, t.a_geom, t.a_z
            ) edges
            WHERE p_z IS NOT NULL AND q_z IS NOT NULL AND p_z <> q_z
              AND (
                (p_z < l.level AND l.level <= q_z) OR
                (q_z < l.level AND l.level <= p_z)
              )
          ) AS pts_arr
        FROM tri t
        CROSS JOIN levels l
        WHERE t.a_z IS NOT NULL AND t.b_z IS NOT NULL AND t.c_z IS NOT NULL
          AND l.level >= LEAST(t.a_z, t.b_z, t.c_z)
          AND l.level <= GREATEST(t.a_z, t.b_z, t.c_z)
      )
      SELECT
        gen_random_uuid()::text AS global_id,
        ST_SetSRID(ST_MakeLine(pts_arr[1], pts_arr[2]), 4326) AS geom,
        jsonb_build_object('level', level) AS properties
      FROM crossings
      WHERE pts_arr IS NOT NULL
        AND array_length(pts_arr, 1) = 2
    `;
    return { sql, params: sqlParams };
  },
};
