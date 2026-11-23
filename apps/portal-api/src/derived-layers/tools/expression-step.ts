// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared by the Filter and Calculate field steps: checking an
 * expression at save time, recording the sources it reads, and
 * compiling it at read time.
 *
 * An expression that reads other layers stores the resolved sources
 * on the step as `dataRefs`. They are dependencies of the derived
 * layer, so the item page lists them and the read path's access check
 * covers them: a reader must be able to read each one in full, the
 * same rule as the layer's other inputs.
 */

import { BadRequestException } from '@nestjs/common';
import {
  analyzeExpression,
  collectDataRefs,
  compileExpressionSql,
  fieldRefTypeFor,
  parseExpression,
  usesDataAccess,
  type CompiledSql,
  type DataRef,
  type FeatureField,
} from '@gratis-gis/shared-types';

import type { ToolSqlContext, ToolValidateContext } from './types.js';

/** A source an expression reads, resolved when the recipe was saved. */
export interface StoredDataRef extends DataRef {
  itemId: string;
  layerId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read stored refs back, dropping anything malformed. */
export function readDataRefs(raw: unknown): StoredDataRef[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredDataRef[] = [];
  for (const r of raw.slice(0, 50) as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind !== 'related' && r.kind !== 'layer') continue;
    if (typeof r.name !== 'string' || typeof r.itemId !== 'string' || typeof r.layerId !== 'string') continue;
    if (!UUID.test(r.itemId) || r.layerId.length === 0 || r.layerId.length > 200) continue;
    const ref: StoredDataRef = { kind: r.kind, name: r.name, itemId: r.itemId, layerId: r.layerId };
    if (typeof r.sublayer === 'string') ref.sublayer = r.sublayer;
    out.push(ref);
  }
  return out;
}

/**
 * Check an expression for a step and return the refs to store.
 * `label` names the step's params in messages.
 */
export function validateStepExpression(
  expression: string,
  label: string,
  storedRefs: unknown,
  ctx?: ToolValidateContext,
): StoredDataRef[] {
  let reads = false;
  try {
    reads = usesDataAccess(parseExpression(expression));
  } catch {
    // The analysis below reports the syntax error with its position.
  }
  // Without a resolver (a read-time re-validate) a data-access
  // expression is only parsed; its sources were checked on save.
  const checkTypes = ctx?.sourceSchema !== undefined && (!reads || ctx.expressionData !== undefined);
  const analysis = analyzeExpression(expression, {
    fields: (ctx?.sourceSchema ?? []).map((f) => ({ name: f.name, type: fieldRefTypeFor(f.type) })),
    allowUnknownFields: !checkTypes,
    ...(ctx?.expressionData ? { data: ctx.expressionData } : {}),
  });
  const issues = checkTypes
    ? analysis.issues
    : analysis.ast === null
      ? analysis.issues
      : [];
  if (issues.length > 0) {
    throw new BadRequestException(
      `${label}: ${issues.map((i) => `${i.message} (at character ${i.pos + 1})`).join('; ')}`,
    );
  }
  if (!reads || !analysis.ast) return [];
  if (!ctx?.expressionData) {
    const stored = readDataRefs(storedRefs);
    // At save time (a schema is given) the sources must be resolvable.
    if (stored.length === 0 && ctx?.sourceSchema !== undefined) {
      throw new BadRequestException(
        `${label}: reading other layers is not available here`,
      );
    }
    return stored;
  }
  const refs: StoredDataRef[] = [];
  for (const ref of collectDataRefs(analysis.ast)) {
    const r =
      ref.kind === 'related'
        ? ctx.expressionData.related(ref.name)
        : ctx.expressionData.layer(ref.name, ref.sublayer);
    if ('error' in r) throw new BadRequestException(`${label}: ${r.error}`);
    refs.push({ ...ref, itemId: r.itemId, layerId: r.layerId });
  }
  return refs;
}

/** Compile a step's expression against the rows of `inputAlias`. */
export function compileStepExpression(
  expression: string,
  inputAlias: string,
  paramOffset: number,
  ctx: ToolSqlContext | undefined,
  extra: { predicate?: boolean; as?: 'number' | 'string' | 'boolean' | 'date' },
): CompiledSql {
  const schema: FeatureField[] = ctx?.inputSchema ?? [];
  return compileExpressionSql(expression, {
    fields: schema.map((f) => ({ name: f.name, type: fieldRefTypeFor(f.type) })),
    allowUnknownFields: true,
    row: {
      propertiesSql: `${inputAlias}.properties`,
      geomSql: `${inputAlias}.geom`,
      idSql: `${inputAlias}.global_id`,
    },
    paramOffset,
    ...(ctx?.timeZone ? { timeZone: ctx.timeZone } : {}),
    ...(ctx?.expressionData
      ? { data: ctx.expressionData.resolver, dataAdapter: ctx.expressionData.adapter }
      : {}),
    ...extra,
  });
}
