// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { fromGlobalId, type EsriField, type EsriLayerSchema } from './esri-fields.js';
import type { CmpOp, WhereField, WhereLiteral, WhereNode } from './esri-where.js';

/**
 * SQL for the FeatureServer query. Every fragment here reads the
 * columns of one current-state row: `oid` (bigint), `entity` (uuid)
 * and `attrs` (jsonb). Field names reach SQL only as bound jsonb keys,
 * after they were matched against the layer's schema; values are
 * always bound parameters. Comparisons use standard SQL semantics
 * (`<>` does not match a missing value), as Esri clients expect.
 */

function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

export function lookupField(schema: EsriLayerSchema, name: string): EsriField {
  const f = schema.byLower.get(name.toLowerCase());
  if (!f) throw bad(`The layer has no field named "${name}".`);
  return f;
}

const DATE_SHAPE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}';

/** The SQL value of a field, typed for comparison and sorting. */
export function fieldExpr(f: EsriField): Prisma.Sql {
  if (f.kind === 'oid') return Prisma.sql`oid`;
  if (f.kind === 'globalid') return Prisma.sql`entity`;
  const key = f.attr!;
  const text = Prisma.sql`(attrs->>${key})`;
  switch (f.kind) {
    case 'integer':
    case 'double':
      return Prisma.sql`(CASE WHEN pg_input_is_valid(attrs->>${key}, 'double precision') THEN (attrs->>${key})::double precision END)`;
    case 'date':
      return Prisma.sql`(CASE WHEN attrs->>${key} ~ ${DATE_SHAPE} AND pg_input_is_valid(attrs->>${key}, 'timestamptz') THEN (attrs->>${key})::timestamptz END)`;
    case 'boolean':
      return Prisma.sql`(CASE attrs->>${key} WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)`;
    default:
      return text;
  }
}

function numberOf(l: WhereLiteral, f: EsriField): number {
  const n = l.kind === 'number' ? l.value : l.kind === 'string' ? Number(l.value) : NaN;
  if (!Number.isFinite(n) || (l.kind === 'string' && l.value.trim() === '')) {
    throw bad(`${f.name} is a number field; compare it with a number.`);
  }
  return n;
}

function dateOf(l: WhereLiteral, f: EsriField): string {
  const ms = l.kind === 'number' ? l.value : Date.parse(l.value);
  if (!Number.isFinite(ms)) throw bad(`${f.name} is a date field; "${String(l.value)}" is not a date.`);
  return new Date(ms).toISOString();
}

/** A literal bound for comparison with field `f`. */
function valueFor(f: EsriField, l: WhereLiteral, fn?: 'upper' | 'lower'): Prisma.Sql {
  switch (f.kind) {
    case 'oid':
    case 'integer':
    case 'double':
    case 'boolean':
      return Prisma.sql`${numberOf(l, f)}`;
    case 'date':
      return Prisma.sql`${dateOf(l, f)}::timestamptz`;
    case 'globalid': {
      const id = l.kind === 'string' ? fromGlobalId(l.value) : null;
      if (!id) throw bad(`${f.name} values look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.`);
      return Prisma.sql`${id}::uuid`;
    }
    default: {
      const s = String(l.value);
      return Prisma.sql`${fn === 'upper' ? s.toUpperCase() : fn === 'lower' ? s.toLowerCase() : s}`;
    }
  }
}

function operand(schema: EsriLayerSchema, ref: WhereField): { f: EsriField; expr: Prisma.Sql } {
  const f = lookupField(schema, ref.name);
  if (f.kind === 'multi') {
    throw bad(`${f.name} holds several choices; only "${f.name} IS NULL" and "IS NOT NULL" work on it.`);
  }
  if (ref.fn) {
    if (f.kind !== 'string') throw bad(`${ref.fn.toUpperCase()}() works on text fields only.`);
    const fn = ref.fn === 'upper' ? Prisma.sql`upper` : Prisma.sql`lower`;
    return { f, expr: Prisma.sql`${fn}(${fieldExpr(f)})` };
  }
  return { f, expr: fieldExpr(f) };
}

const OPS: Record<CmpOp, Prisma.Sql> = {
  '=': Prisma.sql`=`,
  '<>': Prisma.sql`<>`,
  '<': Prisma.sql`<`,
  '<=': Prisma.sql`<=`,
  '>': Prisma.sql`>`,
  '>=': Prisma.sql`>=`,
};

/** Compile a parsed where clause to a boolean SQL expression. */
export function compileWhere(node: WhereNode, schema: EsriLayerSchema): Prisma.Sql {
  switch (node.t) {
    case 'const':
      return node.value ? Prisma.sql`TRUE` : Prisma.sql`FALSE`;
    case 'and':
      return Prisma.sql`(${Prisma.join(node.items.map((n) => compileWhere(n, schema)), ' AND ')})`;
    case 'or':
      return Prisma.sql`(${Prisma.join(node.items.map((n) => compileWhere(n, schema)), ' OR ')})`;
    case 'not':
      return Prisma.sql`(NOT ${compileWhere(node.item, schema)})`;
    case 'null': {
      const f = lookupField(schema, node.field.name);
      if (f.kind === 'oid' || f.kind === 'globalid') {
        return node.negated ? Prisma.sql`TRUE` : Prisma.sql`FALSE`;
      }
      const expr = f.kind === 'multi' ? Prisma.sql`(attrs->${f.attr!})` : fieldExpr(f);
      const test =
        f.kind === 'multi'
          ? Prisma.sql`(${expr} IS NULL OR ${expr} = 'null'::jsonb OR ${expr} = '[]'::jsonb)`
          : Prisma.sql`(${expr} IS NULL)`;
      return node.negated ? Prisma.sql`(NOT ${test})` : test;
    }
    case 'cmp': {
      const { f, expr } = operand(schema, node.field);
      if (f.kind === 'globalid' && node.op !== '=' && node.op !== '<>') {
        throw bad(`${f.name} can only be compared with = or <>.`);
      }
      return Prisma.sql`(${expr} ${OPS[node.op]} ${valueFor(f, node.value, node.field.fn)})`;
    }
    case 'in': {
      const { f, expr } = operand(schema, node.field);
      const list = Prisma.join(node.values.map((v) => valueFor(f, v, node.field.fn)));
      return node.negated
        ? Prisma.sql`(${expr} NOT IN (${list}))`
        : Prisma.sql`(${expr} IN (${list}))`;
    }
    case 'between': {
      const { f, expr } = operand(schema, node.field);
      if (f.kind === 'globalid') throw bad(`${f.name} cannot be used with BETWEEN.`);
      const lo = valueFor(f, node.lo, node.field.fn);
      const hi = valueFor(f, node.hi, node.field.fn);
      return node.negated
        ? Prisma.sql`(${expr} NOT BETWEEN ${lo} AND ${hi})`
        : Prisma.sql`(${expr} BETWEEN ${lo} AND ${hi})`;
    }
    case 'like': {
      const { f, expr } = operand(schema, node.field);
      if (f.kind !== 'string') throw bad(`LIKE works on text fields only; ${f.name} is not one.`);
      const not = node.negated ? Prisma.sql`NOT ` : Prisma.empty;
      return node.escape
        ? Prisma.sql`(${expr} ${not}LIKE ${node.pattern} ESCAPE ${node.escape})`
        : Prisma.sql`(${expr} ${not}LIKE ${node.pattern})`;
    }
  }
}

export interface OrderTerm {
  field: EsriField;
  desc: boolean;
}

/** `orderByFields`, e.g. `STATUS ASC, OBJECTID DESC`. */
export function parseOrderBy(raw: string | undefined, schema: EsriLayerSchema): OrderTerm[] {
  const out: OrderTerm[] = [];
  if (!raw || raw.trim() === '') return out;
  for (const part of raw.split(',')) {
    const words = part.trim().split(/\s+/);
    const dir = words.length === 2 ? words[1]!.toUpperCase() : 'ASC';
    let name = words[0] ?? '';
    if (name.length > 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    if (
      words.length > 2 ||
      (dir !== 'ASC' && dir !== 'DESC') ||
      !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)
    ) {
      throw bad(`orderByFields: "${part.trim()}" is not a field name followed by ASC or DESC.`);
    }
    const field = lookupField(schema, name);
    if (field.kind === 'multi') throw bad(`orderByFields: ${field.name} cannot be sorted.`);
    out.push({ field, desc: dir === 'DESC' });
  }
  return out;
}

/** ORDER BY for a feature page: the requested terms, then ObjectID. */
export function orderBySql(terms: OrderTerm[]): Prisma.Sql {
  const parts = terms.map((t) =>
    t.desc ? Prisma.sql`${fieldExpr(t.field)} DESC NULLS LAST` : Prisma.sql`${fieldExpr(t.field)} ASC NULLS LAST`,
  );
  if (!terms.some((t) => t.field.kind === 'oid')) parts.push(Prisma.sql`oid ASC`);
  return Prisma.join(parts, ', ');
}
