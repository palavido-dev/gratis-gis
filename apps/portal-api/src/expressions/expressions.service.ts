// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';
import {
  analyzeExpression,
  collectDataRefs,
  compileChecked,
  parseExpression,
  ExpressionError,
  usesDataAccess,
  walkExpr,
  type CheckResult,
  type ExpressionIssue,
  type ValueType,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { publicTierGeoLimit } from '../public/public-geo-limit.js';
import {
  observationAdapter,
  prepareExpressionData,
  readExpressionLayers,
  relatedLayersOf,
  sourceAccessFor,
  type ExpressionLayer,
  type ItemWithShares,
  type PreparedData,
  type SourceAccess,
} from './expression-data.js';
import { expressionTimeZone } from './time-zone.js';
import { expressionSqlFragment, type TileComputed } from '../engine/data-layer.js';
import { createHash } from 'node:crypto';

/** Caller-chosen expression keys: no __proto__ and friends. */
export const EXPRESSION_KEY_RE = /^(?!__)[A-Za-z0-9_.-]{1,100}$/;

/** Most rows one evaluate call returns. */
export const MAX_EVALUATE_ROWS = 50;
/** Most expressions one call evaluates (a popup's worth). */
export const MAX_EVALUATE_EXPRESSIONS = 20;
/** Per-statement limit for expression reads, so one slow expression cannot pile up. */
export const EXPRESSION_STATEMENT_TIMEOUT = '15s';

export interface EvaluateResult {
  /** One entry per expression, in request order: its type and problems. */
  expressions: Array<{ key: string; type: ValueType | null; issues: ExpressionIssue[] }>;
  /** One entry per feature; `values` follows `expressions`' order. */
  rows: Array<{ id: string; values: unknown[] }>;
}

export interface CompiledForLayer {
  /** SQL per expression key, already converted for output. */
  columns: Record<string, string>;
  params: unknown[];
}

/**
 * Evaluates expressions on the server, where data access works:
 * previews in the expression builder, popups, and the attribute
 * table's Calculate field.
 */
@Injectable()
export class ExpressionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  /** The layer, or 404. */
  layerOf(item: Pick<Item, 'data'>, layerId: string): ExpressionLayer {
    const layer = readExpressionLayers(item.data).find((l) => l.id === layerId);
    if (!layer) throw new NotFoundException('Layer not found');
    return layer;
  }

  async prepare(
    viewer: AuthUser | null,
    item: ItemWithShares,
    layerId: string,
    sources: string[],
    mode: 'viewer' | 'shared' = 'viewer',
  ): Promise<{ data: PreparedData; outer: SourceAccess }> {
    const layer = this.layerOf(item, layerId);
    const access = await sourceAccessFor(
      { sharing: this.sharing, viewer, mode, publicGeoLimit: (i) => this.publicClip(i) },
      item,
      layer,
    );
    if (typeof access === 'string') throw new NotFoundException('Layer not found');
    const refs = sources.flatMap((src) => {
      try {
        return collectDataRefs(parseExpression(src));
      } catch {
        return [];
      }
    });
    const data = await prepareExpressionData({
      prisma: this.prisma,
      sharing: this.sharing,
      viewer,
      item,
      layerId,
      refs,
      mode,
      publicGeoLimit: (i) => this.publicClip(i),
    });
    return { data, outer: access };
  }

  private async publicClip(item: Item): Promise<unknown | null> {
    return (await publicTierGeoLimit(this.prisma, (item as { publicGeoBoundaryId?: string | null }).publicGeoBoundaryId)) ?? null;
  }

  /** Type-check one expression against a layer, with its sources resolved. */
  analyze(layer: ExpressionLayer, src: string, data: PreparedData) {
    return analyzeExpression(src, { fields: layer.fields, data: data.resolver });
  }

  /**
   * Evaluate expressions for some features of a layer the viewer can
   * read. `featureIds` picks features; without it, the first rows by
   * id are used (a preview).
   */
  async evaluate(args: {
    viewer: AuthUser | null;
    item: ItemWithShares;
    layerId: string;
    expressions: Record<string, string>;
    featureIds?: string[];
    limit?: number;
  }): Promise<EvaluateResult> {
    const keys = Object.keys(args.expressions);
    if (keys.length === 0) throw new BadRequestException('Send at least one expression');
    // Keys come from the caller and become property names below.
    if (keys.some((k) => !EXPRESSION_KEY_RE.test(k))) {
      throw new BadRequestException('Expression keys are letters, digits, dot, dash and underscore');
    }
    if (keys.length > MAX_EVALUATE_EXPRESSIONS) {
      throw new BadRequestException(`At most ${MAX_EVALUATE_EXPRESSIONS} expressions per request`);
    }
    const layer = this.layerOf(args.item, args.layerId);
    const { data, outer } = await this.prepare(args.viewer, args.item, args.layerId, Object.values(args.expressions));
    const result: EvaluateResult = { expressions: [], rows: [] };
    const good: Array<{ index: number; checked: CheckResult; ast: ReturnType<typeof parseExpression> }> = [];
    keys.forEach((key, index) => {
      const a = this.analyze(layer, args.expressions[key]!, data);
      result.expressions.push({ key, type: a.type, issues: a.issues });
      if (a.ast && a.checked && a.issues.length === 0) good.push({ index, checked: a.checked, ast: a.ast });
    });
    if (good.length === 0) return result;

    const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_EVALUATE_ROWS);
    const ids = (args.featureIds ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, MAX_EVALUATE_ROWS);
    const params: unknown[] = [];
    const bind = (v: unknown, cast: string) => {
      params.push(v);
      return `$${params.length}::${cast}`;
    };
    const outerKey = `${args.item.id}/${args.layerId}`;
    const outerSource = {
      key: outerKey,
      label: args.item.title,
      fields: layer.fields,
      hasGeometry: layer.geometryType !== null,
      itemId: args.item.id,
      layerId: args.layerId,
    };
    const outerSql = observationAdapter(new Map([[outerKey, outer]])).rowsSql(
      outerSource,
      { conditions: ids.length > 0 ? [`entity = ANY(${bind(ids, 'uuid[]')})`] : [] },
      bind,
    );
    const timeZone = await expressionTimeZone(this.prisma, args.item.orgId);
    const columns: string[] = [];
    for (let k = 0; k < good.length; k += 1) {
      const g = good[k]!;
      try {
        const c = compileChecked(g.ast, g.checked, {
          row: { propertiesSql: 'o.properties', geomSql: 'o.geom', idSql: 'o.global_id' },
          paramOffset: params.length,
          timeZone,
          dataAdapter: data.adapter,
        });
        params.push(...c.params);
        columns.push(`${c.type === 'date' ? `gg_expr_ts_text(${c.sql})` : c.sql} AS v${k}`);
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        result.expressions[g.index]!.issues.push({ message: e.message, pos: e.pos });
        columns.push(`NULL AS v${k}`);
      }
    }
    const sql = `SELECT o.global_id::text AS id, ${columns.join(', ')}
      FROM (${outerSql}) o
      ORDER BY o.global_id
      LIMIT ${ids.length > 0 ? ids.length : limit}`;
    const rows = await this.runBounded<Record<string, unknown>>(sql, params);
    result.rows = rows.map((r) => {
      const values: unknown[] = keys.map(() => null);
      good.forEach((g, k) => {
        values[g.index] = normalize(r[`v${k}`]);
      });
      return { id: String(r.id), values };
    });
    return result;
  }

  /**
   * One expression for many features, for Calculate field when the
   * expression reads other rows. Values come back converted to `as`,
   * keyed by feature id. Throws BadRequest with the first problem.
   */
  async valuesForFeatures(args: {
    viewer: AuthUser;
    item: ItemWithShares;
    layerId: string;
    expression: string;
    ids: string[];
    as: 'number' | 'string' | 'boolean' | 'date';
  }): Promise<Map<string, unknown>> {
    const layer = this.layerOf(args.item, args.layerId);
    const { data, outer } = await this.prepare(args.viewer, args.item, args.layerId, [args.expression]);
    const a = this.analyze(layer, args.expression, data);
    if (!a.ast || !a.checked || a.issues.length > 0) {
      throw new BadRequestException(
        `expression: ${a.issues.map((i) => `${i.message} (at character ${i.pos + 1})`).join('; ')}`,
      );
    }
    const timeZone = await expressionTimeZone(this.prisma, args.item.orgId);
    const out = new Map<string, unknown>();
    const outerKey = `${args.item.id}/${args.layerId}`;
    const outerSource = {
      key: outerKey,
      label: args.item.title,
      fields: layer.fields,
      hasGeometry: layer.geometryType !== null,
      itemId: args.item.id,
      layerId: args.layerId,
    };
    for (let k = 0; k < args.ids.length; k += 500) {
      const chunk = args.ids.slice(k, k + 500);
      const params: unknown[] = [];
      const bind = (v: unknown, cast: string) => {
        params.push(v);
        return `$${params.length}::${cast}`;
      };
      const outerSql = observationAdapter(new Map([[outerKey, outer]])).rowsSql(
        outerSource,
        { conditions: [`entity = ANY(${bind(chunk, 'uuid[]')})`] },
        bind,
      );
      let c;
      try {
        c = compileChecked(a.ast, a.checked, {
          row: { propertiesSql: 'o.properties', geomSql: 'o.geom', idSql: 'o.global_id' },
          paramOffset: params.length,
          timeZone,
          dataAdapter: data.adapter,
          as: args.as,
        });
      } catch (e) {
        if (e instanceof ExpressionError) throw new BadRequestException(`expression: ${e.message}`);
        throw e;
      }
      params.push(...c.params);
      const value = args.as === 'date' ? `gg_expr_ts_text(${c.sql})` : c.sql;
      const rows = await this.runBounded<{ id: string; v: unknown }>(
        `SELECT o.global_id::text AS id, ${value} AS v FROM (${outerSql}) o`,
        params,
        '120s',
      );
      for (const r of rows) out.set(r.id, normalize(r.v));
    }
    return out;
  }

  /**
   * Expression fields for a vector tile: one SQL column per
   * expression that checks, read against the tile query's `currents`
   * rows. An expression with a mistake is left out (its property is
   * simply absent), so one broken label does not blank the layer.
   */
  async tileComputed(
    viewer: AuthUser | null,
    item: ItemWithShares,
    layerId: string,
    exprs: Array<{ name: string; expression: string }>,
  ): Promise<TileComputed | null> {
    if (exprs.length === 0) return null;
    const layer = this.layerOf(item, layerId);
    const { data } = await this.prepare(viewer, item, layerId, exprs.map((e) => e.expression));
    const timeZone = await expressionTimeZone(this.prisma, item.orgId);
    const columns: TileComputed['columns'] = [];
    let reads = false;
    let clock = false;
    for (const e of exprs) {
      const a = this.analyze(layer, e.expression, data);
      if (!a.ast || !a.checked || a.issues.length > 0) continue;
      if (usesDataAccess(a.ast)) reads = true;
      walkExpr(a.ast, (n) => {
        if (n.kind === 'func' && (n.name === 'now' || n.name === 'today')) clock = true;
      });
      try {
        const c = compileChecked(a.ast, a.checked, {
          row: { propertiesSql: 'currents.attrs', geomSql: 'currents.geom', idSql: 'currents.entity' },
          paramOffset: 0,
          timeZone,
          dataAdapter: data.adapter,
        });
        // Vector tiles hold text, numbers and true/false only.
        const sql =
          c.type === 'date'
            ? `gg_expr_ts_text(${c.sql})`
            : c.type === 'list'
              ? `array_to_string(${c.sql}, ', ')`
              : c.sql;
        columns.push({ name: `expr.${e.name}`, sql: expressionSqlFragment(sql, c.params) });
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err;
      }
    }
    if (columns.length === 0) return null;
    // today() changes at midnight in the organization's time zone, so
    // the day is part of the key; now() changes every request.
    const day = clock ? new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()) : '';
    const key = createHash('sha1')
      .update(JSON.stringify([exprs, timeZone, day]))
      .digest('base64url')
      .slice(0, 16);
    return { columns, key, bypassCache: reads || exprs.some((e) => /\bnow\s*\(/i.test(e.expression)) };
  }

  /** Run a read with a statement timeout. */
  async runBounded<T>(sql: string, params: unknown[], timeout = EXPRESSION_STATEMENT_TIMEOUT): Promise<T[]> {
    if (!/^\d+s$/.test(timeout)) throw new Error('bad timeout');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${timeout}'`);
      return tx.$queryRawUnsafe<T[]>(sql, ...params);
    }, { timeout: 130_000 });
  }

  /** What the builder offers: related tables and readable layers. */
  async sources(viewer: AuthUser, item: ItemWithShares, layerId: string) {
    const layers = readExpressionLayers(item.data);
    const related = relatedLayersOf(layers, layerId).map((l) => ({
      name: l.label,
      id: l.id,
      fields: l.fields,
    }));
    const candidates = await this.prisma.item.findMany({
      where: { type: 'data_layer', deletedAt: null, orgId: item.orgId },
      include: { shares: true },
      orderBy: { title: 'asc' },
      take: 500,
    });
    const readable = candidates.filter((c: Item & { shares: ItemShare[] }) => this.sharing.canRead(viewer, c, c.shares));
    const titles = new Map<string, number>();
    for (const c of readable) titles.set(c.title.toLowerCase(), (titles.get(c.title.toLowerCase()) ?? 0) + 1);
    return {
      related,
      layers: readable.slice(0, 200).map((c) => ({
        itemId: c.id,
        title: c.title,
        // Duplicate titles must be referenced by id.
        ref: (titles.get(c.title.toLowerCase()) ?? 0) > 1 ? c.id : c.title,
        layers: readExpressionLayers(c.data).map((l) => ({
          id: l.id,
          label: l.label,
          geometryType: l.geometryType,
          fields: l.fields,
        })),
      })),
    };
  }
}

/** pg values as JSON: numbers as numbers, everything else as is. */
function normalize(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && 'toNumber' in (v as object)) {
    return (v as { toNumber(): number }).toNumber();
  }
  return v;
}
