// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../../engine/data-layer.js';
import type {
  ToolDependencies,
  ToolGenerator,
} from './types.js';

export interface ClipParams {
  otherSource: {
    kind: 'data_layer';
    itemId: string;
    layerKey?: string;
  };
}

/**
 * Clip generator (#157 Phase 2). Cookie-cutters the upstream
 * features by a second data_layer: only the parts of upstream
 * geometries that fall inside the other layer survive, and the
 * output geometry is the trimmed intersection piece. Upstream
 * features with no overlap drop out entirely.
 *
 * Attributes pass through unchanged from the upstream side.
 * Geometry is replaced with the clipped piece. Rows whose
 * post-intersection geometry has zero usable area / length are
 * dropped via ST_IsEmpty, so a feature that lies entirely on a
 * shared border (line-on-line touch) doesn't artificially survive.
 *
 * SQL strategy:
 *   - the second layer is materialized as a CTE via the engine's
 *     dataLayerSourceSqlFragment (same projection as the upstream
 *     CTE, so we get the observation-log current-truth view).
 *   - the second layer's geometry is collapsed to a single
 *     polygon via ST_Union(right.geom). Done once per query rather
 *     than per upstream row.
 *   - each upstream row gets ST_Intersection(left.geom, right_union).
 *   - results filter on NOT ST_IsEmpty so zero-area boundary hits
 *     don't pass through.
 *
 * This pre-unions design means clip is O(N + M) at PostGIS
 * planning time (N upstream rows, M right rows pre-unioned once)
 * rather than the O(N*M) a naive per-row ST_Intersection +
 * ST_Intersects would produce.
 */
export const clipGenerator: ToolGenerator<ClipParams> = {
  kind: 'clip',

  validate(raw: unknown): ClipParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('clip.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const other = r.otherSource as Record<string, unknown> | undefined;
    if (
      !other ||
      other.kind !== 'data_layer' ||
      typeof other.itemId !== 'string' ||
      other.itemId.length === 0
    ) {
      throw new BadRequestException(
        'clip.params.otherSource must be { kind: "data_layer", itemId: <uuid>, layerKey?: string }',
      );
    }
    return {
      otherSource: {
        kind: 'data_layer',
        itemId: other.itemId,
        ...(typeof other.layerKey === 'string' && other.layerKey.length > 0
          ? { layerKey: other.layerKey }
          : {}),
      },
    };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Clip is geometry-only; attributes pass through unchanged.
    return input;
  },

  outwardReachMeters(): number {
    // Clip narrows geometry; it never reaches outside the source.
    return 0;
  },

  extractDependencies(params: ClipParams): ToolDependencies {
    return {
      itemIds: [params.otherSource.itemId],
      urls: [],
    };
  },

  toSql(inputAlias: string, params: ClipParams) {
    const right = params.otherSource;
    const rightScope = dataLayerScope(
      right.itemId,
      right.layerKey ?? 'default',
    );
    // Read the right side through the same engine projection used
    // for upstream CTEs. valid_to IS NULL gives the current-truth
    // view; no temporal / bbox filter applies because the
    // intersection operates on the layer as a whole footprint.
    const rightCte = dataLayerSourceSqlFragment(rightScope, {
      collapseConditions: ['valid_to IS NULL'],
    });
    const sql = `
      WITH right_rows AS (${rightCte}),
      right_union AS (
        SELECT ST_Union(geom) AS geom FROM right_rows
      )
      SELECT
        l.global_id,
        ST_Intersection(l.geom, ru.geom) AS geom,
        l.properties
      FROM ${inputAlias} l, right_union ru
      WHERE ST_Intersects(l.geom, ru.geom)
        AND NOT ST_IsEmpty(ST_Intersection(l.geom, ru.geom))
    `;
    return { sql, params: [] };
  },
};
