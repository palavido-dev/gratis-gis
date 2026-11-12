// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type {
  AggOp,
  AggregateAggregation,
  FeatureField,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';
import { numericTextSql } from './numeric-text.js';

export interface AggregateParams {
  groupBy: string[];
  aggs: AggregateAggregation[];
}

const VALID_OPS: ReadonlySet<AggOp> = new Set<AggOp>([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'first',
]);
const MAX_GROUP_KEYS = 8;
const MAX_AGGS = 16;
const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Group-by aggregation generator (#80).  Generalizes dissolve: the
 * upstream rows collapse to one feature per distinct combination of
 * groupBy values (or a single feature when groupBy is empty), with
 * geometry = ST_Union of the input geoms in each group and one
 * attribute per `agg` entry.
 *
 * SQL shape:
 *
 *   SELECT
 *     gen_random_uuid()::text AS global_id,
 *     ST_Union(geom) AS geom,
 *     jsonb_build_object(
 *       'group_col_1', properties->>'group_col_1',
 *       'output_name_1', SUM((properties->>'src')::double precision),
 *       ...
 *     ) AS properties
 *   FROM input
 *   GROUP BY properties->>'group_col_1', ...
 *
 * The grouping keys land in the output JSONB as their original
 * column names (typed as upstream); aggregation results land
 * under their declared outputName as the SQL function's return
 * type (numeric for sum/avg/min/max, integer for count, original
 * type for first).
 */
export const aggregateGenerator: ToolGenerator<AggregateParams> = {
  kind: 'aggregate',

  validate(raw: unknown, ctx?: ToolValidateContext): AggregateParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('aggregate.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const groupByRaw = r.groupBy;
    if (!Array.isArray(groupByRaw)) {
      throw new BadRequestException(
        'aggregate.params.groupBy must be an array of upstream field names',
      );
    }
    if (groupByRaw.length > MAX_GROUP_KEYS) {
      throw new BadRequestException(
        `aggregate.params.groupBy supports at most ${MAX_GROUP_KEYS} keys`,
      );
    }
    const groupBy: string[] = [];
    for (const k of groupByRaw) {
      if (typeof k !== 'string' || !FIELD_NAME_RE.test(k)) {
        throw new BadRequestException(
          `aggregate.params.groupBy entries must match ${FIELD_NAME_RE} (got "${String(k)}")`,
        );
      }
      if (ctx?.sourceSchema) {
        if (!ctx.sourceSchema.find((f) => f.name === k)) {
          throw new BadRequestException(
            `aggregate.params.groupBy: field "${k}" does not exist on the upstream schema`,
          );
        }
      }
      groupBy.push(k);
    }

    const aggsRaw = r.aggs;
    if (!Array.isArray(aggsRaw)) {
      throw new BadRequestException(
        'aggregate.params.aggs must be an array of aggregations',
      );
    }
    if (aggsRaw.length > MAX_AGGS) {
      throw new BadRequestException(
        `aggregate.params.aggs supports at most ${MAX_AGGS} aggregations`,
      );
    }
    const aggs: AggregateAggregation[] = [];
    const seenOutputs = new Set<string>(groupBy);
    for (const a of aggsRaw) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        throw new BadRequestException(
          'aggregate.params.aggs entries must be objects',
        );
      }
      const ar = a as Record<string, unknown>;
      const op = ar.op;
      if (typeof op !== 'string' || !VALID_OPS.has(op as AggOp)) {
        throw new BadRequestException(
          `aggregate.params.aggs: op must be one of ${[...VALID_OPS].join(', ')} (got "${String(op)}")`,
        );
      }
      const outputName = ar.outputName;
      if (typeof outputName !== 'string' || !FIELD_NAME_RE.test(outputName)) {
        throw new BadRequestException(
          `aggregate.params.aggs.outputName must match ${FIELD_NAME_RE}`,
        );
      }
      if (seenOutputs.has(outputName)) {
        throw new BadRequestException(
          `aggregate.params.aggs.outputName "${outputName}" collides with a groupBy column or another aggregation`,
        );
      }
      seenOutputs.add(outputName);
      const fieldRaw = ar.field;
      const field =
        typeof fieldRaw === 'string' ? fieldRaw : '';
      if (op !== 'count') {
        if (!field) {
          throw new BadRequestException(
            `aggregate.params.aggs: op "${op}" requires a field`,
          );
        }
        if (!FIELD_NAME_RE.test(field)) {
          throw new BadRequestException(
            `aggregate.params.aggs.field "${field}" must match ${FIELD_NAME_RE}`,
          );
        }
        if (ctx?.sourceSchema) {
          const f = ctx.sourceSchema.find((x) => x.name === field);
          if (!f) {
            throw new BadRequestException(
              `aggregate.params.aggs: field "${field}" does not exist on the upstream schema`,
            );
          }
          if (
            (op === 'sum' || op === 'avg' || op === 'min' || op === 'max') &&
            f.type !== 'number'
          ) {
            throw new BadRequestException(
              `aggregate.params.aggs: op "${op}" needs a numeric field (got ${f.type} on "${field}")`,
            );
          }
        }
      }
      aggs.push({ field, op: op as AggOp, outputName });
    }
    return { groupBy, aggs };
  },

  outputSchema(
    input: FeatureField[],
    params: AggregateParams,
  ): FeatureField[] {
    const out: FeatureField[] = [];
    for (const g of params.groupBy) {
      const src = input.find((f) => f.name === g);
      out.push(
        src
          ? { ...src }
          : { name: g, label: g, type: 'string', nullable: true },
      );
    }
    for (const a of params.aggs) {
      const src = input.find((f) => f.name === a.field);
      const type: FeatureField['type'] =
        a.op === 'first' ? src?.type ?? 'string' : 'number';
      out.push({
        name: a.outputName,
        label: a.outputName,
        type,
        nullable: a.op === 'first' || a.op === 'avg' || a.op === 'sum',
      });
    }
    return out;
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: AggregateParams, paramOffset: number) {
    const sqlParams: unknown[] = [];
    function pushParam(v: unknown): string {
      sqlParams.push(v);
      return `$${paramOffset + sqlParams.length}`;
    }

    // Build the property pairs for jsonb_build_object.  Groups come
    // first (with their original column names), then aggregations.
    // Keys are cast to text: the function takes VARIADIC "any", so an
    // untyped key parameter fails to plan under the pg driver.
    const pairs: string[] = [];
    for (const g of params.groupBy) {
      const key = pushParam(g);
      // properties->>'g' grouped + selected.
      const colSafe = g.replace(/'/g, "''");
      pairs.push(`${key}::text, properties->>'${colSafe}'`);
    }
    for (const a of params.aggs) {
      const key = pushParam(a.outputName);
      let expr: string;
      const fieldSafe = a.field.replace(/'/g, "''");
      switch (a.op) {
        case 'count':
          expr = 'COUNT(*)';
          break;
        case 'sum':
          expr = `SUM(${numericTextSql(`(properties->>'${fieldSafe}')`)})`;
          break;
        case 'avg':
          expr = `AVG(${numericTextSql(`(properties->>'${fieldSafe}')`)})`;
          break;
        case 'min':
          expr = `MIN(${numericTextSql(`(properties->>'${fieldSafe}')`)})`;
          break;
        case 'max':
          expr = `MAX(${numericTextSql(`(properties->>'${fieldSafe}')`)})`;
          break;
        case 'first':
          // Deterministic "any value from the group": the one
          // with the lowest global_id, which is stable across reads.
          expr = `(ARRAY_AGG(properties->>'${fieldSafe}' ORDER BY global_id))[1]`;
          break;
      }
      pairs.push(`${key}::text, ${expr}`);
    }

    const groupByClause =
      params.groupBy.length > 0
        ? 'GROUP BY ' +
          params.groupBy
            .map((g) => `properties->>'${g.replace(/'/g, "''")}'`)
            .join(', ')
        : '';

    const propsExpr =
      pairs.length > 0
        ? `jsonb_build_object(${pairs.join(', ')})`
        : `'{}'::jsonb`;

    const sql = `
      SELECT
        gen_random_uuid()::text AS global_id,
        ST_Union(geom) AS geom,
        ${propsExpr} AS properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
      ${groupByClause}
    `;
    return { sql, params: sqlParams };
  },
};
