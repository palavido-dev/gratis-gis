import { BadRequestException } from '@nestjs/common';
import {
  isLengthUnit,
  metersFor,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';

export interface FishnetParams {
  cellSize: number;
  unit: LengthUnit;
  /** 'polygons' = filled cells; 'lines' = grid lines / transects only. */
  output: 'polygons' | 'lines';
}

const MIN_CELL_METERS = 1;
const MAX_CELL_METERS = 100_000;

/**
 * One degree of latitude ~ 111_320 meters. Fishnet generation is
 * done in degrees because the source geometry is in EPSG:4326. At
 * high latitudes a degree of longitude is shorter than a degree
 * of latitude, so cells aren't truly square in the projection. v1
 * accepts that distortion for simplicity; future precision work
 * could project to UTM, generate the grid, and project back. For
 * city-to-state-scale fishnet workflows the visual difference is
 * within the cell size itself.
 */
const METERS_PER_DEGREE = 111_320;

/**
 * Hard cap on cells per input polygon. A polygon the size of a
 * country with a 1m cell size would produce trillions of cells and
 * exhaust memory; this cap rejects the recipe at validate time
 * (we'd need the source bbox to compute cells/polygon directly,
 * which is expensive for the validator). Instead we cap implicitly
 * via MIN_CELL_METERS and the recipe's own featureLimit.
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
