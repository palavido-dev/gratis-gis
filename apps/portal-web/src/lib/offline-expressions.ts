// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Expression fields offline. Online, the server computes a map
 * layer's expression fields into its vector tiles. Offline the field
 * app draws cached features instead, so the same values are worked
 * out on the device with the JavaScript evaluator, reading related
 * records and other layers from the offline cache.
 *
 * The cache holds what the device has, including edits not yet sent,
 * so a count of inspections goes up as soon as one is captured. Rows
 * other people added since the download are not there until the next
 * sync; that is the trade the field app makes everywhere offline.
 */

import {
  checkExpression,
  evaluateChecked,
  EXPRESSION_FIELD_PREFIX,
  fieldRefTypeFor,
  parseExpression,
  type DataResolver,
  type DataSource,
  type ExpressionFeature,
  type FeatureField,
  type FieldRef,
  type MapLayer,
} from '@gratis-gis/shared-types';

export interface OfflineSource {
  itemId: string;
  layerKey: string;
  label: string;
  fields: FeatureField[];
  hasGeometry: boolean;
  /** For a related table: the field holding the parent feature's id. */
  parentFk?: string;
  features: GeoJSON.Feature[];
}

const refs = (fields: FeatureField[]): FieldRef[] =>
  fields.map((f) => ({ name: f.name, type: fieldRefTypeFor(f.type) }));

function toRow(f: GeoJSON.Feature, fields: FieldRef[]): ExpressionFeature {
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const id = typeof f.id === 'string' ? f.id : typeof props._global_id === 'string' ? props._global_id : undefined;
  const row: ExpressionFeature = { kind: 'feature', properties: props, geometry: f.geometry ?? null, fields };
  if (id !== undefined) row.id = id;
  return row;
}

/**
 * Add `expr.<name>` properties to every feature of `fc` for the
 * layer's expression fields. An expression that cannot be worked out
 * here (a source not cached on this device) leaves its property out,
 * as the server does for one with a mistake.
 */
export function applyOfflineExpressionFields(
  layer: MapLayer,
  fc: GeoJSON.FeatureCollection,
  own: OfflineSource,
  sources: Map<string, OfflineSource>,
  timeZone: string,
): GeoJSON.FeatureCollection {
  const exprs = (layer.expressions ?? []).filter((x) => x.expression.trim() !== '');
  if (exprs.length === 0) return fc;

  const rowsByKey = new Map<string, ExpressionFeature[]>();
  const dataSource = (s: OfflineSource): DataSource => {
    const src: DataSource = {
      key: `${s.itemId}/${s.layerKey}`,
      label: s.label,
      fields: refs(s.fields),
      hasGeometry: s.hasGeometry,
      itemId: s.itemId,
      layerId: s.layerKey,
    };
    if (s.parentFk) src.parentFk = s.parentFk;
    return src;
  };

  const compiled = exprs.flatMap((x) => {
    // Sources come from the references resolved when the map was
    // saved; an unsaved draft has none and reads nothing offline.
    const byRef = new Map<string, DataSource>();
    for (const r of x.dataRefs ?? []) {
      const s = sources.get(`${r.itemId}:${r.layerId}`);
      if (!s) continue;
      byRef.set(`${r.kind}|${r.name.toLowerCase()}|${(r.sublayer ?? '').toLowerCase()}`, dataSource(s));
      if (!rowsByKey.has(`${s.itemId}/${s.layerKey}`)) {
        const f = refs(s.fields);
        rowsByKey.set(`${s.itemId}/${s.layerKey}`, s.features.map((ft) => toRow(ft, f)));
      }
    }
    const resolver: DataResolver = {
      related: (name) => byRef.get(`related|${name.toLowerCase()}|`) ?? { error: `${name} is not on this device` },
      layer: (name, sub) =>
        byRef.get(`layer|${name.toLowerCase()}|${(sub ?? '').toLowerCase()}`) ?? { error: `${name} is not on this device` },
    };
    try {
      const ast = parseExpression(x.expression);
      const checked = checkExpression(ast, { fields: refs(own.fields), data: resolver });
      if (checked.issues.length > 0) return [];
      return [{ name: `${EXPRESSION_FIELD_PREFIX}${x.name}`, ast, checked }];
    } catch {
      return [];
    }
  });
  if (compiled.length === 0) return fc;

  const ownFields = refs(own.fields);
  const now = Date.now();
  const provider = { rows: (s: DataSource) => rowsByKey.get(s.key) ?? [] };
  return {
    ...fc,
    features: fc.features.map((f) => {
      const props: Record<string, unknown> = { ...(f.properties ?? {}) };
      for (const c of compiled) {
        try {
          const v = evaluateChecked(c.ast, c.checked, {
            feature: toRow(f, ownFields),
            data: provider,
            now,
            timeZone,
          });
          props[c.name] = toTileValue(v);
        } catch {
          // Leave the property out, like the server.
        }
      }
      return { ...f, properties: props };
    }),
  };
}

/** What a vector tile would hold: text, numbers and true/false. */
function toTileValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v !== null && 'ms' in v) {
    const d = new Date((v as { ms: number }).ms);
    const iso = d.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
  }
  if (Array.isArray(v)) return v.join(', ');
  return v;
}
