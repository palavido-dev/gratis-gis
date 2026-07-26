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

export interface EraseParams {
  otherSource: {
    kind: 'data_layer';
    itemId: string;
    layerKey?: string;
  };
}

/**
 * Erase generator (#157 Phase 2). The geometric inverse of clip:
 * keep only the parts of upstream features that fall OUTSIDE the
 * second data_layer. Useful for "every parcel except the city's
 * own", "land more than X miles from a park" (with a buffered
 * parks layer feeding in), or any other "everything except this
 * mask" workflow.
 *
 * Attributes pass through unchanged. Geometry is replaced with
 * ST_Difference(upstream.geom, ST_Union(other.geom)). Rows whose
 * entire geometry is consumed by the other layer (fully covered)
 * drop out via ST_IsEmpty.
 *
 * The other layer's geometries are pre-unioned once per query so
 * the per-row ST_Difference operates against a single geometry
 * rather than the full right-side feature set. This keeps the
 * cost at O(N + M) (N upstream rows + M right rows unioned once)
 * rather than the O(N*M) a naive per-pair ST_Difference would
 * incur.
 */
export const eraseGenerator: ToolGenerator<EraseParams> = {
  kind: 'erase',

  validate(raw: unknown): EraseParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('erase.params must be an object');
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
        'erase.params.otherSource must be { kind: "data_layer", itemId: <uuid>, layerKey?: string }',
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
    return input;
  },

  outwardReachMeters(): number {
    // Erase only ever shrinks geometry; no outward reach.
    return 0;
  },

  extractDependencies(params: EraseParams): ToolDependencies {
    return {
      itemIds: [params.otherSource.itemId],
      urls: [],
    };
  },

  toSql(inputAlias: string, params: EraseParams) {
    const right = params.otherSource;
    const rightScope = dataLayerScope(
      right.itemId,
      right.layerKey ?? 'default',
    );
    const rightCte = dataLayerSourceSqlFragment(rightScope, {
      collapseConditions: ['valid_to IS NULL'],
    });
    // ST_Difference against a possibly-NULL right_union (the right
    // layer is empty after filtering) is undefined behavior; we
    // COALESCE the union to an empty geometry so an absent right
    // side passes upstream rows through unmodified rather than
    // crashing the query.
    const sql = `
      WITH right_rows AS (${rightCte}),
      right_union AS (
        SELECT COALESCE(
          ST_Union(geom),
          ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)
        ) AS geom
        FROM right_rows
      )
      SELECT
        l.global_id,
        ST_Difference(l.geom, ru.geom) AS geom,
        l.properties
      FROM ${inputAlias} l, right_union ru
      WHERE NOT ST_IsEmpty(ST_Difference(l.geom, ru.geom))
    `;
    return { sql, params: [] };
  },
};
