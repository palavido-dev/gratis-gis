// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data access for expressions: which related tables and layers an
 * expression may read, and the SQL that reads their current rows.
 *
 * Two access modes:
 *
 *  - viewer: the rows the person asking may see. Their share limits
 *    (own rows only, an area limit) narrow each source. Used where the
 *    result goes to that person alone: a preview, a popup, Calculate
 *    field in the attribute table.
 *  - shared: whole layers. Used where one result is served to many
 *    people, such as a derived layer. The caller must have checked
 *    that every source is readable in full, the same rule derived
 *    layer inputs follow.
 *
 * Every source an expression names is a literal, so it is resolved
 * once, up front; the checker never touches the database.
 */

import type { Item, ItemShare } from '@prisma/client';
import {
  fieldRefTypeFor,
  type DataRef,
  type DataResolver,
  type DataSource,
  type FieldRef,
  type ResolvedDataSource,
  type SqlDataAdapter,
} from '@gratis-gis/shared-types';

import { isClosedGeoLimit } from '../common/closed-geo-limit.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { dataLayerScope } from '../engine/data-layer.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { FeatureScope, SharingService } from '../items/sharing.service.js';

/** One sublayer of a v3 data layer, as expressions see it. */
export interface ExpressionLayer {
  id: string;
  label: string;
  name: string;
  geometryType: string | null;
  fields: FieldRef[];
  parentLayerId?: string;
  parentFkColumn?: string;
  editingPolicy?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readExpressionLayers(data: unknown): ExpressionLayer[] {
  const d = data as { version?: unknown; layers?: unknown } | null;
  if (!d || d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: ExpressionLayer[] = [];
  for (const raw of d.layers as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue;
    const fields: FieldRef[] = Array.isArray(raw.fields)
      ? (raw.fields as Array<Record<string, unknown>>)
          .filter((f) => f && typeof f.name === 'string' && f.name.length > 0)
          .map((f) => {
            const t = f.type;
            const type =
              t === 'number' || t === 'boolean' || t === 'date' || t === 'multi_select' ? t : 'string';
            const ref: FieldRef = { name: f.name as string, type: fieldRefTypeFor(type) };
            if (typeof f.label === 'string') ref.label = f.label;
            return ref;
          })
      : [];
    const layer: ExpressionLayer = {
      id: raw.id,
      label: typeof raw.label === 'string' ? raw.label : raw.id,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      geometryType: typeof raw.geometryType === 'string' ? raw.geometryType : null,
      fields,
    };
    if (typeof raw.parentLayerId === 'string') layer.parentLayerId = raw.parentLayerId;
    if (typeof raw.parentFkColumn === 'string') layer.parentFkColumn = raw.parentFkColumn;
    if (typeof raw.editingPolicy === 'string') layer.editingPolicy = raw.editingPolicy;
    out.push(layer);
  }
  return out;
}

/** Child tables of `layerId`, by the same rule as the field app. */
export function relatedLayersOf(layers: ExpressionLayer[], layerId: string): ExpressionLayer[] {
  const spatial = layers.filter((l) => l.geometryType !== null).length;
  return layers.filter((l) => {
    if (l.id === layerId || !l.parentFkColumn) return false;
    if (l.parentLayerId) return l.parentLayerId === layerId;
    return spatial === 1;
  });
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function matchLayer(layers: ExpressionLayer[], name: string): ExpressionLayer[] {
  return layers.filter((l) => l.id === name || same(l.name, name) || same(l.label, name));
}

function toSource(item: { id: string; title: string }, layer: ExpressionLayer, multi: boolean): DataSource {
  const src: DataSource = {
    key: `${item.id}/${layer.id}`,
    label: multi ? `${item.title} / ${layer.label}` : item.title,
    fields: layer.fields,
    hasGeometry: layer.geometryType !== null,
    itemId: item.id,
    layerId: layer.id,
  };
  if (layer.parentFkColumn) src.parentFk = layer.parentFkColumn;
  return src;
}

/** How a source is read: its scope and the viewer's limits on it. */
export interface SourceAccess {
  scope: string;
  geoLimit: unknown | null;
  ownRowsUserId: string | null;
}

export interface PreparedData {
  resolver: DataResolver;
  adapter: SqlDataAdapter;
  /** Sources resolved so far, by key. */
  sources: Map<string, DataSource>;
  /** Resolved references, for recording dependencies. */
  resolvedRefs: Array<{ ref: DataRef; itemId: string; layerId: string }>;
}

export type ItemWithShares = Item & { shares: ItemShare[] };

export interface PrepareArgs {
  prisma: PrismaService;
  sharing: SharingService;
  /** Null for an anonymous visitor to a public item. */
  viewer: AuthUser | null;
  /** The item and layer the expression is evaluated on. */
  item: { id: string; title: string; data: unknown; orgId: string };
  layerId: string;
  refs: DataRef[];
  mode: 'viewer' | 'shared';
  /** Public tier clip for anonymous reads, by item id. */
  publicGeoLimit?: (item: Item) => Promise<unknown | null>;
}

/**
 * Resolve every reference up front and return a synchronous resolver
 * plus the SQL adapter. A reference that cannot be resolved reaches
 * the checker as an error with a sentence, never an exception.
 */
export async function prepareExpressionData(args: PrepareArgs): Promise<PreparedData> {
  const { prisma, sharing, viewer } = args;
  const answers = new Map<string, ResolvedDataSource>();
  const access = new Map<string, SourceAccess>();
  const sources = new Map<string, DataSource>();
  const resolvedRefs: PreparedData['resolvedRefs'] = [];
  const keyOf = (r: DataRef) => `${r.kind}|${r.name.trim().toLowerCase()}|${(r.sublayer ?? '').trim().toLowerCase()}`;

  const accessFor = (item: ItemWithShares, layer: ExpressionLayer) => sourceAccessFor(args, item, layer);


  async function settle(ref: DataRef, item: ItemWithShares, layer: ExpressionLayer, multi: boolean) {
    const a = await accessFor(item, layer);
    if (typeof a === 'string') {
      answers.set(keyOf(ref), { error: `${item.title} is ${a}` });
      return;
    }
    const src = toSource(item, layer, multi);
    access.set(src.key, a);
    sources.set(src.key, src);
    answers.set(keyOf(ref), src);
    resolvedRefs.push({ ref, itemId: item.id, layerId: layer.id });
  }

  const here = readExpressionLayers(args.item.data);
  const hereItem = await prisma.item.findUnique({
    where: { id: args.item.id },
    include: { shares: true },
  });

  for (const ref of args.refs) {
    if (answers.has(keyOf(ref))) continue;
    if (ref.kind === 'related') {
      const children = relatedLayersOf(here, args.layerId);
      const hits = matchLayer(children, ref.name);
      if (hits.length !== 1 || !hereItem) {
        const names = children.map((c) => `'${c.label}'`).join(', ');
        answers.set(keyOf(ref), {
          error: hits.length > 1
            ? `More than one related table is called ${ref.name}`
            : children.length > 0
              ? `This layer has no related table called ${ref.name}; it has ${names}`
              : 'This layer has no related tables',
        });
        continue;
      }
      await settle(ref, hereItem, hits[0]!, true);
      continue;
    }
    // layer(name, sublayer?)
    const candidates: ItemWithShares[] = UUID_RE.test(ref.name)
      ? await prisma.item.findMany({
          where: { id: ref.name, type: 'data_layer', deletedAt: null },
          include: { shares: true },
        })
      : await prisma.item.findMany({
          where: {
            type: 'data_layer',
            deletedAt: null,
            orgId: args.item.orgId,
            title: { equals: ref.name.trim(), mode: 'insensitive' },
          },
          include: { shares: true },
          take: 20,
        });
    const visible = candidates.filter((c) =>
      viewer === null ? c.access === 'public' : sharing.canRead(viewer, c, c.shares),
    );
    if (visible.length === 0) {
      answers.set(keyOf(ref), { error: `No layer called ${ref.name} is shared with you` });
      continue;
    }
    if (visible.length > 1) {
      answers.set(keyOf(ref), {
        error: `More than one layer is called ${ref.name}; use its id instead, such as layer('${visible[0]!.id}')`,
      });
      continue;
    }
    const target = visible[0]!;
    const layers = readExpressionLayers(target.data);
    let layer: ExpressionLayer | undefined;
    if (ref.sublayer) {
      const hits = matchLayer(layers, ref.sublayer);
      if (hits.length !== 1) {
        answers.set(keyOf(ref), {
          error: `${target.title} has no layer called ${ref.sublayer}; it has ${layers.map((l) => `'${l.label}'`).join(', ')}`,
        });
        continue;
      }
      layer = hits[0];
    } else if (layers.length === 1) {
      layer = layers[0];
    } else {
      answers.set(keyOf(ref), {
        error: layers.length === 0
          ? `${target.title} has no layers yet`
          : `${target.title} has several layers; name one, such as layer('${ref.name}', '${layers[0]!.label}')`,
      });
      continue;
    }
    await settle(ref, target, layer!, layers.length > 1);
  }

  const resolver: DataResolver = {
    related: (name) =>
      answers.get(keyOf({ kind: 'related', name })) ?? { error: `Related table ${name} was not prepared` },
    layer: (name, sublayer) => {
      const ref: DataRef = { kind: 'layer', name };
      if (sublayer !== undefined) ref.sublayer = sublayer;
      return answers.get(keyOf(ref)) ?? { error: `Layer ${name} was not prepared` };
    },
  };

  return { resolver, adapter: observationAdapter(access), sources, resolvedRefs };
}

/**
 * How the viewer may read one layer, or a sentence saying why not.
 * In shared mode a limited share is refused rather than narrowed.
 */
export async function sourceAccessFor(
  args: Pick<PrepareArgs, 'sharing' | 'viewer' | 'mode' | 'publicGeoLimit'>,
  item: ItemWithShares,
  layer: ExpressionLayer,
): Promise<SourceAccess | string> {
  const { sharing, viewer } = args;
  const scope = dataLayerScope(item.id, layer.id);
  if (viewer === null) {
    if (item.access !== 'public') return 'not shared publicly';
    const clip = args.publicGeoLimit ? await args.publicGeoLimit(item) : null;
    if (args.mode === 'shared' && clip) return 'limited to an area for the public';
    return { scope, geoLimit: clip, ownRowsUserId: null };
  }
  if (!sharing.canRead(viewer, item, item.shares)) return 'not shared with you';
  const fs: FeatureScope = await sharing.featureScopeFor(viewer, item, item.shares, {
    action: 'read',
    layerPolicy: layer.editingPolicy === 'own-rows-only' ? 'own-rows-only' : 'all-rows',
  });
  const limited = fs.geoLimit !== null || fs.rowScope === 'own';
  if (args.mode === 'shared' && limited) {
    return 'shared with you with a row or area limit, which a shared result cannot honour';
  }
  return {
    scope,
    geoLimit: fs.geoLimit,
    ownRowsUserId: fs.rowScope === 'own' ? fs.userId : null,
  };
}

/**
 * Current rows of a source from the observation log, with the
 * viewer's limits. Candidates come from any version matching the
 * conditions (where the attrs GIN and geometry indexes help); the
 * latest version is then re-checked, so an old version can never
 * resurrect a row, the same two-stage read the engine uses.
 */
export function observationAdapter(access: Map<string, SourceAccess>): SqlDataAdapter {
  return {
    rowsSql(source, opts, bind) {
      const a = access.get(source.key);
      if (!a) throw new Error(`Expression source ${source.key} was not authorized`);
      const scope = bind(a.scope, 'text');
      const cond = opts.conditions.map((c) => `(${c})`).join(' AND ');
      const candidate = cond
        ? ` AND entity IN (SELECT entity FROM observation WHERE scope = ${scope} AND valid_from <= now() AND ${cond})`
        : '';
      const knn = opts.knn
        ? ` AND entity IN (SELECT entity FROM observation WHERE scope = ${scope} AND geom IS NOT NULL AND valid_from <= now() ORDER BY geom <-> (${opts.knn.geomSql}) LIMIT ${Math.max(1, Math.floor(opts.knn.limit))})`
        : '';
      const limits: string[] = [];
      if (a.geoLimit !== null) {
        limits.push(
          isClosedGeoLimit(a.geoLimit)
            ? 'FALSE'
            : `(geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${bind(JSON.stringify(a.geoLimit), 'text')}), 4326)))`,
        );
      }
      if (a.ownRowsUserId !== null) {
        limits.push(`(SELECT c.author_sub FROM observation c
          WHERE c.scope = ${scope} AND c.entity = latest.entity AND c.kind = 'create'
          ORDER BY c.valid_from DESC, c.tx_time DESC, c.id DESC LIMIT 1) = ${bind(a.ownRowsUserId, 'text')}`);
      }
      const recheck = [cond, ...limits].filter(Boolean).map((c) => ` AND ${c}`).join('');
      return `SELECT latest.entity AS global_id, latest.geom AS geom, latest.attrs AS properties
        FROM (
          SELECT DISTINCT ON (entity) entity, geom, attrs, kind
          FROM observation
          WHERE scope = ${scope} AND valid_from <= now()${candidate}${knn}
          ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
        ) latest
        WHERE latest.kind <> 'delete'${recheck}`;
    },
  };
}

/** A resolved reference as stored on a saved recipe. */
export interface StoredRef extends DataRef {
  itemId: string;
  layerId: string;
}

/**
 * Rebuild a resolver from references resolved when a recipe was
 * saved. Reads whole layers: the caller has already checked that the
 * reader may read every referenced item in full. Fields come from the
 * items as they are now, so a renamed field shows up as a checker
 * error rather than silently reading nothing.
 */
export async function storedExpressionData(
  prisma: PrismaService,
  refs: StoredRef[],
): Promise<{ resolver: DataResolver; adapter: SqlDataAdapter }> {
  const ids = [...new Set(refs.map((r) => r.itemId))];
  const items = ids.length
    ? await prisma.item.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, title: true, data: true },
      })
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const access = new Map<string, SourceAccess>();
  const answers = new Map<string, ResolvedDataSource>();
  const keyOf = (r: DataRef) =>
    `${r.kind}|${r.name.trim().toLowerCase()}|${(r.sublayer ?? '').trim().toLowerCase()}`;
  for (const ref of refs) {
    const item = byId.get(ref.itemId);
    const layers = item ? readExpressionLayers(item.data) : [];
    const layer = layers.find((l) => l.id === ref.layerId);
    if (!item || !layer) {
      answers.set(keyOf(ref), { error: `${ref.name} no longer exists` });
      continue;
    }
    const src = toSource(item, layer, layers.length > 1);
    access.set(src.key, { scope: dataLayerScope(item.id, layer.id), geoLimit: null, ownRowsUserId: null });
    answers.set(keyOf(ref), src);
  }
  return {
    resolver: {
      related: (name) => answers.get(keyOf({ kind: 'related', name })) ?? { error: `Related table ${name} is not part of this recipe` },
      layer: (name, sublayer) => {
        const ref: DataRef = { kind: 'layer', name };
        if (sublayer !== undefined) ref.sublayer = sublayer;
        return answers.get(keyOf(ref)) ?? { error: `Layer ${name} is not part of this recipe` };
      },
    },
    adapter: observationAdapter(access),
  };
}
