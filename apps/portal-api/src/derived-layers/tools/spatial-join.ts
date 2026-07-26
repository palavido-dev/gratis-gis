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
  ToolValidateContext,
} from './types.js';

export interface SpatialJoinParams {
  otherSource: {
    kind: 'data_layer';
    itemId: string;
    layerKey?: string;
  };
  predicate: 'within' | 'intersects' | 'nearest';
  nearestMaxMeters?: number;
  attributeStrategy: 'count' | 'first';
  attrsToKeep?: string[];
  attrPrefix?: string;
}

const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const MAX_ATTRS_TO_KEEP = 16;
const DEFAULT_NEAREST_MAX_METERS = 1000;
const MAX_NEAREST_MAX_METERS = 1_000_000; // 1000 km guardrail

/**
 * Spatial-join generator (#79).  Joins attributes / counts from
 * a second data_layer onto the upstream rows via a spatial
 * predicate (within / intersects / nearest).  The "other source"
 * is resolved via the engine's data_layer SQL fragment helper, so
 * we re-use the observation-log current-truth projection for both
 * sides of the join.
 *
 * The generator stays pure (no DB access) -- the right-side
 * source's SQL fragment is composed from itemId + layerKey at
 * SQL-emit time using `dataLayerSourceSqlFragment` and
 * `dataLayerScope`, both of which are pure helpers.
 *
 * NOT supported in v1:
 *   - cartesian join (every match emits a row): would explode
 *     output rows and complicate downstream tools.  Use
 *     attributeStrategy='count' to get the multiplicity instead.
 *   - derived_layer as the other source: the source kind is
 *     restricted to data_layer until the recursive engine refactor
 *     in #78 lands.
 */
export const spatialJoinGenerator: ToolGenerator<SpatialJoinParams> = {
  kind: 'spatial-join',

  validate(raw: unknown, ctx?: ToolValidateContext): SpatialJoinParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('spatial-join.params must be an object');
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
        'spatial-join.params.otherSource must be { kind: "data_layer", itemId: <uuid>, layerKey?: string }',
      );
    }
    const otherSource: SpatialJoinParams['otherSource'] = {
      kind: 'data_layer',
      itemId: other.itemId,
      ...(typeof other.layerKey === 'string' && other.layerKey.length > 0
        ? { layerKey: other.layerKey }
        : {}),
    };

    const predicate = r.predicate;
    if (
      predicate !== 'within' &&
      predicate !== 'intersects' &&
      predicate !== 'nearest'
    ) {
      throw new BadRequestException(
        "spatial-join.params.predicate must be 'within', 'intersects', or 'nearest'",
      );
    }

    let nearestMaxMeters: number | undefined;
    if (predicate === 'nearest') {
      const rawN = r.nearestMaxMeters;
      const n =
        typeof rawN === 'number' && Number.isFinite(rawN) && rawN > 0
          ? rawN
          : DEFAULT_NEAREST_MAX_METERS;
      if (n > MAX_NEAREST_MAX_METERS) {
        throw new BadRequestException(
          `spatial-join.params.nearestMaxMeters must be at most ${MAX_NEAREST_MAX_METERS} m`,
        );
      }
      nearestMaxMeters = n;
    }

    const attributeStrategy = r.attributeStrategy;
    if (attributeStrategy !== 'count' && attributeStrategy !== 'first') {
      throw new BadRequestException(
        "spatial-join.params.attributeStrategy must be 'count' or 'first'",
      );
    }

    let attrsToKeep: string[] | undefined;
    if (attributeStrategy === 'first') {
      const rawAttrs = r.attrsToKeep;
      if (!Array.isArray(rawAttrs) || rawAttrs.length === 0) {
        throw new BadRequestException(
          'spatial-join.params.attrsToKeep must be a non-empty array when attributeStrategy is "first"',
        );
      }
      if (rawAttrs.length > MAX_ATTRS_TO_KEEP) {
        throw new BadRequestException(
          `spatial-join.params.attrsToKeep supports at most ${MAX_ATTRS_TO_KEEP} attrs`,
        );
      }
      const list: string[] = [];
      for (const a of rawAttrs) {
        if (typeof a !== 'string' || !FIELD_NAME_RE.test(a)) {
          throw new BadRequestException(
            `spatial-join.params.attrsToKeep entries must match ${FIELD_NAME_RE}`,
          );
        }
        list.push(a);
      }
      attrsToKeep = list;
    }

    const attrPrefixRaw = r.attrPrefix;
    const attrPrefix =
      typeof attrPrefixRaw === 'string' && attrPrefixRaw.length > 0
        ? attrPrefixRaw
        : 'joined_';
    if (!/^[a-z_][a-z0-9_]*$/i.test(attrPrefix)) {
      throw new BadRequestException(
        'spatial-join.params.attrPrefix must match the field-name shape (letters / digits / underscore, not starting with a digit)',
      );
    }

    // Ensure none of the projected output names collide with
    // existing upstream fields.  We check via the prefix + suffix
    // pattern that toSql + outputSchema both produce.
    if (ctx?.sourceSchema) {
      const outputNames =
        attributeStrategy === 'count'
          ? [`${attrPrefix}count`]
          : (attrsToKeep ?? []).map((a) => `${attrPrefix}${a}`);
      for (const name of outputNames) {
        if (ctx.sourceSchema.some((f) => f.name === name)) {
          throw new BadRequestException(
            `spatial-join would create output column "${name}" but the upstream schema already has it; pick a different attrPrefix`,
          );
        }
      }
    }

    return {
      otherSource,
      predicate,
      ...(nearestMaxMeters !== undefined ? { nearestMaxMeters } : {}),
      attributeStrategy,
      ...(attrsToKeep !== undefined ? { attrsToKeep } : {}),
      attrPrefix,
    };
  },

  outputSchema(
    input: FeatureField[],
    params: SpatialJoinParams,
  ): FeatureField[] {
    const prefix = params.attrPrefix ?? 'joined_';
    if (params.attributeStrategy === 'count') {
      const name = `${prefix}count`;
      return [
        ...input,
        { name, label: name, type: 'number', nullable: false },
      ];
    }
    const extra = (params.attrsToKeep ?? []).map((a) => ({
      name: `${prefix}${a}`,
      label: `${prefix}${a}`,
      type: 'string' as const,
      nullable: true,
    }));
    return [...input, ...extra];
  },

  outwardReachMeters(params: SpatialJoinParams): number {
    // 'nearest' could pull in features up to nearestMaxMeters away
    // from the upstream geometries.  For the bbox-padding pass on
    // the read path this affects only how widely the SOURCE side
    // (left = upstream) is fetched; the right side is a separate
    // CTE that the join SQL queries inline.  Be conservative.
    if (params.predicate === 'nearest') {
      return params.nearestMaxMeters ?? DEFAULT_NEAREST_MAX_METERS;
    }
    return 0;
  },

  extractDependencies(params: SpatialJoinParams): ToolDependencies {
    return {
      itemIds: [params.otherSource.itemId],
      urls: [],
    };
  },

  toSql(inputAlias: string, params: SpatialJoinParams, paramOffset: number) {
    const sqlParams: unknown[] = [];
    const right = params.otherSource;
    const rightScope = dataLayerScope(
      right.itemId,
      right.layerKey ?? 'default',
    );
    // Materialize the right side via the same engine projection
    // the source CTE uses.  We don't apply temporal / bbox /
    // boundary filters here because the join's role is "look up
    // matches for each left geometry"; the upstream filters limit
    // the LEFT side, and matching right features outside that bbox
    // are still valid join targets.
    const rightCte = dataLayerSourceSqlFragment(rightScope, {
      collapseConditions: ['valid_to IS NULL'],
    });

    const prefix = params.attrPrefix ?? 'joined_';

    // Predicate SQL fragment.  ST_Intersects is the cheap shared-
    // edges-or-overlap predicate; ST_Within tightens it to fully-
    // contained-in; ST_DWithin (geography) gives meter-based
    // distance for 'nearest'.
    let joinPredicate: string;
    if (params.predicate === 'within') {
      joinPredicate = 'ST_Within(l.geom, r.geom)';
    } else if (params.predicate === 'intersects') {
      joinPredicate = 'ST_Intersects(l.geom, r.geom)';
    } else {
      // nearest: dwithin in geography meters
      const meters = params.nearestMaxMeters ?? DEFAULT_NEAREST_MAX_METERS;
      sqlParams.push(meters);
      joinPredicate = `ST_DWithin(l.geom::geography, r.geom::geography, $${
        paramOffset + sqlParams.length
      })`;
    }

    let joinedExpr: string;
    if (params.attributeStrategy === 'count') {
      sqlParams.push(`${prefix}count`);
      const keyPh = `$${paramOffset + sqlParams.length}`;
      joinedExpr = `
        jsonb_build_object(
          ${keyPh},
          (SELECT COUNT(*) FROM right_rows r WHERE ${joinPredicate})
        )
      `;
    } else {
      const attrs = params.attrsToKeep ?? [];
      // Order matters: prefer nearest by distance when the predicate
      // is 'nearest' so the picked right row is the geographically
      // closest; otherwise fall back to a deterministic id sort so
      // repeated reads of the same recipe yield identical results.
      const orderClause =
        params.predicate === 'nearest'
          ? 'ORDER BY ST_Distance(l.geom::geography, r.geom::geography) ASC'
          : 'ORDER BY r.global_id ASC';
      // jsonb_build_object pairs: alternating output key + the
      // right-side value pulled from r.properties (the right CTE
      // exposes properties as the legacy column name; see
      // dataLayerSourceSqlFragment).
      const pairFragments = attrs.map((a) => {
        sqlParams.push(`${prefix}${a}`);
        const keyPh = `$${paramOffset + sqlParams.length}`;
        const safeRightCol = a.replace(/'/g, "''");
        return `${keyPh}, r.properties->>'${safeRightCol}'`;
      });
      joinedExpr = `
        COALESCE(
          (
            SELECT jsonb_build_object(${pairFragments.join(', ')})
            FROM right_rows r
            WHERE ${joinPredicate}
            ${orderClause}
            LIMIT 1
          ),
          '{}'::jsonb
        )
      `;
    }

    const sql = `
      WITH right_rows AS (${rightCte})
      SELECT
        l.global_id,
        l.geom,
        l.properties || ${joinedExpr} AS properties
      FROM ${inputAlias} l
    `;

    return { sql, params: sqlParams };
  },
};
