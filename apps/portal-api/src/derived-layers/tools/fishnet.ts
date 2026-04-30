import { BadRequestException } from '@nestjs/common';
import {
  isLengthUnit,
  metersFor,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type {
  ToolEnrichContext,
  ToolGenerator,
  ToolValidateContext,
} from './types.js';

export interface FishnetParams {
  cellSize: number;
  unit: LengthUnit;
  /** 'polygons' = filled cells; 'lines' = grid lines / transects only. */
  output: 'polygons' | 'lines';
}

const MIN_CELL_METERS = 1;
const MAX_CELL_METERS = 100_000;

/**
 * Hard cap on cells generated per fishnet step. ST_SquareGrid covers
 * the source's bbox before the polygon-intersection filter, so the
 * generator can produce far more intermediate rows than the recipe's
 * `featureLimit` final cap covers. Without a save-time check, a small
 * cellSize on a state-sized polygon fills Postgres's pgsql_tmp directory
 * and takes the database down. One million cells (a 1000x1000 grid) is
 * dense enough for any sensible visual workflow and small enough that
 * even on an underprovisioned dev Postgres the read never exhausts
 * temp space.
 */
const MAX_CELLS_PER_RECIPE = 1_000_000;

/**
 * Approximate meters per degree at the equator. Used by the enrich
 * hook's cell-count estimate. Over-estimates near the poles (where a
 * degree of longitude is shorter than at the equator), which produces
 * a CONSERVATIVE estimate (more cells than will actually be generated),
 * which is what we want for a safety check.
 */
const METERS_PER_DEGREE = 111_320;

/**
 * Fishnet's cell size is in degrees of EPSG:4326 (the geometry's
 * SRID), not meters; we convert at SQL-emission time using the same
 * degrees-per-meter constant the read path uses elsewhere. At high
 * latitudes a degree of longitude is shorter than a degree of
 * latitude so cells aren't truly square in projection; for
 * city-to-state-scale workflows the distortion is within the cell
 * size itself.
 */

/**
 * Fishnet generator. Generates a regular grid covering each input
 * polygon's bounding box, clipped to the polygon itself. Two output
 * modes:
 *
 * - `polygons`: each grid cell becomes a polygon row. Cells that
 *   fall partially outside the input are clipped via ST_Intersection.
 *   Useful for spatial-bin / heatmap workflows.
 * - `lines`: emits the horizontal and vertical grid lines clipped
 *   to the polygon. Useful for transect / sampling-line workflows
 *   ("draw lines every 100m across this study area").
 *
 * Restricted to polygon (and multi-polygon) input. The validator
 * checks the source schema's geometryType when available; the read
 * path does ST_Intersection against whatever geometry it gets, so
 * a non-polygon input that slips through validation produces
 * empty geometry rather than an error.
 *
 * Output drops source attributes (the new rows are GRID cells, not
 * features-derived-from-input). Each row gets a `cell_row` and
 * `cell_col` attribute so downstream tools can locate and filter
 * cells positionally.
 *
 * Implementation: PostGIS 3.1+ ships ST_SquareGrid which produces
 * cells covering an input geometry's bbox. We use it directly when
 * the deployment runs PostGIS 3.1 or newer (the project's stated
 * minimum is 3.3, see infra/docker/postgres). For earlier versions
 * a generate_series fallback would be needed; we don't ship one in
 * v1 and rely on the deployment minimum.
 */
export const fishnetGenerator: ToolGenerator<FishnetParams> = {
  kind: 'fishnet',

  validate(raw: unknown, _ctx?: ToolValidateContext): FishnetParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('fishnet.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const cellSize = r.cellSize;
    if (typeof cellSize !== 'number' || !Number.isFinite(cellSize)) {
      throw new BadRequestException(
        'fishnet.params.cellSize must be a finite number',
      );
    }
    const unit = isLengthUnit(r.unit) ? r.unit : 'meters';
    const meters = metersFor(cellSize, unit);
    if (meters < MIN_CELL_METERS) {
      throw new BadRequestException(
        `fishnet.params.cellSize must be at least ${MIN_CELL_METERS} meter (got ${meters}m)`,
      );
    }
    if (meters > MAX_CELL_METERS) {
      throw new BadRequestException(
        `fishnet.params.cellSize must not exceed ${MAX_CELL_METERS} meters (got ${meters}m)`,
      );
    }
    const output = r.output === 'lines' ? 'lines' : 'polygons';
    // Schema-side geometryType validation lives one level up, in
    // the service: the recipe's source already gates polygon-only
    // sources via the picker, but a recipe arriving from an API
    // caller could specify a point/line source. We don't have
    // geometryType on FeatureField (it's a per-sublayer concept
    // on data_layer.layers). Validation is best-effort: the SQL
    // produces empty geometries for non-polygon input.
    return { cellSize, unit, output };
  },

  /**
   * Save-time safety check. ST_SquareGrid materializes cells across
   * the source's BBOX (not the polygon shape), then we filter via
   * ST_Intersects. A small cellSize on a state-sized polygon
   * generates billions of intermediate cells and fills Postgres's
   * pgsql_tmp directory. Reject the recipe up front when the
   * estimated cell count exceeds MAX_CELLS_PER_RECIPE.
   *
   * Estimation uses ST_Extent over the source's feature table, so
   * it sees the actual rendered footprint rather than guessing. For
   * sources with no rows yet, ST_Extent returns NULL and the check
   * accepts the recipe (no cells to generate yet).
   */
  async enrich(
    params: FishnetParams,
    ctx: ToolEnrichContext,
  ): Promise<FishnetParams> {
    const cellMeters = metersFor(params.cellSize, params.unit);
    if (cellMeters <= 0) return params; // already rejected by validate

    const sql = `
      WITH ext AS (
        SELECT ST_Extent(geom) AS box
        FROM ${ctx.sourceTable}
        WHERE geom IS NOT NULL
      )
      SELECT
        ST_XMin(box) AS xmin,
        ST_YMin(box) AS ymin,
        ST_XMax(box) AS xmax,
        ST_YMax(box) AS ymax
      FROM ext
    `;
    type Row = {
      xmin: number | string | null;
      ymin: number | string | null;
      xmax: number | string | null;
      ymax: number | string | null;
    };
    const rows = await ctx.queryRaw<Row>(sql);
    const ext = rows[0];
    if (!ext) return params;
    const xmin = num(ext.xmin);
    const ymin = num(ext.ymin);
    const xmax = num(ext.xmax);
    const ymax = num(ext.ymax);
    if (xmin === null || xmax === null || ymin === null || ymax === null) {
      // Empty source. Accept the recipe; cell count is zero.
      return params;
    }
    const widthMeters = Math.abs(xmax - xmin) * METERS_PER_DEGREE;
    const heightMeters = Math.abs(ymax - ymin) * METERS_PER_DEGREE;
    const cellArea = cellMeters * cellMeters;
    if (cellArea <= 0) return params;
    const estimated = (widthMeters * heightMeters) / cellArea;
    if (estimated > MAX_CELLS_PER_RECIPE) {
      throw new BadRequestException(
        `fishnet would generate roughly ${Math.round(estimated).toLocaleString()} cells covering the source's extent. Increase the cell size (current: ${cellMeters}m), or use a smaller source. The safety cap is ${MAX_CELLS_PER_RECIPE.toLocaleString()} cells.`,
      );
    }
    return params;
  },

  outputSchema(): FeatureField[] {
    // Drops source attributes; output is a grid, not derived
    // features. cell_row / cell_col give positional coords.
    return [
      {
        name: 'cell_row',
        label: 'Row',
        type: 'number',
        nullable: false,
      },
      {
        name: 'cell_col',
        label: 'Column',
        type: 'number',
        nullable: false,
      },
    ];
  },

  outwardReachMeters(): number {
    // Fishnet stays within the input polygon's bbox.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: FishnetParams, paramOffset: number) {
    const cellPh = `$${paramOffset + 1}`;
    const meters = metersFor(params.cellSize, params.unit);
    const cellDegrees = meters / METERS_PER_DEGREE;

    if (params.output === 'polygons') {
      // ST_SquareGrid(size, geom) -> setof (i, j, geom). Filter to
      // cells that actually intersect the polygon to drop the
      // bbox-only cells; ST_Intersection clips partial cells to the
      // polygon's edge for a clean visual fit.
      const sql = `
        SELECT
          gen_random_uuid()::text AS global_id,
          ST_SetSRID(
            ST_Intersection(grid.geom, ${inputAlias}.geom),
            4326
          ) AS geom,
          jsonb_build_object('cell_row', grid.j, 'cell_col', grid.i)
            AS properties
        FROM ${inputAlias},
        LATERAL ST_SquareGrid(${cellPh}, ${inputAlias}.geom) AS grid
        WHERE ${inputAlias}.geom IS NOT NULL
          AND ST_Intersects(grid.geom, ${inputAlias}.geom)
      `;
      return { sql, params: [cellDegrees] };
    }
    // Lines mode: extract the horizontal + vertical edges of every
    // grid cell, clip to the polygon, and emit each as a line. The
    // boundary of each cell is a closed ring; ST_Intersection with
    // the polygon yields a (multi)line clipped to the polygon's
    // interior. Filtering empty results drops cells that intersect
    // the polygon only at a boundary point.
    const sql = `
      SELECT
        gen_random_uuid()::text AS global_id,
        ST_SetSRID(
          ST_Intersection(ST_Boundary(grid.geom), ${inputAlias}.geom),
          4326
        ) AS geom,
        jsonb_build_object('cell_row', grid.j, 'cell_col', grid.i)
          AS properties
      FROM ${inputAlias},
      LATERAL ST_SquareGrid(${cellPh}, ${inputAlias}.geom) AS grid
      WHERE ${inputAlias}.geom IS NOT NULL
        AND ST_Intersects(grid.geom, ${inputAlias}.geom)
    `;
    return { sql, params: [cellDegrees] };
  },
};

/**
 * Coerce a JSON-shaped Postgres numeric (which may arrive as number or
 * string depending on driver settings) to a plain number, returning
 * null for unparseable / null inputs. The fishnet enrich path uses this
 * to read ST_Extent's xmin/ymin/xmax/ymax columns defensively.
 */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const parsed = Number.parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
}
